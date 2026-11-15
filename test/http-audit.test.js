import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import { Readable } from 'node:stream';
import { createApplication, hashPassword } from '../server.js';

const password = 'http-audit-password';
async function fixture(t) {
  const bot={status:()=>({configured:false}),stop:async()=>{}};
  const app=createApplication({database:':memory:',adminPassword:password,port:0,host:'127.0.0.1',token:'',username:'',bot});
  t.after(()=>app.close());
  const handler=app.server.listeners('request')[0];
  const request=async(path,{method='GET',body,rawBody,session,headers={}}={})=>{
    const bytes=rawBody===undefined?(body===undefined?'':JSON.stringify(body)):rawBody;
    const req=Readable.from(bytes?[Buffer.from(bytes)]:[]);
    req.url=path;req.method=method;req.socket={remoteAddress:'127.0.0.1'};
    req.headers={host:'127.0.0.1:4319',...(method==='POST'?{'content-type':'application/json'}:{}),...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{}),...headers};
    const res={headersSent:false,headers:{},status:200,content:'',setHeader(k,v){this.headers[k.toLowerCase()]=v;},writeHead(status,headers={}){this.headersSent=true;this.status=status;for(const [k,v]of Object.entries(headers))this.setHeader(k,v);},end(value){this.content=String(value??'');}};
    await handler(req,res);
    return {status:res.status,headers:res.headers,text:res.content,body:res.content?JSON.parse(res.content):null};
  };
  const login=async login=>{
    const response=await request('/api/login',{method:'POST',body:{login,password}});
    assert.equal(response.status,200,JSON.stringify(response.body));
    return {cookie:response.headers['set-cookie'].split(';')[0],csrf:response.body.csrf};
  };
  const admin=app.domain.user(1),adminSession=await login('admin');
  const addUser=input=>{
    const user=app.domain.adminSaveUser(admin,{active:true,tagIds:[],...input});
    app.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(password),user.id);
    return user;
  };
  return {app,request,login,admin,adminSession,addUser};
}

test('HTTP audit: malformed admin roles are validation errors, not server crashes',async t=>{
  const f=await fixture(t);
  for(const roles of [{role:'organizer'},'organizer',null,42]){
    const response=await f.request('/api/admin/users',{method:'POST',session:f.adminSession,body:{name:'Malformed',login:'malformed',roles}});
    assert.equal(response.status,400,`roles=${JSON.stringify(roles)}: ${response.text}`);
  }
});

test('HTTP audit: cached admin request is reauthorized after privileges are revoked',async t=>{
  const f=await fixture(t);
  const former=f.addUser({name:'Второй администратор',login:'former-admin',roles:['admin','organizer']});
  const originalSession=await f.login('former-admin');
  const input={name:'New direction',kind:'direction'},headers={'idempotency-key':'formerly-admin-action'};
  assert.equal((await f.request('/api/admin/tags',{method:'POST',session:originalSession,body:input,headers})).status,200);
  f.app.domain.adminSaveUser(f.admin,{id:former.id,roles:['organizer']});
  const downgraded=await f.login('former-admin');
  assert.equal((await f.request('/api/admin/tags',{method:'POST',session:downgraded,body:input,headers})).status,403);
});

test('HTTP audit: cached assignment and personal tags cannot bypass a changed pool',async t=>{
  const f=await fixture(t);
  const manager=f.addUser({name:'Менеджер',login:'manager',roles:['manager','organizer']});
  const other=f.addUser({name:'Другой менеджер',login:'other-manager',roles:['manager']});
  const volunteer=f.addUser({name:'Волонтёр',roles:['volunteer'],managerId:manager.id});
  const session=await f.login('manager');
  const task=f.app.domain.createTask(manager,{title:'Задача',tagIds:[]})[0];
  const tags={names:['Грузчики']},tagHeaders={'idempotency-key':'pool-tags'};
  assert.equal((await f.request(`/api/volunteers/${volunteer.id}/tags`,{method:'POST',session,body:tags,headers:tagHeaders})).status,200);
  const assign={mode:'manual',volunteerIds:[volunteer.id]},assignmentHeaders={'idempotency-key':'pool-assignment'};
  assert.equal((await f.request(`/api/tasks/${task.id}/assign`,{method:'POST',session,body:assign,headers:assignmentHeaders})).status,200);
  f.app.domain.adminSaveUser(f.admin,{id:volunteer.id,managerId:other.id});
  assert.equal((await f.request(`/api/volunteers/${volunteer.id}/tags`,{method:'POST',session,body:tags,headers:tagHeaders})).status,403);
  assert.equal((await f.request(`/api/tasks/${task.id}/assign`,{method:'POST',session,body:assign,headers:assignmentHeaders})).status,403);
});

test('HTTP audit: cached hall actions honor a revoked cross-hall flag',async t=>{
  const f=await fixture(t),halls=f.app.domain.tags().filter(x=>x.kind==='hall');
  const manager=f.addUser({name:'Менеджер',login:'manager',roles:['manager'],homeHallId:halls[0].id});
  const session=await f.login('manager');
  const task=f.app.domain.createTask(f.admin,{title:'Чужой холл',hallIds:[halls[1].id]})[0];
  f.app.domain.adminSettings(f.admin,{crossHall:true});
  const headers={'idempotency-key':'hall-claim'};
  assert.equal((await f.request(`/api/tasks/${task.id}/claim`,{method:'POST',session,body:{},headers})).status,200);
  f.app.domain.adminSettings(f.admin,{crossHall:false});
  assert.equal((await f.request(`/api/tasks/${task.id}/claim`,{method:'POST',session,body:{},headers})).status,403);
});

test('HTTP audit: session role changes, malformed JSON and request sizes stay controlled',async t=>{
  const f=await fixture(t);
  const person=f.addUser({name:'Совмещённые роли',login:'dual-role',roles:['organizer','volunteer']});
  const session=await f.login('dual-role');
  assert.equal((await f.request('/api/bootstrap',{session})).status,200);
  f.app.domain.adminSaveUser(f.admin,{id:person.id,roles:['volunteer']});
  assert.equal((await f.request('/api/bootstrap',{session})).status,401);
  for(const rawBody of ['{','[]','null'])assert.equal((await f.request('/api/tasks',{method:'POST',session:f.adminSession,rawBody})).status,400);
  assert.equal((await f.request('/api/tasks',{method:'POST',session:f.adminSession,rawBody:' '.repeat(65537)})).status,413);
  assert.equal((await f.request('http://[')).status,400);
});

test('HTTP audit: close is safe to repeat and closes the database only once',async()=>{
  let stops=0;
  const app=createApplication({database:':memory:',adminPassword:password,token:'',username:'',bot:{status:()=>({}),stop:async()=>{stops++;}}});
  await Promise.all([app.close(),app.close()]);
  assert.equal(stops,1);
});

test('HTTP audit: credential mutations do not leave cheap password verifiers in the replay cache',async t=>{
  const f=await fixture(t);
  const created=await f.request('/api/admin/users',{method:'POST',session:f.adminSession,headers:{'idempotency-key':'credential-create'},body:{name:'Новый организатор',login:'new-organizer',roles:['organizer'],password:'new-user-password'}});
  assert.equal(created.status,200);
  const changed=await f.request('/api/change-password',{method:'POST',session:f.adminSession,headers:{'idempotency-key':'credential-change'},body:{currentPassword:password,password:'changed-audit-password'}});
  assert.equal(changed.status,200);
  assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM request_keys').get().n,0);
});

test('HTTP audit: auth activity is durable and contains no passwords or session material',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/api/change-password',{method:'POST',session:f.adminSession,body:{currentPassword:password,password:'changed-audit-password'}})).status,200);
  assert.equal((await f.request('/api/logout',{method:'POST',session:f.adminSession,body:{}})).status,200);
  const events=f.app.db.prepare('SELECT * FROM activity ORDER BY id').all();
  for(const event of ['Вход в приложение','Пароль изменён','Выход из приложения'])assert.ok(events.some(row=>row.event===event),event);
  assert.ok(!JSON.stringify(events).includes(password));
  assert.ok(!JSON.stringify(events).includes('changed-audit-password'));
  assert.ok(!JSON.stringify(events).includes(f.adminSession.csrf));
});

test('HTTP audit: invalid startup settings fail before opening a database',async()=>{
  const common={database:':memory:',adminPassword:password,token:'',username:''};
  for(const adminLogin of [null,42,'','  ','a'.repeat(101)])assert.throws(()=>createApplication({...common,adminLogin}),/ADMIN_LOGIN/);
  for(const port of [-1,65536,NaN,1.5,'named'])assert.throws(()=>createApplication({...common,port}),/PORT/);
  for(const host of ['',42,'bad host'])assert.throws(()=>createApplication({...common,host}),/HOST/);
  for(const publicOrigin of ['file:///tmp','https://user:password@example.org','https://example.org/path'])assert.throws(()=>createApplication({...common,publicOrigin}),/PUBLIC_ORIGIN/);
  const app=createApplication({...common,publicOrigin:'https://example.org/',username:'@nerc_bot'});
  assert.equal(app.config.publicOrigin,'https://example.org');
  assert.equal(app.config.username,'nerc_bot');
  await app.close();
});

test('HTTP audit: JSON content type is exact and case-insensitive',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/api/tasks',{method:'POST',session:f.adminSession,body:{title:'Задача'},headers:{'content-type':'application/json-invalid'}})).status,415);
  assert.equal((await f.request('/api/tasks',{method:'POST',session:f.adminSession,body:{title:'Задача'},headers:{'content-type':'Application/JSON; charset=utf-8'}})).status,200);
});


test('HTTP audit: upgrading clears legacy credential cache without discarding task replay history',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'nerc-request-cache-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const options={database:join(directory,'audit.sqlite'),adminPassword:password,token:'',username:''};
  const old=createApplication(options);
  old.db.prepare("DELETE FROM meta WHERE key='request_cache_private_v2'").run();
  const insert=old.db.prepare('INSERT INTO request_keys(user_id,request_key,fingerprint,response,created_at) VALUES(1,?,?,?,?)');
  insert.run('old-user','legacy-verifier',JSON.stringify({id:2,roles:['organizer'],name:'Пользователь'}),Date.now());
  insert.run('old-password','legacy-verifier',JSON.stringify({ok:true}),Date.now());
  insert.run('task-action','task-verifier',JSON.stringify({id:1,title:'Задача',status:'queued'}),Date.now());
  await old.close();
  const current=createApplication(options);t.after(()=>current.close());
  assert.deepEqual(current.db.prepare('SELECT request_key FROM request_keys ORDER BY request_key').all().map(row=>row.request_key),['task-action']);
});

test('HTTP audit: recipient preview always reflects current pool and availability, even with a reused key',async t=>{
  const f=await fixture(t);
  const manager=f.addUser({name:'Менеджер',login:'preview-manager',roles:['manager']});
  const other=f.addUser({name:'Другой менеджер',login:'preview-other',roles:['manager']});
  const volunteer=f.addUser({name:'Волонтёр',roles:['volunteer'],managerId:manager.id});
  const session=await f.login('preview-manager');
  const request={method:'POST',session,body:{mode:'free'},headers:{'idempotency-key':'recipient-preview'}};
  let response=await f.request('/api/volunteers/preview',request);
  assert.equal(response.status,200);
  assert.deepEqual(response.body.volunteers.map(user=>user.id),[volunteer.id]);
  f.app.domain.setAvailability(volunteer,false);
  response=await f.request('/api/volunteers/preview',request);
  assert.equal(response.status,200);
  assert.deepEqual(response.body.volunteers,[]);
  f.app.domain.setAvailability(volunteer,true);
  f.app.domain.adminSaveUser(f.admin,{id:volunteer.id,managerId:other.id});
  response=await f.request('/api/volunteers/preview',request);
  assert.equal(response.status,200);
  assert.deepEqual(response.body.volunteers,[]);
  assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM request_keys WHERE request_key=?').get('recipient-preview').n,0);
});

test('HTTP audit: malformed JSON field matrix cannot crash or partially mutate any endpoint',async t=>{
  const f=await fixture(t);
  const manager=f.addUser({name:'Менеджер',login:'matrix-manager',roles:['manager']});
  const volunteer=f.addUser({name:'Волонтёр',roles:['volunteer'],managerId:manager.id});
  const managerSession=await f.login('matrix-manager');
  const task=f.app.domain.createTask(f.admin,{title:'Основная задача'})[0];
  f.app.domain.claimTask(f.admin,task.id);
  const question=f.app.domain.createQuestion(f.admin,task.id,{body:'Исходный вопрос'});
  const volunteerTask=f.app.domain.createTask(manager,{title:'Задача волонтёра'})[0];
  f.app.domain.assignTask(manager,volunteerTask.id,{mode:'manual',volunteerIds:[volunteer.id]});
  const volunteerQuestion=f.app.domain.createQuestion(volunteer,volunteerTask.id,{body:'Вопрос менеджеру'},volunteerTask.generation);
  const malformedIds=[false,true,[],{},'',0,-1,'1e0'];
  const badLists=[null,false,true,0,{},'1',[null],[true],[[]],[{}]];
  const badText=[null,false,true,0,[],{}];
  const badBooleans=[null,0,1,'false',[],{}];
  const cases=[];
  const add=(path,session,base,field,values)=>values.forEach(value=>cases.push({path,session,base,field,value}));
  add('/api/admin/users',f.adminSession,{name:'Недопустимый новый пользователь',roles:['volunteer']},'id',malformedIds);
  add('/api/admin/users',f.adminSession,{name:'Недопустимый новый пользователь',roles:['volunteer']},'roles',[null,[],{},'volunteer',false,0,[[]],['unknown']]);
  add('/api/admin/users',f.adminSession,{id:volunteer.id},'active',badBooleans);
  add('/api/admin/users',f.adminSession,{id:volunteer.id},'homeHallId',malformedIds);
  add('/api/admin/users',f.adminSession,{id:volunteer.id},'managerId',malformedIds);
  add('/api/admin/users',f.adminSession,{id:volunteer.id},'tagIds',badLists);
  add('/api/admin/users',f.adminSession,{id:volunteer.id},'name',badText);
  add('/api/admin/users',f.adminSession,{id:volunteer.id},'login',[false,true,0,[],{}]);
  add('/api/admin/tags',f.adminSession,{name:'Новый тег',kind:'direction'},'id',malformedIds);
  add('/api/admin/tags',f.adminSession,{name:'Новый тег',kind:'direction'},'name',badText);
  add('/api/admin/tags',f.adminSession,{name:'Новый тег',kind:'direction'},'kind',[null,false,0,[],{},'unknown']);
  add('/api/admin/settings',f.adminSession,{},'crossHall',badBooleans);
  add('/api/tasks',f.adminSession,{title:'Новая задача'},'allHalls',badBooleans);
  add('/api/tasks',f.adminSession,{title:'Новая задача'},'title',badText);
  add('/api/tasks',f.adminSession,{title:'Новая задача'},'tagIds',badLists);
  add('/api/tasks',f.adminSession,{title:'Новая задача'},'hallIds',badLists);
  for(const path of ['/api/volunteers/preview',`/api/tasks/${volunteerTask.id}/assign`]){
    // A fresh, unassigned task ensures invalid selectors are validated rather
    // than masked by a task's state conflict.
    const target=path.includes('/assign')?`/api/tasks/${f.app.domain.createTask(manager,{title:'Свободная задача'})[0].id}/assign`:path;
    add(target,managerSession,{mode:'manual',volunteerIds:[volunteer.id]},'volunteerIds',badLists);
    add(target,managerSession,{mode:'manual',volunteerIds:[volunteer.id]},'personalTagIds',badLists);
    add(target,managerSession,{volunteerIds:[volunteer.id]},'mode',[null,false,0,[],{},'unknown']);
  }
  add(`/api/volunteers/${volunteer.id}/tags`,managerSession,{},'names',badLists);
  add(`/api/tasks/${task.id}/questions`,f.adminSession,{body:'Новый вопрос'},'tagIds',badLists);
  add(`/api/tasks/${task.id}/questions`,f.adminSession,{body:'Новый вопрос'},'blocking',badBooleans);
  add(`/api/tasks/${task.id}/questions`,f.adminSession,{body:'Новый вопрос'},'body',badText);
  add(`/api/tasks/${task.id}/questions`,f.adminSession,{body:'Новый вопрос'},'urgency',[null,0,false,[],{},'unknown']);
  add(`/api/questions/${question.id}/reply`,f.adminSession,{},'body',badText);
  add(`/api/questions/${question.id}/close`,f.adminSession,{},'body',badText);
  add(`/api/questions/${question.id}/close`,f.adminSession,{},'sendToVolunteers',badBooleans);
  add(`/api/questions/${volunteerQuestion.id}/forward`,managerSession,{},'body',badText);
  add(`/api/questions/${volunteerQuestion.id}/forward`,managerSession,{},'blocking',badBooleans);
  add(`/api/questions/${volunteerQuestion.id}/forward`,managerSession,{},'tagIds',badLists);
  add(`/api/questions/${volunteerQuestion.id}/forward`,managerSession,{},'urgency',[null,0,false,[],{},'unknown']);
  const tables=['users','tags','tasks','assignments','questions','question_messages','audit','activity','outbox','settings','personal_tags','volunteer_personal_tags'];
  const state=()=>JSON.stringify(tables.map(table=>f.app.db.prepare(`SELECT * FROM ${table}`).all()));
  const failures=[];
  for(const item of cases){
    f.app.db.exec('BEGIN IMMEDIATE');
    try {
      const before=state();
      const response=await f.request(item.path,{method:'POST',session:item.session,body:{...item.base,[item.field]:item.value}});
      if(response.status!==400||state()!==before)failures.push({path:item.path,field:item.field,value:item.value,status:response.status,mutated:state()!==before});
    } finally {f.app.db.exec('ROLLBACK');}
  }
  assert.deepEqual(failures,[]);
  assert.ok(cases.length>=200);
});

test('HTTP audit: cached reset loses authorization when another organizer now owns the task',async t=>{
  const f=await fixture(t);
  const manager=f.addUser({name:'Первый менеджер',login:'reset-manager',roles:['manager']});
  const next=f.addUser({name:'Другой организатор',login:'reset-next',roles:['organizer']});
  const volunteer=f.addUser({name:'Волонтёр',roles:['volunteer'],managerId:manager.id});
  const session=await f.login('reset-manager');
  const task=f.app.domain.createTask(f.admin,{title:'Смена исполнителя'})[0];
  f.app.domain.assignTask(manager,task.id,{mode:'manual',volunteerIds:[volunteer.id]});
  const request={method:'POST',session,headers:{'idempotency-key':'previous-reset-owner'},body:{reason:'Передать следующей смене'}};
  assert.equal((await f.request(`/api/tasks/${task.id}/reset`,request)).status,200);
  f.app.domain.claimTask(next,task.id);
  const replay=await f.request(`/api/tasks/${task.id}/reset`,request);
  assert.equal(replay.status,403);
  const current=f.app.domain.task(f.admin,task.id);
  assert.equal(current.status,'in_progress');
  assert.equal(current.claimedBy,next.id);
});

test('HTTP audit: cached retry of an unlinked recipient is denied after administrator privileges are revoked',async t=>{
  const f=await fixture(t);
  const otherAdmin=f.addUser({name:'Второй администратор',login:'retry-other-admin',roles:['admin','organizer']});
  const job=Number(f.app.db.prepare(`INSERT INTO outbox(event_key,kind,user_id,payload,status,created_at)
    VALUES('unknown-recipient-audit','message',NULL,?,'failed',?)`).run(JSON.stringify({text:'Ответ на подключение',chatId:12345}),new Date().toISOString()).lastInsertRowid);
  const request={method:'POST',session:f.adminSession,headers:{'idempotency-key':'unlinked-recipient-retry'},body:{}};
  assert.equal((await f.request(`/api/deliveries/${job}/retry`,request)).status,200);
  f.app.domain.adminSaveUser(otherAdmin,{id:f.admin.id,roles:['manager','organizer']});
  request.session=await f.login('admin');
  assert.equal((await f.request(`/api/deliveries/${job}/retry`,request)).status,403);
});

test('HTTP audit: cached group resolution cannot bypass a changed assigning manager',async t=>{
  const f=await fixture(t);
  const manager=f.addUser({name:'Первый менеджер',login:'resolution-manager',roles:['manager']});
  const other=f.addUser({name:'Другой менеджер',login:'resolution-other',roles:['manager']});
  const volunteer=f.addUser({name:'Первый волонтёр',roles:['volunteer'],managerId:manager.id});
  const replacement=f.addUser({name:'Новый волонтёр',roles:['volunteer'],managerId:other.id});
  const session=await f.login('resolution-manager');
  const task=f.app.domain.createTask(f.admin,{title:'Задача с групповым пояснением'})[0];
  f.app.domain.assignTask(manager,task.id,{mode:'manual',volunteerIds:[volunteer.id]});
  const question=f.app.domain.createQuestion(volunteer,task.id,{body:'Где оборудование?'},task.generation);
  const request={method:'POST',session,headers:{'idempotency-key':'group-resolution'},body:{body:'Всё на складе.',sendToVolunteers:true}};
  assert.equal((await f.request(`/api/questions/${question.id}/close`,request)).status,200);
  f.app.domain.resetTask(f.admin,task.id,'Новая смена');
  f.app.domain.assignTask(other,task.id,{mode:'manual',volunteerIds:[replacement.id]});
  const deliveries=f.app.db.prepare('SELECT count(*) AS n FROM outbox').get().n;
  assert.equal((await f.request(`/api/questions/${question.id}/close`,request)).status,403);
  assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM outbox').get().n,deliveries);
});
