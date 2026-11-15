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
  if (config.database !== ':memory:') mkdirSync(dirname(resolve(config.database)), { recursive: true });
  const db = options.db || openDatabase(config.database);
  const domain = new Domain(db);
  db.exec(`CREATE TABLE IF NOT EXISTS request_keys (
    user_id INTEGER NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL, response TEXT NOT NULL,
    created_at INTEGER NOT NULL, PRIMARY KEY(user_id,request_key));`);
  if (!db.prepare('SELECT id FROM users LIMIT 1').get()) {
    if (!config.adminPassword) throw new Error('При первом запуске задайте ADMIN_PASSWORD (не менее 12 символов) в .env.');
    db.prepare(`INSERT INTO users(name,login,password_hash,roles,tag_ids,available,active,created_at)
      VALUES(?,?,?,?,?,1,1,?)`).run('Администратор', config.adminLogin, hashPassword(config.adminPassword), JSON.stringify(['admin','organizer']), '[]', new Date().toISOString());
  }
  if (config.token && !config.username) throw new Error('Для подключения Telegram задайте TELEGRAM_BOT_USERNAME.');
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
    if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new AppError(415, 'Отправьте данные в формате JSON.');
    let length = 0; const chunks = [];
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 65536) throw new AppError(413, 'Слишком большой запрос.');
      chunks.push(chunk);
    }
    try { const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error();
      return body;
    } catch { throw new AppError(400, 'Некорректный JSON.'); }
  };
  const headers = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };
  const server = http.createServer(async (req, res) => {
    for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      if (req.method === 'GET' && path === '/health') return json(res, 200, { ok: !!db.prepare('SELECT 1').get(), telegramConfigured: !!config.token });
      if (req.method === 'GET' && !path.startsWith('/api/')) {
        const files = { '/': ['index.html','text/html'], '/index.html': ['index.html','text/html'], '/app.js': ['app.js','text/javascript'], '/style.css': ['style.css','text/css'] };
        if (!files[path]) return json(res, 404, { error: 'Страница не найдена.' });
        const [file, type] = files[path];
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' });
        return res.end(await readFile(resolve(base, 'public', file)));
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
        db.prepare('INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(?,?,?,?)').run(hashToken(token), actor.id, csrf, Date.now()+43200000);
        return json(res, 200, { user: actor, csrf }, { 'Set-Cookie': cookie(token) });
      }
      const session = getSession(req);
      const actor = session && domain.user(session.user_id);
      if (!webUser(actor)) throw new AppError(401, 'Войдите в приложение.');
      if (req.method === 'POST' && req.headers['x-csrf-token'] !== session.csrf) throw new AppError(403, 'Обновите страницу: проверка безопасности не пройдена.');
      if (req.method === 'POST' && path === '/api/logout') {
        db.prepare('DELETE FROM sessions WHERE token_hash=?').run(session.token_hash);
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
      const cacheRequest = key && !/^\/api\/volunteers\/\d+\/link$/.test(path);
      const result = transact(db, () => {
        if (cacheRequest) {
          const previous = db.prepare('SELECT * FROM request_keys WHERE user_id=? AND request_key=?').get(actor.id,key);
          if (previous) {
            if (previous.fingerprint !== fingerprint) throw new AppError(409,'Ключ запроса уже использован для другого действия.');
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
          const passwordHash = body.password ? hashPassword(body.password) : null;
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
      if (!known) console.error('Ошибка обработки запроса:', error.code || error.name);
      if (!res.headersSent) json(res,known ? error.status : 500,{error:known ? error.message : 'Не удалось выполнить действие. Повторите попытку.'});
      else res.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  let timer;
  return {server,db,domain,bot,config,
    async start() {
      await new Promise((resolve,reject)=> {server.once('error',reject);server.listen(config.port,config.host,resolve);});
      if (config.token) bot.start().catch(()=>console.error('Telegram временно недоступен. Проверьте настройки и сеть.'));
      timer = setInterval(()=> { db.prepare('DELETE FROM request_keys WHERE created_at<?').run(Date.now()-7*86400000); },3600000);
      timer.unref();
      return server.address();
    },
    async close() {clearInterval(timer);await bot.stop();await new Promise(resolve=>server.close(resolve));db.close();}
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const app = createApplication();
    const address = await app.start();
    console.log(`Координация мероприятия: http://${app.config.host}:${address.port}`);
    console.log(app.config.token ? 'Telegram: подключение настроено.' : 'Telegram: задайте TELEGRAM_BOT_TOKEN и TELEGRAM_BOT_USERNAME для работы бота.');
    for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>{app.close().then(()=>process.exit(0));});
  } catch (error) {console.error(error.message);process.exitCode=1;}
}
