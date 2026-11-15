import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createApplication, hashPassword } from '../server.js';
import { openDatabase } from '../lib/db.js';
import { Domain } from '../lib/domain.js';
import { TelegramBot } from '../lib/telegram.js';

const TEST_PASSWORD = 'isolated-audit-password-2026';
const me = fileURLToPath(import.meta.url);
const mb = bytes => Math.round(bytes / 1048576 * 100) / 100;
function summary(values) {
  const sorted = [...values].sort((a,b)=>a-b);
  const at = fraction => sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*fraction)-1)] || 0;
  return {requests:values.length,p50Ms:+at(.5).toFixed(3),p95Ms:+at(.95).toFixed(3),maxMs:+at(1).toFixed(3)};
}

export async function createAuditHarness({mode='handler',database=':memory:',port=0,organizers=50,poolSize=200}={}) {
  if(database!==':memory:'&&existsSync(database)&&statSync(database).size>0)throw new Error('Audit fixture requires a new empty database; refusing an existing file.');
  let bot;
  const calls=[];
  let nextMessage=1;
  let failSend=false;
  const proxy={status:()=>bot?.status()||{},stop:()=>bot?.stop(),createLink:(...args)=>bot.createLink(...args)};
  const app=createApplication({database,adminLogin:'audit-admin',adminPassword:TEST_PASSWORD,host:'127.0.0.1',port,token:'',username:'',secureCookies:false,publicOrigin:'',bot:proxy});
  bot=new TelegramBot({db:app.db,domain:app.domain,token:'ISOLATED_FAKE_TOKEN',username:'isolated_audit_bot',fetchImpl:async(url,request)=>{
    const method=url.split('/').at(-1),payload=JSON.parse(request.body);
    calls.push({method,payload});
    const failed=failSend&&['sendMessage','editMessageText'].includes(method);
    return new Response(JSON.stringify(failed?{ok:false,error_code:403,description:'Synthetic blocked chat'}:{ok:true,result:method==='sendMessage'?{message_id:nextMessage++}:method==='getUpdates'?[]:true}),{status:failed?403:200});
  }});
  const admin=app.domain.user(1);
  const hall1=app.domain.tags().find(t=>t.name==='Hall 1').id;
  const hall2=app.domain.tags().find(t=>t.name==='Hall 2').id;
  const tc=app.domain.tags().find(t=>t.name==='TC').id;
  const passwordHash=hashPassword(TEST_PASSWORD);
  const managers=[];
  const volunteers=[];
  app.db.exec('BEGIN IMMEDIATE');
  try {
    const insert=app.db.prepare('INSERT INTO users(name,login,password_hash,roles,tag_ids,home_hall_id,manager_id,telegram_id,chat_id) VALUES(?,?,?,?,?,?,?,?,?)');
    for(let i=0;i<organizers;i++) {
      const id=Number(insert.run(`Тестовый менеджер ${i+1}`,`audit-manager-${i+1}`,passwordHash,'["organizer","manager"]',JSON.stringify([hall1]),hall1,null,null,null).lastInsertRowid);
      managers.push(app.domain.user(id));
    }
    for(let i=0;i<poolSize+organizers-1;i++) {
      const managerId=i<poolSize?managers[0].id:managers[i-poolSize+1].id;
      const id=Number(insert.run(`Тестовый волонтёр ${i+1}`,null,null,'["volunteer"]',JSON.stringify([hall1,tc]),null,managerId,100000+i,100000+i).lastInsertRowid);
      volunteers.push(app.domain.user(id));
    }
    app.db.exec('COMMIT');
  }catch(error){app.db.exec('ROLLBACK');await app.close();throw error;}
  const handler=app.server.listeners('request')[0];
  let baseUrl;
  if(mode==='tcp'){try{const address=await app.start();baseUrl=`http://127.0.0.1:${address.port}`;}catch(error){await app.close();throw error;}}
  const request=async(path,{method='GET',body,session,headers={}}={})=>{
    const requestHeaders={...(body===undefined?{}:{'content-type':'application/json'}),...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{}),...headers};
    if(mode==='tcp'){
      const response=await fetch(baseUrl+path,{method,headers:requestHeaders,body:body===undefined?undefined:JSON.stringify(body)});
      return {status:response.status,headers:response.headers,body:await response.json()};
    }
    const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
    req.method=method;req.url=path;req.headers={host:'127.0.0.1:4338',...requestHeaders};req.socket={remoteAddress:'127.0.0.1'};
    const responseHeaders=new Headers();let status=200,result;
    const res={headersSent:false,setHeader:(key,value)=>responseHeaders.set(key,value),writeHead(code,values={}){status=code;this.headersSent=true;for(const[k,v]of Object.entries(values))responseHeaders.set(k,v);},end(value){result=value===undefined?'':String(value);}};
    await handler(req,res);
    return {status,headers:responseHeaders,body:JSON.parse(result)};
  };
  const login=async login=>{
    const r=await request('/api/login',{method:'POST',body:{login,password:TEST_PASSWORD}});
    assert.equal(r.status,200,JSON.stringify(r.body));
    return {cookie:r.headers.get('set-cookie').split(';')[0],csrf:r.body.csrf,user:r.body.user};
  };
  const sessions=[];
  for(const manager of managers)sessions.push(await login(manager.login));
  const adminSession=await login('audit-admin');
  let updateId=1;
  const callback=(volunteer,action,task)=>({update_id:updateId++,callback_query:{id:`audit-callback-${updateId}`,from:{id:volunteer.telegramId},message:{message_id:1,chat:{id:volunteer.chatId,type:'private'}},data:`${action}:${task.id}:${task.generation}`}});
  const create=async(session=sessions[0],input={})=>{
    const r=await request('/api/tasks',{method:'POST',session,body:{title:'Изолированная тестовая задача',description:'Синтетические данные аудита.',tagIds:[],...input}});
    assert.equal(r.status,200,JSON.stringify(r.body));return r.body.tasks[0];
  };
  const drain=async()=>{
    for(let i=0;i<2000;i++){
      const due=app.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE status IN ('pending','failed') AND next_attempt<=?").get(Date.now()).n;
      if(!due)return;
      await bot.drainOutbox();
    }
    throw new Error('Очередь тестовой доставки не опустела за 2000 проходов.');
  };
  return {app,bot,admin,hall1,hall2,tc,managers,volunteers,sessions,adminSession,request,login,callback,create,calls,drain,baseUrl,handler,failSend:value=>{failSend=value;},async close(){await app.close();calls.length=0;}};
}

async function batch(actions) {
  const latencies=[];const statuses={};const start=performance.now();
  const results=await Promise.all(actions.map(async action=>{const started=performance.now();const result=await action();latencies.push(performance.now()-started);const status=result.status??(result.show_alert?'controlled_rejection':'ok');statuses[status]=(statuses[status]||0)+1;return result;}));
  return {results,metrics:{...summary(latencies),elapsedMs:+(performance.now()-start).toFixed(3),statuses}};
}

export async function runHandlerStress({mode='handler',organizers=50,poolSize=200}={}) {
  const before=process.memoryUsage();const beforeResources=process.getActiveResourcesInfo();
  const f=await createAuditHarness({mode,organizers,poolSize});
  try {
    const post=(path,session,body={})=>f.request(path,{method:'POST',session,body});
    const claim=await f.create();
    const claimed=await batch(f.sessions.map(session=>()=>post(`/api/tasks/${claim.id}/claim`,session)));
    assert.equal(claimed.results.filter(r=>r.status===200).length,1);
    assert.equal(claimed.results.filter(r=>r.status===409).length,organizers-1);
    assert.equal(f.app.db.prepare('SELECT COUNT(*) AS n FROM assignments WHERE task_id=?').get(claim.id).n,0);
    const assignment=await f.create();
    const assigned=await batch(f.sessions.map((session,index)=>()=>post(`/api/tasks/${assignment.id}/assign`,session,{volunteerIds:[f.volunteers.find(v=>v.managerId===f.managers[index].id).id],mode:'manual'})));
    assert.equal(assigned.results.filter(r=>r.status===200).length,1);
    assert.equal(assigned.results.filter(r=>r.status===409).length,organizers-1);
    assert.equal(f.app.db.prepare('SELECT COUNT(*) AS n FROM assignments WHERE task_id=?').get(assignment.id).n,1);
    const mixed=await f.create();
    const competed=await batch(f.sessions.map((session,index)=>()=>post(`/api/tasks/${mixed.id}/${index%2?'assign':'claim'}`,session,index%2?{volunteerIds:[f.volunteers.find(v=>v.managerId===f.managers[index].id).id],mode:'manual'}:{})));
    assert.equal(competed.results.filter(r=>r.status===200).length,1);
    assert.ok(competed.results.every(r=>[200,409].includes(r.status)));
    const mixedView=f.app.domain.task(f.admin,mixed.id);
    assert.ok(Boolean(mixedView.claimedBy)!==Boolean(mixedView.assignedBy));

    const mass=await f.create();
    const pool=f.volunteers.filter(v=>v.managerId===f.managers[0].id);
    f.app.domain.setPersonalTags(f.managers[0],pool[0].id,{names:['Команда аудита']});
    const personal=f.app.db.prepare('SELECT id FROM personal_tags WHERE manager_id=?').get(f.managers[0].id).id;
    for(const volunteer of pool)f.app.db.prepare('INSERT OR IGNORE INTO volunteer_personal_tags(volunteer_id,personal_tag_id) VALUES(?,?)').run(volunteer.id,personal);
    const overlap={mode:'free',volunteerIds:[pool[0].id,pool[0].id,...pool.slice(0,10).map(v=>v.id)],personalTagIds:[personal,personal]};
    const preview=await post('/api/volunteers/preview',f.sessions[0],overlap);
    assert.equal(preview.status,200);assert.equal(preview.body.volunteers.length,pool.length);
    const massStart=performance.now();
    const published=await post(`/api/tasks/${mass.id}/assign`,f.sessions[0],overlap);
    assert.equal(published.status,200);
    assert.equal(published.body.assignments.length,pool.length);
    assert.equal(new Set(published.body.assignments.map(a=>a.volunteerId)).size,pool.length);
    assert.equal(f.app.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE task_id=? AND kind='task'").get(mass.id).n,pool.length);
    await f.drain();
    const sent=f.calls.filter(c=>c.method==='sendMessage'&&c.payload.reply_markup&&c.payload.text.startsWith(`Задача №${mass.id}\n`));
    assert.equal(sent.length,pool.length);
    const massMs=performance.now()-massStart;
    const participants=pool.slice(0,organizers);
    const accepts=await batch(participants.map(v=>()=>f.bot.handleUpdate(f.callback(v,'accept',mass))));
    assert.ok(accepts.results.every(r=>!r.show_alert));
    assert.equal(f.app.domain.task(f.admin,mass.id).status,'in_progress');
    const completes=await batch(participants.map(v=>()=>f.bot.handleUpdate(f.callback(v,'complete',mass))));
    assert.equal(completes.results.filter(r=>!r.show_alert).length,1);
    assert.equal(f.app.domain.task(f.admin,mass.id).status,'done');
    assert.equal(f.app.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE task_id=? AND event='Задача выполнена'").get(mass.id).n,1);
    const duplicate=f.callback(pool[0],'accept',mass);
    const duplicates=await batch(Array.from({length:organizers},()=>()=>f.bot.handleUpdate(duplicate)));
    assert.equal(duplicates.results.filter(r=>r.duplicate).length,organizers-1);

    const refreshJobs=f.app.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE task_id=? AND kind='task' AND status!='sent'").get(mass.id).n;
    const refreshStart=performance.now();
    await f.drain();
    const refreshedCards=f.calls.filter(call=>call.method==='editMessageText'&&call.payload.text.startsWith(`Задача №${mass.id}\n`));
    assert.equal(refreshedCards.length,pool.length,'Every recipient needs one latest card edit, not one edit per obsolete refresh job.');
    assert.ok(refreshedCards.every(call=>call.payload.text.includes('Выполнена')&&!call.payload.reply_markup.inline_keyboard.length));
    const refreshMs=performance.now()-refreshStart;

    const questionTask=await f.create();
    const questions=await batch(Array.from({length:20},(_,i)=>()=>post(`/api/tasks/${questionTask.id}/questions`,f.sessions[0],{body:`Блокирующий вопрос ${i+1}`,tagIds:[f.hall1,f.tc,f.hall1],blocking:true,urgency:'urgent'})));
    assert.ok(questions.results.every(r=>r.status===200));
    const qids=questions.results.map(r=>r.body.id);
    const duplicatesInNotifications=f.app.db.prepare('SELECT user_id,question_id,COUNT(*) AS n FROM notifications GROUP BY user_id,question_id HAVING COUNT(*)>1').all();
    assert.deepEqual(duplicatesInNotifications,[]);
    const recipients=f.app.domain.recipients(f.app.domain.rawQuestion(qids[0])).length;
    assert.equal(f.app.db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n,recipients*20);
    assert.equal(f.app.domain.task(f.admin,questionTask.id).blocked,true);
    for(const questionId of qids.slice(0,-1)){const closed=await post(`/api/questions/${questionId}/close`,f.sessions[0]);assert.equal(closed.status,200);}
    assert.equal(f.app.domain.task(f.admin,questionTask.id).blocked,true);
    assert.equal((await post(`/api/questions/${qids.at(-1)}/close`,f.sessions[0])).status,200);
    assert.equal(f.app.domain.task(f.admin,questionTask.id).blocked,false);

    const readBatch=await batch(Array.from({length:200},()=>()=>f.request('/api/tasks?scope=all',{session:f.sessions[0]})));
    assert.ok(readBatch.results.every(r=>r.status===200));
    const after=process.memoryUsage();
    return {mode:mode==='handler'?'HTTP request handler + real SQLite (no TCP)':'real HTTP/TCP + SQLite',concurrency:organizers,poolSize:pool.length,
      claimRace:claimed.metrics,assignmentRace:assigned.metrics,mixedRace:competed.metrics,
      massAssignment:{recipients:pool.length,messages:sent.length,elapsedMs:+massMs.toFixed(3),duplicateAssignments:0,duplicateInitialMessages:0},
      callbackAccept:accepts.metrics,callbackComplete:completes.metrics,duplicateUpdates:duplicates.metrics,
      callbackRefreshDelivery:{pendingJobsBeforeDelivery:refreshJobs,actualCardEdits:refreshedCards.length,consumerCoalescedJobs:refreshJobs-refreshedCards.length,elapsedMs:+refreshMs.toFixed(3)},
      questions:{...questions.metrics,recipientCount:recipients,notifications:recipients*20,duplicateNotifications:0},readBurst:readBatch.metrics,
      serverErrors:0,unexpectedRejections:0,sqliteBusyErrors:0,
      memory:{rssBeforeMiB:mb(before.rss),rssAfterMiB:mb(after.rss),heapBeforeMiB:mb(before.heapUsed),heapAfterMiB:mb(after.heapUsed),note:'Includes test request objects, retained fake API calls and intentional database/outbox growth; a snapshot is not proof against long-term leaks.'},
      resourcesBefore:beforeResources,resourcesAtPeak:process.getActiveResourcesInfo(),persistedRows:{tasks:f.app.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,users:f.app.db.prepare('SELECT COUNT(*) AS n FROM users').get().n,outbox:f.app.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n,pendingOutbox:f.app.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE status!='sent'").get().n}};
  } finally {await f.close();}
}

export async function runExternalStress({url,auditToken,fetchImpl=globalThis.fetch}={}) {
  const origin=new URL(url);
  if(origin.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(origin.hostname)||origin.pathname!=='/'||origin.search||origin.hash)throw new Error('External audit accepts only a local HTTP fixture origin.');
  const base=origin.origin;
  const request=async(path,{method='GET',body,session}={})=>{
    const headers={...(body===undefined?{}:{'content-type':'application/json'}),...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{}),...(path.startsWith('/__audit/')?{'x-audit-token':auditToken||''}:{})};
    const response=await fetchImpl(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
    return {status:response.status,headers:response.headers,body:await response.json()};
  };
  const initial=await request('/__audit/status');
  assert.equal(initial.status,200,'The isolated fixture audit token was not accepted.');
  assert.equal(initial.body.fixture,'NERC_ISOLATED_AUDIT');assert.equal(initial.body.fakeTelegram,true);
  const login=async login=>{const r=await request('/api/login',{method:'POST',body:{login,password:TEST_PASSWORD}});assert.equal(r.status,200);return {cookie:r.headers.get('set-cookie').split(';')[0],csrf:r.body.csrf};};
  const sessions=await Promise.all(initial.body.managers.map(manager=>login(manager.login)));
  const post=(path,session,body={})=>request(path,{method:'POST',session,body});
  const create=async()=>{const r=await post('/api/tasks',sessions[0],{title:'Нагрузка внешнего изолированного стенда',tagIds:[]});assert.equal(r.status,200,JSON.stringify(r.body));return r.body.tasks[0];};
  const count=50;
  const claim=await create();
  const claims=await batch(Array.from({length:count},(_,i)=>()=>post(`/api/tasks/${claim.id}/claim`,sessions[i%sessions.length])));
  assert.equal(claims.results.filter(r=>r.status===200).length,1);assert.ok(claims.results.every(r=>[200,409].includes(r.status)));
  const assignment=await create();
  const assigns=await batch(Array.from({length:count},(_,i)=>{const owner=i%sessions.length,volunteer=initial.body.volunteers.find(v=>v.managerId===initial.body.managers[owner].id);return()=>post(`/api/tasks/${assignment.id}/assign`,sessions[owner],{mode:'manual',volunteerIds:[volunteer.id]});}));
  assert.equal(assigns.results.filter(r=>r.status===200).length,1);assert.ok(assigns.results.every(r=>[200,409].includes(r.status)));
  const mixed=await create();
  const mixes=await batch(Array.from({length:count},(_,i)=>()=>post(`/api/tasks/${mixed.id}/${i%2?'assign':'claim'}`,sessions[i%sessions.length],i%2?{volunteerIds:[initial.body.volunteers.find(v=>v.managerId===initial.body.managers[i%sessions.length].id).id]}:{})));
  assert.equal(mixes.results.filter(r=>r.status===200).length,1);assert.ok(mixes.results.every(r=>[200,409].includes(r.status)));
  const pool=initial.body.volunteers.filter(v=>v.managerId===initial.body.managers[0].id);
  const bootstrap=(await request('/api/bootstrap',{session:sessions[0]})).body;
  const personal=bootstrap.personalTags[0]?.id;
  const mass=await create(),started=performance.now();
  const assigned=await post(`/api/tasks/${mass.id}/assign`,sessions[0],{mode:'all',volunteerIds:[pool[0].id,pool[0].id],personalTagIds:personal?[personal,personal]:[]});
  assert.equal(assigned.status,200);assert.equal(assigned.body.assignments.length,pool.length);
  const drained=await post('/__audit/drain',null);
  assert.equal(drained.status,200);
  const cards=drained.body.calls.filter(call=>call.method==='sendMessage'&&call.payload.reply_markup&&call.payload.text.startsWith(`Задача №${mass.id}\n`));
  assert.equal(cards.length,pool.length);
  const massElapsedMs=performance.now()-started;
  let updateId=Date.now()*1000;
  const callback=(volunteer,action)=>({update_id:updateId++,callback_query:{id:`external-${updateId}`,from:{id:volunteer.telegramId},message:{message_id:1,chat:{id:volunteer.chatId,type:'private'}},data:`${action}:${mass.id}:${mass.generation}`}});
  const accepts=await batch(pool.slice(0,count).map(volunteer=>()=>post('/__audit/telegram',null,callback(volunteer,'accept'))));
  assert.ok(accepts.results.every(r=>r.status===200&&!r.body.show_alert));
  const completes=await batch(pool.slice(0,count).map(volunteer=>()=>post('/__audit/telegram',null,callback(volunteer,'complete'))));
  assert.ok(completes.results.every(r=>r.status===200),'Callback endpoint returned a non-200 HTTP response.');
  const successfulCompletions=completes.results.filter(r=>!r.body.show_alert).length;
  const controlledCompletionConflicts=completes.results.filter(r=>r.body.show_alert===true).length;
  assert.equal(successfulCompletions,1);assert.equal(controlledCompletionConflicts,count-1);
  assert.equal((await request(`/api/tasks/${mass.id}`,{session:sessions[0]})).body.status,'done');
  const finalDrain=await post('/__audit/drain',null);
  assert.equal(finalDrain.status,200);
  const edits=finalDrain.body.calls.filter(call=>call.method==='editMessageText'&&call.payload.text.startsWith(`Задача №${mass.id}\n`));
  assert.equal(edits.length,pool.length);
  const questionTask=await create();
  const hall=bootstrap.tags.find(tag=>tag.name==='Hall 1').id,tc=bootstrap.tags.find(tag=>tag.name==='TC').id;
  const questions=await batch(Array.from({length:20},(_,i)=>()=>post(`/api/tasks/${questionTask.id}/questions`,sessions[0],{body:`Внешний нагрузочный вопрос ${i+1}`,tagIds:[hall,tc,hall],blocking:true})));
  assert.ok(questions.results.every(r=>r.status===200));
  const qids=questions.results.map(r=>r.body.id);
  const recipient=(await request('/api/bootstrap',{session:sessions[1]})).body;
  const notices=recipient.notifications.filter(notification=>qids.includes(notification.questionId));
  assert.equal(notices.length,qids.length);assert.equal(new Set(notices.map(n=>n.questionId)).size,qids.length);
  for(const qid of qids.slice(0,-1))assert.equal((await post(`/api/questions/${qid}/close`,sessions[0])).status,200);
  assert.equal((await request(`/api/tasks/${questionTask.id}`,{session:sessions[0]})).body.blocked,true);
  assert.equal((await post(`/api/questions/${qids.at(-1)}/close`,sessions[0])).status,200);
  assert.equal((await request(`/api/tasks/${questionTask.id}`,{session:sessions[0]})).body.blocked,false);
  const reads=await batch(Array.from({length:200},()=>()=>request('/api/tasks?scope=all',{session:sessions[0]})));
  assert.ok(reads.results.every(r=>r.status===200));
  const final=await request('/__audit/status');
  assert.equal(final.status,200);assert.equal(final.body.fixture,'NERC_ISOLATED_AUDIT');
  const serverErrors=[claims,assigns,mixes,accepts,completes,questions,reads].flatMap(batch=>batch.results).filter(result=>result.status>=500).length;
  return {mode:fetchImpl===globalThis.fetch?'real HTTP/TCP to pre-running disposable audit fixture':'external runner with injected fixture transport (no TCP)',origin:base,concurrency:count,poolSize:pool.length,claimRace:claims.metrics,assignmentRace:assigns.metrics,mixedRace:mixes.metrics,massAssignment:{recipients:pool.length,messages:cards.length,elapsedMs:+massElapsedMs.toFixed(3)},callbackAccept:accepts.metrics,callbackComplete:{...completes.metrics,businessSuccess:successfulCompletions,controlledConflicts:controlledCompletionConflicts},callbackRefreshDelivery:{actualCardEdits:edits.length},questions:{...questions.metrics,duplicateNotificationsToCheckedRecipient:0},readBurst:reads.metrics,serverErrors,memory:{serverBefore:initial.body.memory,serverAfter:final.body.memory,note:'Intentional fixture data is retained by its independently running server; these snapshots alone do not prove absence of leaks.'}};
}

export async function runWorkerContention({concurrency=50}={}) {
  const directory=mkdtempSync(join(tmpdir(),'nerc-contention-'));
  const path=join(directory,'app.sqlite');
  const f=await createAuditHarness({database:path,organizers:concurrency,poolSize:1});
  const task=await f.create();
  const workers=[];const start=performance.now();
  try{
    let ready=0;
    const outcomes=await Promise.all(f.managers.map((manager,index)=>new Promise((resolve,reject)=>{
      const worker=new Worker(new URL(import.meta.url),{workerData:{path,actorId:manager.id,taskId:task.id,volunteerId:f.volunteers.find(v=>v.managerId===manager.id).id,action:index%2?'assign':'claim'}});
      workers.push(worker);
      worker.once('error',reject);
      worker.on('message',message=>{if(message.ready){if(++ready===concurrency)workers.forEach(w=>w.postMessage('go'));}else resolve(message);});
      worker.once('exit',code=>{if(code)reject(new Error(`Тестовый Worker завершился с кодом ${code}`));});
    })));
    assert.equal(outcomes.filter(r=>r.status===200).length,1);
    assert.equal(outcomes.filter(r=>r.status===409).length,concurrency-1);
    assert.ok(outcomes.every(r=>[200,409].includes(r.status)),JSON.stringify(outcomes));
    const taskState=f.app.domain.task(f.admin,task.id);
    assert.ok(Boolean(taskState.claimedBy)!==Boolean(taskState.assignedBy));
    return {layer:'independent Worker threads, one SQLite WAL file',concurrency,...summary(outcomes.map(r=>r.elapsedMs)),elapsedMs:+(performance.now()-start).toFixed(3),success:1,controlledConflicts:concurrency-1,sqliteBusyErrors:outcomes.filter(r=>r.code?.includes('BUSY')).length,assignments:taskState.assignments.length};
  }finally{await Promise.all(workers.map(worker=>worker.terminate()));await f.close();rmSync(directory,{recursive:true,force:true});}
}

export async function runCrashRecovery() {
  const directory=mkdtempSync(join(tmpdir(),'nerc-crash-'));
  const path=join(directory,'app.sqlite');
  const child=fork(me,['--crash-writer',path],{stdio:['ignore','ignore','pipe','ipc'],env:{PATH:process.env.PATH}});
  let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
  const started=performance.now();
  try{
    const snapshot=await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('Дочерний процесс не подготовил базу за 15 секунд. '+stderr)),15000);
      child.once('message',message=>{clearTimeout(timeout);resolve(message);});
      child.once('error',error=>{clearTimeout(timeout);reject(error);});
      child.once('exit',code=>{clearTimeout(timeout);reject(new Error(`Writer преждевременно завершился: ${code}; ${stderr}`));});
    });
    const exited=once(child,'exit'),closed=once(child,'close');child.kill('SIGKILL');const[code,signal]=await exited;await closed;
    assert.equal(signal,'SIGKILL');assert.equal(code,null);
    const db=openDatabase(path);
    try{
      const domain=new Domain(db),task=domain.task(domain.user(snapshot.managerId),snapshot.taskId);
      assert.equal(task.title,'Задача перед жёстким перезапуском');
      assert.equal(task.status,'in_progress');assert.equal(task.blocked,true);
      assert.equal(task.assignments.length,1);assert.ok(task.assignments[0].acceptedAt);
      assert.equal(task.history.length,snapshot.history);
      assert.equal(domain.user(snapshot.volunteerId).available,true);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM telegram_updates').get().n,1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n,snapshot.outbox);
      assert.equal(task.questions[0].messages.length,2);
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
      return {layer:'real child process SIGKILL + SQLite reopen',signal,committedTaskState:task.status,historyRows:task.history.length,questionMessages:task.questions[0].messages.length,uncommittedChangesRolledBack:true,telegramEventDedupePreserved:true,outboxRows:snapshot.outbox,integrity:'ok',elapsedMs:+(performance.now()-started).toFixed(3)};
    }finally{db.close();}
  }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');rmSync(directory,{recursive:true,force:true});}
}

export async function runResourceProbe() {
  if(!global.gc)return {measured:false,note:'Run Node with --expose-gc for retained heap measurements.'};
  const samples=[];
  for(let cycle=0;cycle<5;cycle++){
    const f=await createAuditHarness({organizers:2,poolSize:5});
    try {
      for(let i=0;i<100;i++)await f.create();
      const responses=await Promise.all(Array.from({length:50},()=>f.request('/api/tasks?scope=all',{session:f.sessions[0]})));
      assert.ok(responses.every(r=>r.status===200));
    }finally{await f.close();}
    await new Promise(resolve=>setImmediate(resolve));
    global.gc();
    samples.push({cycle:cycle+1,heapMiB:mb(process.memoryUsage().heapUsed),rssMiB:mb(process.memoryUsage().rss),resources:process.getActiveResourcesInfo()});
  }
  const retainedGrowthMiB=+(samples.at(-1).heapMiB-samples[1].heapMiB).toFixed(2);
  assert.ok(retainedGrowthMiB<8,`Retained heap grew ${retainedGrowthMiB} MiB after warmup.`);
  const networkTypes=['TCPSocketWrap','TCPServerWrap','Timeout'];
  for(const type of networkTypes){
    const count=sample=>sample.resources.filter(resource=>resource===type).length;
    assert.ok(count(samples.at(-1))<=count(samples[1]),`Resource ${type} accumulated between isolated cycles.`);
  }
  return {measured:true,cycles:5,tasksPerCycle:100,parallelReadsPerCycle:50,retainedGrowthAfterWarmupMiB:retainedGrowthMiB,growthBudgetMiB:8,samples,note:'Short repeatability probe only; excludes TCP connection leaks because network listening is denied in this environment.'};
}

async function workerRun(){
  const db=new DatabaseSync(workerData.path);db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;');
  const domain=new Domain(db);parentPort.postMessage({ready:true});
  await once(parentPort,'message');const started=performance.now();
  try{
    if(workerData.action==='claim')domain.claimTask(domain.user(workerData.actorId),workerData.taskId);
    else domain.assignTask(domain.user(workerData.actorId),workerData.taskId,{mode:'manual',volunteerIds:[workerData.volunteerId]});
    parentPort.postMessage({status:200,elapsedMs:performance.now()-started});
  }catch(error){parentPort.postMessage({status:error.status||500,code:error.code,elapsedMs:performance.now()-started});}
  finally{db.close();parentPort.close();}
}
async function crashWriter(path){
  const f=await createAuditHarness({database:path,organizers:2,poolSize:1});
  const manager=f.managers[0],volunteer=f.volunteers[0];
  const task=await f.create(f.sessions[0],{title:'Задача перед жёстким перезапуском'});
  f.app.domain.assignTask(manager,task.id,{volunteerIds:[volunteer.id]});
  await f.bot.handleUpdate(f.callback(volunteer,'accept',task));
  const question=f.app.domain.createQuestion(manager,task.id,{body:'Нужен доступ к комнате.',tagIds:[f.tc,f.hall1],blocking:true});
  f.app.domain.replyQuestion(f.managers[1],question.id,{body:'Доступ уточняется.'});
  const snapshot={taskId:task.id,managerId:manager.id,volunteerId:volunteer.id,history:f.app.domain.task(manager,task.id).history.length,outbox:f.app.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n};
  f.app.db.exec('BEGIN IMMEDIATE');
  f.app.db.prepare("UPDATE tasks SET title='НЕЗАФИКСИРОВАННОЕ ИЗМЕНЕНИЕ' WHERE id=?").run(task.id);
  f.app.db.prepare('UPDATE users SET available=0 WHERE id=?').run(volunteer.id);
  process.send(snapshot);setInterval(()=>{},1000);
}

if(!isMainThread) await workerRun();
else if(process.argv[2]==='--crash-writer') await crashWriter(process.argv[3]);
else if(process.argv[1]&&resolve(process.argv[1])===me){
  const mode=process.argv.includes('--tcp')?'tcp':'handler';
  const result={measuredAt:new Date().toISOString(),node:process.version,liveTelegram:false};
  try{
    const urlIndex=process.argv.indexOf('--url'),tokenIndex=process.argv.indexOf('--audit-token');
    result.requestLoad=urlIndex===-1?await runHandlerStress({mode}):await runExternalStress({url:process.argv[urlIndex+1],auditToken:tokenIndex===-1?'':process.argv[tokenIndex+1]});
    result.resourceProbe=await runResourceProbe();
    result.sqliteContention=await runWorkerContention();
    result.crashRecovery=await runCrashRecovery();
    await new Promise(resolve=>setImmediate(resolve));
    if(global.gc){global.gc();result.afterCleanup={includesWorkerRuntimeHighWater:true,heapMiB:mb(process.memoryUsage().heapUsed),rssMiB:mb(process.memoryUsage().rss),activeResources:process.getActiveResourcesInfo()};}
    result.ok=true;
  }catch(error){result.ok=false;result.error={code:error.code||null,message:error.message};process.exitCode=1;}
  const output=JSON.stringify(result,null,2)+'\n';
  const fileFlag=process.argv.indexOf('--output');if(fileFlag!==-1)writeFileSync(process.argv[fileFlag+1],output);
  process.stdout.write(output);
}
