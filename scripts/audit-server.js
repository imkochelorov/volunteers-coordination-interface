// Disposable browser fixture. Never reads .env or opens the live application DB.
import { createAuditHarness } from './stress-audit.js';
import { hashPassword, hashToken } from '../server.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
const password='isolated-audit-password-2026';
const taskStates={queued:'В очереди',in_progress:'В процессе',done:'Выполнена',cancelled:'Отменена'};
const directory=mkdtempSync(join(tmpdir(),'nerc-browser-audit-'));
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
let fixture;
try {
  fixture=await createAuditHarness({mode:process.argv.includes('--seed-check')?'handler':'tcp',database:join(directory,'fixture.sqlite'),port:4338,organizers:2,poolSize:200});
  const f=fixture,d=f.app.domain;
  f.managers[1]=d.adminSaveUser(f.admin,{id:f.managers[1].id,homeHallId:f.hall2,tagIds:[f.hall2,f.tc]});
  const organizer=d.adminSaveUser(f.admin,{name:'Тестовый организатор',login:'audit-organizer',roles:['organizer'],tagIds:[f.tc]});
  f.app.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(password),organizer.id);
  const manager=f.managers[0],pool=f.volunteers.filter(v=>v.managerId===manager.id);
  const create=(title,hallId=f.hall1)=>d.createTask(manager,{title,description:'Изолированный стенд аудита. Синтетические данные.',hallIds:hallId?[hallId]:[],tagIds:[]})[0];
  const free=create('Свободная задача первого холла');
  const foreign=create('Свободная задача второго холла',f.hall2);
  const waiting=create('Групповая задача ждёт принятия');d.assignTask(manager,waiting.id,{volunteerIds:pool.slice(0,2).map(v=>v.id)});
  const progress=create('Самостоятельная задача в процессе');d.claimTask(manager,progress.id);
  const blocked=create('Задача с двумя блокирующими вопросами');d.assignTask(manager,blocked.id,{volunteerIds:[pool[2].id]});d.acceptTask(pool[2],blocked.id,blocked.generation);
  const first=d.createQuestion(manager,blocked.id,{body:'Нужен доступ к комнате.',tagIds:[f.hall2,f.tc],blocking:true,urgency:'urgent'});
  d.replyQuestion(f.managers[1],first.id,{body:'Ключи переданы. Подтвердите решение.'});
  d.createQuestion(manager,blocked.id,{body:'Нет тележки для оборудования.',tagIds:[f.tc],blocking:true});
  d.createQuestion(pool[0],waiting.id,{body:'Где забрать коробки?'},waiting.generation);
  d.createQuestion(manager,progress.id,{body:'Вопрос в общей очереди без тегов',tagIds:[],blocking:false});
  const done=create('Выполненная задача');d.assignTask(manager,done.id,{volunteerIds:[pool[3].id]});d.acceptTask(pool[3],done.id,done.generation);d.completeTask(pool[3],done.id,done.generation);
  const cancelled=create('Отменённая задача');d.cancelTask(manager,cancelled.id,'Проверка отмены на изолированном стенде.');
  create('Общая задача без холла',null);
  d.setPersonalTags(manager,pool[0].id,{names:['Раннеры','Склад']});d.setPersonalTags(manager,pool[1].id,{names:['Раннеры']});d.setAvailability(pool[4],false);
  await f.drain();
  if(process.argv.includes('--seed-check')){console.log(JSON.stringify({fixture:'NERC_ISOLATED_AUDIT',mode:'fixture seed only; no TCP',tasks:d.listTasks(f.admin).map(t=>({id:t.id,status:t.status,blocked:t.blocked})),questions:f.app.db.prepare('SELECT COUNT(*) AS n FROM questions').get().n,volunteers:f.volunteers.length,fakeApiCalls:f.calls.length}));await f.close();rmSync(directory,{recursive:true,force:true});process.exit(0);}
  const secret=randomBytes(24).toString('hex');
  let sequence=f.app.db.prepare('SELECT COALESCE(MAX(update_id),0) AS n FROM telegram_updates').get().n+1;
  const ordinary=f.app.server.listeners('request')[0];
  function actor(req){
    const token=/(?:^|;\s*)coord_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie||'')?.[1];
    if(!token)return null;
    const session=f.app.db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?').get(hashToken(token),Date.now());
    if(!session)return null;
    const user=d.user(session.user_id);
    return user.active&&user.roles.some(role=>['admin','manager','organizer'].includes(role))?{user,session}:null;
  }
  function page(identity,notice=''){
    const tasks=d.listTasks(identity.user);
    const people=f.volunteers.filter(v=>identity.user.roles.includes('admin')||v.managerId===identity.user.id);
    return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>NERC — эмулятор аудита</title><style>body{font:15px system-ui;background:#192234;color:#eef3fc;margin:24px}main{max-width:850px;background:white;color:#162135;padding:24px;border-radius:12px;margin:auto}h1{font-size:24px}label{display:block;margin:16px 0}select,textarea,button{font:inherit;padding:10px;max-width:100%}textarea{width:90%;display:block}button{cursor:pointer;margin:5px;background:#507dcb;color:white;border:0;border-radius:6px}.notice{background:#e8f1eb;padding:14px}li{margin:8px 0}</style><main><h1>Изолированный эмулятор Telegram</h1><p>Синтетические данные. Настоящий Telegram и рабочая база не используются.</p><p><a href="/">Открыть NERC</a> · Пользователь: ${escape(identity.user.name)}</p>${notice?`<p class="notice">${escape(notice)}</p>`:''}<form method="post" action="/__audit/action"><input type="hidden" name="csrf" value="${escape(identity.session.csrf)}"><label>Волонтёр <select name="volunteerId">${people.map(v=>`<option value="${v.id}">${escape(v.name)} · ${v.id}</option>`).join('')}</select></label><label>Задача <select name="taskId">${tasks.map(t=>`<option value="${t.id}">#${t.id} ${escape(t.title)} · ${escape(taskStates[t.status]||t.status)}</option>`).join('')}</select></label><label>Текст вопроса<textarea name="body" rows="3">Вопрос с изолированного эмулятора</textarea></label><button name="action" value="accept">Взять в работу</button><button name="action" value="complete">Подтвердить готовность</button><button name="action" value="question">Задать вопрос</button><button name="action" value="unavailable">Стать недоступным</button><button name="action" value="available">Стать доступным</button><button name="action" value="fail">Эмулировать запрет доставки</button><button name="action" value="restore">Восстановить доставку</button><button name="action" value="drain">Отправить очередь</button></form><h2>Последние обращения к подменённому Bot API</h2><ul>${f.calls.slice(-12).reverse().map(call=>`<li><strong>${escape(call.method)}</strong> · ${escape(call.payload.text||call.payload.callback_query_id||'')} ${call.payload.chat_id?' · чат '+escape(call.payload.chat_id):''}</li>`).join('')}</ul></main></html>`;
  }
  async function formAction(input,identity){
    if(input.get('csrf')!==identity.session.csrf)throw Object.assign(new Error('CSRF не совпал.'),{status:403});
    const action=input.get('action');
    if(action==='fail'||action==='restore'){f.failSend(action==='fail');return action==='fail'?'Синтетическая доставка запрещена.':'Синтетическая доставка восстановлена. Повторите отправку ошибки через NERC.';}
    if(action==='drain'){await f.drain();return 'Очередь подменённого Telegram обработана.';}
    const volunteer=f.volunteers.find(v=>v.id===Number(input.get('volunteerId')));
    if(!volunteer||(!identity.user.roles.includes('admin')&&volunteer.managerId!==identity.user.id))throw Object.assign(new Error('Выберите волонтёра своего тестового пула.'),{status:403});
    if(action==='available'||action==='unavailable'){
      const update={update_id:sequence++,message:{message_id:sequence,from:{id:volunteer.telegramId},chat:{id:volunteer.chatId,type:'private'},text:'/'+action}};
      await f.bot.handleUpdate(update);await f.drain();return 'Доступность обновлена через обработчик бота.';
    }
    const task=d.task(identity.user,Number(input.get('taskId')));
    const update={update_id:sequence++,callback_query:{id:`fixture-${sequence}`,from:{id:volunteer.telegramId},message:{message_id:1,chat:{id:volunteer.chatId,type:'private'}},data:`${action}:${task.id}:${task.generation}`}};
    const result=await f.bot.handleUpdate(update);
    if(action==='question'&&!result?.show_alert)await f.bot.handleUpdate({update_id:sequence++,message:{message_id:sequence,from:{id:volunteer.telegramId},chat:{id:volunteer.chatId,type:'private'},text:String(input.get('body')||'Тестовый вопрос')}});
    await f.drain();return result?.text||'Событие Telegram обработано.';
  }
  f.app.server.removeAllListeners('request');
  f.app.server.on('request',async(req,res)=>{
    if(!req.url.startsWith('/__audit'))return ordinary(req,res);
    const reply=(status,body)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(body));};
    const html=(status,body)=>{res.writeHead(status,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});res.end(body);};
    const identity=actor(req);
    if(req.method==='GET'&&req.url==='/__audit')return identity?html(200,page(identity)):html(401,'<a href="/">Войдите в изолированный NERC</a>, затем откройте эмулятор снова.');
    const secretAuth=req.headers['x-audit-token']===secret;
    if(req.url!=='/__audit/action'&&!secretAuth)return reply(403,{error:'Нужен ключ изолированного аудита.'});
    if(req.method==='GET'&&req.url==='/__audit/status')return reply(200,{fixture:'NERC_ISOLATED_AUDIT',fakeTelegram:true,managers:f.managers,volunteers:f.volunteers,calls:f.calls,memory:process.memoryUsage()});
    if(req.method!=='POST')return reply(405,{error:'Используйте POST.'});
    try{
      let size=0;const chunks=[];
      for await(const chunk of req){size+=chunk.length;if(size>65536)return reply(413,{error:'Слишком большой запрос.'});chunks.push(chunk);}
      const raw=Buffer.concat(chunks).toString()||'{}';
      if(req.url==='/__audit/action'){
        if(!identity)return html(401,'Войдите в тестовый NERC.');
        const expected=`http://${req.headers.host}`;
        if(req.headers.origin&&req.headers.origin!==expected)return html(403,'Источник формы не разрешён.');
        const notice=await formAction(new URLSearchParams(raw),identity);return html(200,page(identity,notice));
      }
      if(!String(req.headers['content-type']).startsWith('application/json'))return reply(415,{error:'Отправьте JSON.'});
      const input=JSON.parse(raw);
      if(req.url==='/__audit/telegram')return reply(200,await f.bot.handleUpdate(input));
      if(req.url==='/__audit/delivery-failure'){f.failSend(input.failed===true);return reply(200,{ok:true});}
      if(req.url==='/__audit/drain'){await f.drain();return reply(200,{ok:true,calls:f.calls});}
      reply(404,{error:'Тестовый маршрут не найден.'});
    }catch(error){if(req.url==='/__audit/action'&&identity)html(error.status||400,page(identity,error.message));else reply(error.status||400,{error:error.message});}
  });
  process.stdout.write(JSON.stringify({url:f.baseUrl,emulator:f.baseUrl+'/__audit',fixture:'NERC_ISOLATED_AUDIT',database:join(directory,'fixture.sqlite'),fakeTelegram:true,adminLogin:'audit-admin',managerLogins:f.managers.map(u=>u.login),organizerLogin:'audit-organizer',password,auditHeader:'x-audit-token',auditToken:secret,tasks:8,volunteers:f.volunteers.length})+'\n');
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await f.close();rmSync(directory,{recursive:true,force:true});process.exit(0);});
}catch(error){if(fixture)await fixture.close();rmSync(directory,{recursive:true,force:true});console.error(`Изолированный аудит не запущен: ${error.code||error.message}`);process.exitCode=1;}
