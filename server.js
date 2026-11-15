import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { openDatabase } from './lib/db.js';
import { Domain, AppError } from './lib/domain.js';
import { TelegramBot } from './lib/telegram.js';

const base = dirname(fileURLToPath(import.meta.url));
export const hashToken = token => createHash('sha256').update(token).digest('hex');
export function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new AppError(400, 'Пароль должен содержать от 12 до 256 символов.');
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || password.length > 256 || !stored) return false;
  const [salt, value] = stored.split(':');
  if (!salt || !/^[a-f0-9]{128}$/.test(value || '')) return false;
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(value, 'hex'));
}
const webUser = u => u && u.active && u.roles.some(r => ['admin', 'organizer', 'manager'].includes(r));
const idOf = value => {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new AppError(400, 'Некорректный идентификатор.');
  return id;
};
function transact(db, fn) {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try { const value = fn(); db.exec('COMMIT'); return value; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function createApplication(options = {}) {
  const config = { host: process.env.HOST || '127.0.0.1', port: Number(process.env.PORT || 4319),
    database: process.env.DATABASE_PATH || resolve(base, 'data/app.sqlite'),
    adminLogin: process.env.ADMIN_LOGIN || 'admin', adminPassword: process.env.ADMIN_PASSWORD,
    token: process.env.TELEGRAM_BOT_TOKEN || '', username: process.env.TELEGRAM_BOT_USERNAME || '',
    secureCookies: process.env.SECURE_COOKIES === '1', publicOrigin: process.env.PUBLIC_ORIGIN || '', ...options };
  if (typeof config.adminLogin!=='string'||!config.adminLogin.trim()||config.adminLogin.trim().length>100) throw new Error('ADMIN_LOGIN должен содержать от 1 до 100 символов.');
  config.adminLogin=config.adminLogin.trim();
  if (!Number.isInteger(config.port)||config.port<0||config.port>65535) throw new Error('PORT должен быть целым числом от 0 до 65535.');
  if (typeof config.host!=='string'||!config.host||config.host.length>253||!/^[a-zA-Z0-9_.:%-]+$/.test(config.host)) throw new Error('HOST должен содержать корректный адрес или имя сервера.');
  if (typeof config.token!=='string'||typeof config.username!=='string') throw new Error('Настройки Telegram должны быть строками.');
  config.token=config.token.trim();config.username=config.username.trim().replace(/^@/,'');
  if (config.username&&!/^[a-zA-Z0-9_]+$/.test(config.username)) throw new Error('TELEGRAM_BOT_USERNAME должен содержать имя бота без ссылки.');
  if (config.token && !config.username) throw new Error('Для подключения Telegram задайте TELEGRAM_BOT_USERNAME.');
  if (config.publicOrigin) {
    try {
      const origin=new URL(config.publicOrigin);
      if (!['http:','https:'].includes(origin.protocol)||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash) throw new Error();
      config.publicOrigin=origin.origin;
    } catch {throw new Error('PUBLIC_ORIGIN должен содержать только HTTP(S)-адрес сервиса без пути и учётных данных.');}
  }

  if (config.database !== ':memory:') mkdirSync(dirname(resolve(config.database)), { recursive: true });
  const db = options.db || openDatabase(config.database);
  const domain = new Domain(db);
  db.exec(`CREATE TABLE IF NOT EXISTS request_keys (
    user_id INTEGER NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL, response TEXT NOT NULL,
    created_at INTEGER NOT NULL, PRIMARY KEY(user_id,request_key));`);
  try {
    // Older cache rows could encode a fast hash of a password-bearing body.
    // Discard those response shapes once; retain task/question replay history.
    if (!db.prepare("SELECT value FROM meta WHERE key='request_cache_private_v2'").get()) transact(db,()=>{
      db.prepare(`DELETE FROM request_keys WHERE response='{"ok":true}' OR
        CASE WHEN json_valid(response) THEN json_type(response,'$.roles')='array' ELSE 0 END`).run();
      db.prepare("INSERT INTO meta(key,value) VALUES('request_cache_private_v2','done')").run();
    });
    if (!db.prepare('SELECT id FROM users LIMIT 1').get()) {
      if (!config.adminPassword) throw new Error('При первом запуске задайте ADMIN_PASSWORD (не менее 12 символов) в .env.');
      transact(db,()=>{
        const userId=Number(db.prepare(`INSERT INTO users(name,login,password_hash,roles,tag_ids,available,active,created_at)
          VALUES(?,?,?,?,?,1,1,?)`).run('Администратор',config.adminLogin,hashPassword(config.adminPassword),JSON.stringify(['admin','organizer']),'[]',new Date().toISOString()).lastInsertRowid);
        domain.logActivity(userId,'Создан администратор при первом запуске');
      });
    }
  } catch (error) {if (!options.db) db.close();throw error;}
  const bot = options.bot || new TelegramBot({ db, domain, token: config.token, username: config.username });
  const cookie = (token, clear = false) => `coord_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 43200}${config.secureCookies ? '; Secure' : ''}`;
  const json = (res, status, data, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(data));
  };
  const getSession = req => {
    const match = /(?:^|;\s*)coord_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '');
    if (!match) return null;
    return db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?').get(hashToken(match[1]), Date.now());
  };
  const readBody = async req => {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new AppError(415, 'Отправьте данные в формате JSON.');
    let length = 0; const chunks = [];
    for await (const chunk of req.iterator({destroyOnReturn:false})) {
      length += chunk.length;
      if (length > 65536) throw new AppError(413, 'Слишком большой запрос.');
      chunks.push(chunk);
    }
    try { const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error();
      return body;
    } catch { throw new AppError(400, 'Некорректный JSON.'); }
  };
  // Replaying a completed request must not bypass permissions that changed
  // after its first execution. The original mutation is never executed twice.
  function authorizeReplay(actor,path,taskRoute,body) {
    actor=domain.organizer(actor);
    if (path.startsWith('/api/admin/')) {domain.administrator(actor);return;}
    if (taskRoute) {
      const task=domain.rawTask(idOf(taskRoute[1])),action=taskRoute[2];
      if (action==='assign') {domain.poolManager(actor);domain.workTask(actor,task);domain.previewAssignment(actor,body);}
      else if (action==='complete') {
        domain.organizer(actor);domain.workTask(actor,task);
        if(task.claimed_by!==actor.id)throw new AppError(403,'Завершить задачу через веб может её самостоятельный исполнитель.');
      } else if (action==='questions') {
        domain.organizer(actor);domain.readTask(actor,task);
        if(!actor.roles.includes('admin')&&![task.author_id,task.claimed_by,task.assigned_by].includes(actor.id))throw new AppError(403,'Вопрос создаёт автор или участник задачи.');
      } else {
        domain.organizer(actor);domain.workTask(actor,task);
        if(['reset','cancel'].includes(action)&&!actor.roles.includes('admin')&&![task.author_id,task.claimed_by,task.assigned_by].includes(actor.id))throw new AppError(403,'Изменить задачу может автор, участник или администратор.');
      }
      return;
    }
    if (path==='/api/volunteers/preview') {domain.previewAssignment(actor,body);return;}
    if (/^\/api\/volunteers\/\d+\/tags$/.test(path)) {
      domain.poolManager(actor);
      if(domain.user(idOf(path.split('/')[3])).managerId!==actor.id)throw new AppError(403,'Личные теги доступны только внутри своего пула.');
      return;
    }
    if (/^\/api\/questions\/\d+\/(reply|forward|close)$/.test(path)) {
      const q=domain.rawQuestion(idOf(path.split('/')[3])),action=path.split('/')[4];
      if(!domain.canReadQuestion(actor,q))throw new AppError(403,'Обсуждение недоступно.');
      if(action==='close'&&!domain.canCloseQuestion(actor,q))throw new AppError(403,'Подтвердить решение может задавший вопрос организатор или передавший его менеджер.');
      if(action==='close'&&body.sendToVolunteers){
        const task=domain.rawTask(q.task_id);
        if(task.assigned_by!==actor.id||!actor.roles.some(role=>['manager','admin'].includes(role)))throw new AppError(403,'Передать итог группе может менеджер, назначивший волонтёров на задачу.');
      }
      if(action==='forward'&&(q.source!=='volunteer'||q.controller_id!==actor.id))throw new AppError(403,'Передать вопрос может менеджер, получивший его от волонтёра.');
      return;
    }
    if (/^\/api\/deliveries\/\d+\/retry$/.test(path)) {
      domain.poolManager(actor);
      const job=db.prepare('SELECT * FROM outbox WHERE id=?').get(idOf(path.split('/')[3]));
      if(!job)throw new AppError(404,'Отправка не найдена.');
      if(!actor.roles.includes('admin')&&(!job.user_id||domain.user(job.user_id).managerId!==actor.id))throw new AppError(403,'Отправка чужому пулу недоступна.');
    }
  }
  const headers = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };
  const server = http.createServer(async (req, res) => {
    for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
    try {
      let url;
      try {url = new URL(req.url, 'http://localhost');}
      catch {throw new AppError(400,'Некорректный адрес запроса.');}
      const path = url.pathname;
      if (req.method === 'GET' && path === '/health') return json(res, 200, { ok: !!db.prepare('SELECT 1').get(), telegramConfigured: !!config.token });
      if (req.method === 'GET' && !path.startsWith('/api/')) {
        const files = { '/': ['index.html','text/html'], '/index.html': ['index.html','text/html'], '/app.js': ['app.js','text/javascript'], '/style.css': ['style.css','text/css'] };
        if (!files[path]) return json(res, 404, { error: 'Страница не найдена.' });
        const [file, type] = files[path];
        const bytes = await readFile(resolve(base, 'public', file));
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' });
        return res.end(bytes);
      }
      if (!['GET','POST'].includes(req.method)) return json(res, 405, { error: 'Метод не поддерживается.' }, { Allow: 'GET, POST' });
      if (req.method === 'POST' && req.headers.origin) {
        const expected = config.publicOrigin || `http://${req.headers.host}`;
        if (req.headers.origin !== expected) throw new AppError(403, 'Источник запроса не разрешён.');
      }
      const body = req.method === 'POST' ? await readBody(req) : {};
      if (req.method === 'POST' && path === '/api/login') {
        const login = typeof body.login === 'string' ? body.login.trim().slice(0,100) : '';
        const rateKey = hashToken(`${req.socket.remoteAddress}:${login}`);
        const attempt = db.prepare('SELECT * FROM login_attempts WHERE key=?').get(rateKey);
        if (attempt && attempt.reset_at > Date.now() && attempt.count >= 5) throw new AppError(429, 'Слишком много попыток. Повторите через 15 минут.');
        const row = db.prepare('SELECT * FROM users WHERE login=?').get(login);
        const valid = verifyPassword(body.password, row?.password_hash || '00000000000000000000000000000000:' + '0'.repeat(128));
        const actor = row && domain.user(row.id);
        if (!valid || !webUser(actor)) {
          db.prepare(`INSERT INTO login_attempts(key,count,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET
            count=CASE WHEN reset_at<? THEN 1 ELSE count+1 END, reset_at=CASE WHEN reset_at<? THEN excluded.reset_at ELSE reset_at END`).run(rateKey,Date.now()+900000,Date.now(),Date.now());
          throw new AppError(401, 'Неверный логин или пароль.');
        }
        db.prepare('DELETE FROM login_attempts WHERE key=?').run(rateKey);
        db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
        const token = randomBytes(32).toString('hex'); const csrf = randomBytes(24).toString('hex');
        transact(db,()=>{
          db.prepare('INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(?,?,?,?)').run(hashToken(token),actor.id,csrf,Date.now()+43200000);
          domain.logActivity(actor.id,'Вход в приложение');
        });
        return json(res, 200, { user: actor, csrf }, { 'Set-Cookie': cookie(token) });
      }
      const session = getSession(req);
      const actor = session && domain.user(session.user_id);
      if (!webUser(actor)) throw new AppError(401, 'Войдите в приложение.');
      if (req.method === 'POST' && req.headers['x-csrf-token'] !== session.csrf) throw new AppError(403, 'Обновите страницу: проверка безопасности не пройдена.');
      if (req.method === 'POST' && path === '/api/logout') {
        transact(db,()=>{db.prepare('DELETE FROM sessions WHERE token_hash=?').run(session.token_hash);domain.logActivity(actor.id,'Выход из приложения');});
        return json(res,200,{ok:true},{'Set-Cookie':cookie('',true)});
      }
      if (req.method === 'GET' && path === '/api/bootstrap') return json(res,200,{...domain.bootstrap(actor),csrf:session.csrf,telegram:bot.status()});
      if (req.method === 'GET' && path === '/api/tasks') return json(res,200,{tasks:domain.listTasks(actor,Object.fromEntries(url.searchParams))});
      const taskRoute = /^\/api\/tasks\/(\d+)(?:\/(claim|assign|complete|cancel|reset|questions))?$/.exec(path);
      if (req.method === 'GET' && taskRoute && !taskRoute[2]) return json(res,200,domain.task(actor,idOf(taskRoute[1])));
      if (req.method === 'GET' && path === '/api/volunteers') return json(res,200,{volunteers:domain.listVolunteers(actor)});
      if (req.method === 'GET' && path === '/api/questions') return json(res,200,{questions:domain.listQuestions(actor,Object.fromEntries(url.searchParams))});
      if (req.method === 'GET' && path === '/api/deliveries') {
        if (!actor.roles.some(r=>['admin','manager'].includes(r))) throw new AppError(403,'Доставка доступна менеджеру.');
        const rows = db.prepare(`SELECT o.*,u.name AS user_name FROM outbox o JOIN users u ON u.id=o.user_id
          WHERE (o.status!='sent') AND (?=1 OR u.manager_id=?) ORDER BY o.id DESC LIMIT 200`).all(actor.roles.includes('admin')?1:0,actor.id);
        return json(res,200,{deliveries:rows.map(r=>({id:r.id,userId:r.user_id,userName:r.user_name,taskId:r.task_id,kind:r.kind,status:r.status,attempts:r.attempts,error:r.last_error,createdAt:r.created_at}))});
      }
      if (req.method !== 'POST') throw new AppError(404,'Запрос не найден.');
      const key = req.headers['idempotency-key'];
      if (key && (typeof key !== 'string' || key.length > 100 || !/^[a-zA-Z0-9_-]+$/.test(key))) throw new AppError(400,'Некорректный ключ запроса.');
      const fingerprint = hashToken(`${path}:${JSON.stringify(body)}`);
      const credentials=path==='/api/change-password'||(path==='/api/admin/users'&&body.password!==undefined&&body.password!=='');
      const cacheRequest = key && path!=='/api/volunteers/preview' && !credentials && !/^\/api\/volunteers\/\d+\/link$/.test(path);
      const result = transact(db, () => {
        if (cacheRequest) {
          const previous = db.prepare('SELECT * FROM request_keys WHERE user_id=? AND request_key=?').get(actor.id,key);
          if (previous) {
            if (previous.fingerprint !== fingerprint) throw new AppError(409,'Ключ запроса уже использован для другого действия.');
            authorizeReplay(actor,path,taskRoute,body);
            return JSON.parse(previous.response);
          }
        }
        let result;
        if (path === '/api/tasks') result = {tasks:domain.createTask(actor,body)};
        else if (taskRoute) {
          const id = idOf(taskRoute[1]);
          switch (taskRoute[2]) {
            case 'claim': result = domain.claimTask(actor,id); break;
            case 'assign': result = domain.assignTask(actor,id,body); break;
            case 'complete': result = domain.completeTask(actor,id); break;
            case 'cancel': result = domain.cancelTask(actor,id,body.reason); break;
            case 'reset': result = domain.resetTask(actor,id,body.reason); break;
            case 'questions': result = domain.createQuestion(actor,id,body); break;
            default: throw new AppError(404,'Действие не найдено.');
          }
        } else if (path === '/api/volunteers/preview') result = {volunteers:domain.previewAssignment(actor,body)};
        else if (/^\/api\/volunteers\/\d+\/tags$/.test(path)) result = domain.setPersonalTags(actor,idOf(path.split('/')[3]),body);
        else if (/^\/api\/volunteers\/\d+\/link$/.test(path)) result = bot.createLink(actor,idOf(path.split('/')[3]));
        else if (/^\/api\/questions\/\d+\/(reply|forward|close)$/.test(path)) {
          const [, , , id, action] = path.split('/');
          result = action === 'reply' ? domain.replyQuestion(actor,idOf(id),body) : action === 'forward' ? domain.forwardQuestion(actor,idOf(id),body) : domain.closeQuestion(actor,idOf(id),body);
        } else if (path === '/api/admin/settings') result = domain.adminSettings(actor,body);
        else if (path === '/api/admin/tags') result = domain.adminSaveTag(actor,body);
        else if (path === '/api/admin/users') {
          if (!actor.roles.includes('admin')) throw new AppError(403,'Нужны права администратора.');
          if (body.roles!==undefined && (!Array.isArray(body.roles)||!body.roles.length)) throw new AppError(400,'Выберите корректные роли.');
          if (body.id!==undefined) idOf(body.id);
          const passwordHash = body.password===undefined||body.password==='' ? null : hashPassword(body.password);
          const existing = body.id && domain.user(idOf(body.id));
          if (!db.prepare('SELECT password_hash FROM users WHERE id=?').get(existing?.id || 0)?.password_hash && (body.roles || existing?.roles)?.some(r=>['admin','organizer','manager'].includes(r)) && !passwordHash) throw new AppError(400,'Для нового пользователя веб-приложения задайте пароль от 12 символов.');
          result = domain.adminSaveUser(actor,body);
          if (passwordHash) {
            db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(passwordHash,result.id);
            db.prepare('DELETE FROM sessions WHERE user_id=?').run(result.id);
          }
          if (body.id && existing) db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash!=?').run(existing.id,session.token_hash);
        } else if (path === '/api/change-password') {
          const row = db.prepare('SELECT password_hash FROM users WHERE id=?').get(actor.id);
          if (!verifyPassword(body.currentPassword,row.password_hash)) throw new AppError(403,'Текущий пароль не подходит.');
          db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(body.password),actor.id);
          db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash!=?').run(actor.id,session.token_hash);
          domain.logActivity(actor.id,'Пароль изменён');
          result = {ok:true};
        } else if (/^\/api\/deliveries\/\d+\/retry$/.test(path)) result = domain.retryDelivery(actor,idOf(path.split('/')[3]));
        else throw new AppError(404,'Действие не найдено.');
        result ??= {ok:true};
        if (cacheRequest) db.prepare('INSERT INTO request_keys(user_id,request_key,fingerprint,response,created_at) VALUES(?,?,?,?,?)').run(actor.id,key,fingerprint,JSON.stringify(result),Date.now());
        return result;
      });
      json(res,200,result);
    } catch (error) {
      const known = error instanceof AppError || (Number.isInteger(error.status) && error.status>=400 && error.status<=599);
      if (req.aborted || res.destroyed) return;
      if (!known) console.error('Ошибка обработки запроса:', error.code || error.name);
      if (!res.headersSent) json(res,known ? error.status : 500,{error:known ? error.message : 'Не удалось выполнить действие. Повторите попытку.'},error.status===413?{Connection:'close'}:{});
      else res.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  let timer,closing;
  return {server,db,domain,bot,config,
    async start() {
      await new Promise((resolve,reject)=> {server.once('error',reject);server.listen(config.port,config.host,resolve);});
      if (config.token) bot.start().catch(()=>console.error('Telegram временно недоступен. Проверьте настройки и сеть.'));
      timer = setInterval(()=> {
        const now=Date.now();
        db.prepare('DELETE FROM request_keys WHERE created_at<?').run(now-7*86400000);
        db.prepare('DELETE FROM sessions WHERE expires_at<?').run(now);
        db.prepare('DELETE FROM login_attempts WHERE reset_at<?').run(now);
      },3600000);
      timer.unref();
      return server.address();
    },
    close() {
      if (!closing) closing=(async()=>{
        clearInterval(timer);
        await new Promise(resolve=>server.close(resolve));
        try {await bot.stop();} finally {db.close();}
      })();
      return closing;
    }
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let app;
  try {
    app = createApplication();
    const address = await app.start();
    console.log(`Координация мероприятия: http://${app.config.host}:${address.port}`);
    console.log(app.config.token ? 'Telegram: подключение настроено.' : 'Telegram: задайте TELEGRAM_BOT_TOKEN и TELEGRAM_BOT_USERNAME для работы бота.');
    for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>{app.close().then(()=>process.exit(0)).catch(()=>{console.error('Не удалось корректно остановить приложение.');process.exit(1);});});
  } catch (error) {if(app)await app.close();console.error(error.message);process.exitCode=1;}
}
