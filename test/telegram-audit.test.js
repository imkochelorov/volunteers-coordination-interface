import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../lib/db.js';
import { Domain } from '../lib/domain.js';
import { TelegramBot } from '../lib/telegram.js';

function fixture(t) {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  const domain = new Domain(db);
  db.prepare(`INSERT INTO users(id,name,login,roles,tag_ids) VALUES(1,'Администратор','admin','["admin"]','[]')`).run();
  const admin = domain.user(1);
  const manager = domain.adminSaveUser(admin,{name:'Менеджер',login:'manager',roles:['manager']});
  const a = domain.adminSaveUser(admin,{name:'Волонтёр А',roles:['volunteer'],managerId:manager.id});
  const b = domain.adminSaveUser(admin,{name:'Волонтёр Б',roles:['volunteer'],managerId:manager.id});
  const calls=[];
  let fail = () => null;
  const bot = new TelegramBot({db,domain,token:'LOCAL_TEST',username:'test_bot',fetchImpl:async(url,request)=>{
    const method=url.split('/').at(-1), payload=JSON.parse(request.body);
    calls.push({method,...payload});
    const error = fail(method,payload,calls);
    if(error)return {ok:false,status:error.error_code,json:async()=>({ok:false,...error})};
    return {ok:true,status:200,json:async()=>({ok:true,result:method==='sendMessage'?{message_id:calls.length}:true})};
  }});
  let sequence=0;
  const message = (telegramId,text) => ({update_id:++sequence,message:{from:{id:telegramId},chat:{id:telegramId,type:'private'},text}});
  const callback = (telegramId,data,callbackId) => ({update_id:++sequence,callback_query:{id:callbackId || `cb:${sequence}`,from:{id:telegramId},message:{chat:{id:telegramId,type:'private'},message_id:1},data}});
  const connect=async(user,telegramId)=>{const invite=bot.createLink(manager,user.id);await bot.handleUpdate(message(telegramId,`/start ${new URL(invite.url).searchParams.get('start')}`));};
  const create = () => domain.createTask(manager,{title:'Проверить оборудование'})[0];
  return {db,domain,admin,manager,a,b,calls,bot,message,callback,connect,create,fail(fn){fail=fn;}};
}

test('callback_query.id дедуплицируется даже в другом update_id, включая подсказку вопроса',async t=>{
  const f=fixture(t); await f.connect(f.a,501);
  const task=f.create(); f.domain.assignTask(f.manager,task.id,{volunteerIds:[f.a.id]});
  const first=f.callback(501,`question:${task.id}:${task.generation}`,'same-callback');
  await f.bot.handleUpdate(first);
  const duplicate=f.callback(501,first.callback_query.data,'same-callback');
  const result=await f.bot.handleUpdate(duplicate);
  assert.equal(result.duplicate,true);
  const prompts=f.db.prepare(`SELECT payload FROM outbox WHERE kind='message'`).all().filter(x=>JSON.parse(x.payload).text.includes('Отправьте текст следующим'));
  assert.equal(prompts.length,1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM telegram_updates').get().n,3);
});

test('Telegram ID отключённого аккаунта не отравляет обработку следующих обновлений',async t=>{
  const f=fixture(t); await f.connect(f.a,501);
  f.db.prepare('UPDATE users SET active=0 WHERE id=?').run(f.a.id);
  const invitation=f.bot.createLink(f.manager,f.b.id);
  const event=f.message(501,`/start ${new URL(invitation.url).searchParams.get('start')}`);
  const result=await f.bot.handleUpdate(event);
  assert.equal(result.show_alert,true);
  assert.match(result.text,/другим|связан/);
  assert.ok(f.db.prepare('SELECT 1 FROM telegram_updates WHERE update_id=?').get(event.update_id));
  assert.equal(f.domain.user(f.b.id).telegramId,null);
  await f.bot.handleUpdate(f.message(999,'/help'));
});

test('повтор длинного сообщения после ошибки не дублирует уже доставленные части',async t=>{
  const f=fixture(t); await f.connect(f.a,501); await f.bot.drainOutbox(); f.calls.length=0;
  f.bot.enqueue('long',f.a.id,'A'.repeat(3800)+'B'.repeat(200));
  let attempts=0;
  f.fail(method=>method==='sendMessage' && ++attempts===2 ? {error_code:403,description:'Forbidden'} : null);
  await f.bot.drainOutbox();
  const failed=f.db.prepare(`SELECT * FROM outbox WHERE event_key='long'`).get();
  assert.equal(failed.status,'failed');
  f.domain.retryDelivery(f.manager,failed.id);
  await f.bot.drainOutbox();
  const starts=f.calls.filter(c=>c.method==='sendMessage').map(c=>c.text[0]);
  assert.deepEqual(starts,['A','B','B']);
});

test('перед доставкой вопроса повторно проверяются текущие общие теги получателя',async t=>{
  const f=fixture(t); await f.connect(f.a,501); await f.bot.drainOutbox(); f.calls.length=0;
  const tc=f.domain.tags().find(x=>x.name==='TC').id;
  f.db.prepare('UPDATE users SET tag_ids=? WHERE id=?').run(JSON.stringify([tc]),f.a.id);
  const task=f.create();
  const q=f.domain.createQuestion(f.manager,task.id,{body:'Закрытые сведения',tagIds:[tc]});
  f.db.prepare('UPDATE users SET tag_ids=? WHERE id=?').run('[]',f.a.id);
  assert.equal(f.domain.canReadQuestion(f.domain.user(f.a.id),f.domain.rawQuestion(q.id)),false);
  await f.bot.drainOutbox();
  assert.equal(f.calls.filter(c=>c.method==='sendMessage' && c.text.includes('Закрытые сведения')).length,0);
  const job=f.db.prepare(`SELECT * FROM outbox WHERE kind='message' AND user_id=? AND event_key LIKE 'notification:%'`).get(f.a.id);
  assert.equal(job.status,'cancelled');
});

test('429 останавливает очередь на retry_after, остальные задания не штурмуют API',async t=>{
  const f=fixture(t); await f.connect(f.a,501); await f.bot.drainOutbox(); f.calls.length=0;
  f.bot.enqueue('one',f.a.id,'Первое'); f.bot.enqueue('two',f.a.id,'Второе');
  let once=true;
  f.fail(method=>method==='sendMessage' && once ? (once=false,{error_code:429,description:'Too many requests',parameters:{retry_after:30}}) : null);
  await f.bot.drainOutbox(); await f.bot.drainOutbox();
  assert.equal(f.calls.filter(c=>c.method==='sendMessage').length,1);
  assert.equal(f.db.prepare(`SELECT status FROM outbox WHERE event_key='two'`).get().status,'pending');
});

test('длинные сообщения не разрывают Unicode-символы на границе частей',async t=>{
  const f=fixture(t); await f.connect(f.a,501); await f.bot.drainOutbox(); f.calls.length=0;
  f.bot.enqueue('unicode',f.a.id,'A'.repeat(3799)+'😀'+'Z');
  await f.bot.drainOutbox();
  const parts=f.calls.filter(c=>c.method==='sendMessage').map(c=>c.text);
  assert.ok(parts.every(text=>text.isWellFormed()));
  assert.equal(parts.join(''),'A'.repeat(3799)+'😀'+'Z');
});

test('после пятидесяти назначений /tasks позволяет открыть следующую страницу',async t=>{
  const f=fixture(t); await f.connect(f.a,501);
  const first=f.create(); f.domain.assignTask(f.manager,first.id,{volunteerIds:[f.a.id]});
  for(let i=0;i<50;i++){const task=f.create();f.domain.assignTask(f.manager,task.id,{volunteerIds:[f.a.id]});}
  f.db.prepare('DELETE FROM outbox').run();
  await f.bot.handleUpdate(f.message(501,'/tasks 2'));
  const response=f.db.prepare(`SELECT payload FROM outbox WHERE kind='message' ORDER BY id DESC LIMIT 1`).get();
  assert.match(JSON.parse(response.payload).text,/Страница 2/);
  assert.ok(f.db.prepare(`SELECT 1 FROM outbox WHERE kind='task' AND task_id=?`).get(first.id));
});

test('отмена задачи очищает ввод вопроса, а старые кнопки принятия и завершения не меняют финал',async t=>{
  const f=fixture(t); await f.connect(f.a,501);
  const task=f.create(); f.domain.assignTask(f.manager,task.id,{volunteerIds:[f.a.id]});
  await f.bot.handleUpdate(f.callback(501,`question:${task.id}:${task.generation}`));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM telegram_state').get().n,1);
  f.domain.cancelTask(f.manager,task.id,'Больше не требуется');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM telegram_state').get().n,0);
  for(const action of ['accept','complete','question']){
    const result=await f.bot.handleUpdate(f.callback(501,`${action}:${task.id}:${task.generation}`));
    assert.equal(result.show_alert,true);
  }
  assert.equal(f.domain.task(f.manager,task.id).status,'cancelled');
});

test('карточка и продолжение описания не разрывают Unicode на границе',async t=>{
  const f=fixture(t); await f.connect(f.a,501);
  const task=f.create(); f.domain.assignTask(f.manager,task.id,{volunteerIds:[f.a.id]});
  const baseline=f.bot.taskCard(task.id,f.a.id,task.generation);
  const room=3897-baseline.text.length;
  const description='A'.repeat(room-1)+'😀'+'B';
  f.db.prepare('UPDATE tasks SET description=? WHERE id=?').run(description,task.id);
  const card=f.bot.taskCard(task.id,f.a.id,task.generation);
  assert.ok(card.text.isWellFormed()); assert.ok(card.remainder.isWellFormed());
  assert.equal(card.text.split('\n\n')[1]+card.remainder,description);
});

test('снятое назначение не получает новое содержание карточки или оставшееся описание',async t=>{
  const f=fixture(t); await f.connect(f.a,501); await f.bot.drainOutbox();
  const task=f.create();
  f.db.prepare('UPDATE tasks SET description=? WHERE id=?').run('A'.repeat(5000),task.id);
  f.domain.assignTask(f.manager,task.id,{volunteerIds:[f.a.id]});
  await f.bot.drainOutbox();
  f.domain.resetTask(f.manager,task.id,'Смена команды');
  f.db.prepare('UPDATE tasks SET title=?,description=? WHERE id=?').run('Новые закрытые сведения','Новый текст',task.id);
  f.calls.length=0;
  await f.bot.drainOutbox();
  const stale=f.bot.taskCard(task.id,f.a.id,task.generation);
  assert.ok(!stale.text.includes('Новые закрытые сведения'));
  assert.deepEqual(stale.reply_markup.inline_keyboard,[]);
  assert.equal(f.calls.filter(c=>c.method==='sendMessage').length,0);
  assert.equal(f.db.prepare(`SELECT status FROM outbox WHERE event_key LIKE 'task-description:%'`).get().status,'cancelled');
});

test('потеря доступа во время многочастной отправки останавливает следующие части',async t=>{
  const f=fixture(t); await f.connect(f.a,501); await f.bot.drainOutbox(); f.calls.length=0;
  f.bot.enqueue('mid-delivery',f.a.id,'A'.repeat(3800)+'B');
  f.fail(method=>{if(method==='sendMessage')f.db.prepare('UPDATE users SET active=0 WHERE id=?').run(f.a.id);return null;});
  await f.bot.drainOutbox();
  assert.equal(f.calls.filter(c=>c.method==='sendMessage').length,1);
  assert.equal(f.db.prepare(`SELECT status FROM outbox WHERE event_key='mid-delivery'`).get().status,'cancelled');
});

test('нетекстовое повреждённое событие не блокирует следующие обновления polling',async t=>{
  const f=fixture(t); await f.connect(f.a,501);
  const event=f.message(501,{unexpected:'value'});
  await f.bot.handleUpdate(event);
  assert.ok(f.db.prepare('SELECT 1 FROM telegram_updates WHERE update_id=?').get(event.update_id));
  await f.bot.handleUpdate(f.message(501,'/unavailable'));
  assert.equal(f.domain.user(f.a.id).available,false);
});

test('множество refresh-заданий схлопываются, а изменение во время edit остаётся в очереди',async t=>{
  const f=fixture(t); await f.connect(f.a,501); await f.bot.drainOutbox();
  const task=f.create(); f.domain.assignTask(f.manager,task.id,{volunteerIds:[f.a.id]});
  await f.bot.drainOutbox();
  f.domain.acceptTask(f.domain.user(f.a.id),task.id,task.generation);
  for(let i=0;i<100;i++) f.domain.refresh(task.id);
  f.calls.length=0;
  let once=true;
  f.fail(method=>{if(method==='editMessageText' && once){once=false;f.domain.completeTask(f.domain.user(f.a.id),task.id,task.generation);}return null;});
  await f.bot.drainOutbox();
  assert.equal(f.calls.filter(c=>c.method==='editMessageText').length,1);
  assert.equal(f.db.prepare(`SELECT count(*) AS n FROM outbox WHERE status='pending' AND kind='task'`).get().n,1);
  await f.bot.drainOutbox();
  const edits=f.calls.filter(c=>c.method==='editMessageText');
  assert.equal(edits.length,2);
  assert.match(edits.at(-1).text,/Выполнена/);
  assert.deepEqual(edits.at(-1).reply_markup.inline_keyboard,[]);
  assert.equal(f.db.prepare(`SELECT count(*) AS n FROM outbox WHERE status='pending' AND kind='task'`).get().n,0);
});

test('прерванное processing-задание восстанавливается при следующем запуске очереди',async t=>{
  const f=fixture(t); await f.connect(f.a,501); await f.bot.drainOutbox(); f.calls.length=0;
  const task=f.create(); f.domain.assignTask(f.manager,task.id,{volunteerIds:[f.a.id]});
  f.db.prepare(`UPDATE outbox SET status='processing' WHERE kind='task'`).run();
  await f.bot.drainOutbox();
  assert.equal(f.calls.filter(c=>c.method==='sendMessage' && c.reply_markup).length,1);
  assert.equal(f.db.prepare(`SELECT status FROM outbox WHERE kind='task'`).get().status,'sent');
  assert.equal(f.domain.task(f.manager,task.id).assignments.length,1);
});

test('неожиданная ошибка домена подтверждает callback и оставляет событие для безопасного повтора',async t=>{
  const f=fixture(t); await f.connect(f.a,501);
  const task=f.create(); f.domain.assignTask(f.manager,task.id,{volunteerIds:[f.a.id]});
  const event=f.callback(501,`accept:${task.id}:${task.generation}`);
  const original=f.domain.acceptTask;
  f.domain.acceptTask=()=>{throw new Error('temporary database fault');};
  await assert.rejects(f.bot.handleUpdate(event),{status:503});
  assert.ok(f.calls.some(c=>c.method==='answerCallbackQuery' && c.callback_query_id===event.callback_query.id && c.show_alert));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM telegram_updates WHERE update_id=?').get(event.update_id).n,0);
  f.domain.acceptTask=original;
  await f.bot.handleUpdate(event);
  assert.equal(f.domain.task(f.manager,task.id).status,'in_progress');
});

test('история привязки сохраняет действия, но не сохраняет секрет приглашения и Telegram ID',async t=>{
  const f=fixture(t);
  const link=f.bot.createLink(f.manager,f.a.id);
  const token=new URL(link.url).searchParams.get('start');
  await f.bot.handleUpdate(f.message(501,`/start ${token}`));
  const records=f.db.prepare(`SELECT * FROM activity WHERE event IN ('Создано приглашение Telegram','Telegram подключён') ORDER BY id`).all();
  assert.equal(records.length,2);
  assert.equal(records[0].actor_id,f.manager.id);
  assert.equal(records[1].actor_id,f.a.id);
  assert.ok(!JSON.stringify(records).includes(token));
  assert.ok(!JSON.stringify(records.map(record=>JSON.parse(record.data))).includes('501'));
});

test('явный итог группе доставляется каждому один раз без доступа к частной истории вопроса',async t=>{
  const f=fixture(t); await f.connect(f.a,501); await f.connect(f.b,502); await f.bot.drainOutbox();
  const task=f.create(); f.domain.assignTask(f.manager,task.id,{volunteerIds:[f.a.id,f.b.id]}); await f.bot.drainOutbox();
  const q=f.domain.createQuestion(f.domain.user(f.a.id),task.id,{body:'Частная история вопроса'},task.generation);
  assert.equal(f.domain.canReadQuestion(f.domain.user(f.b.id),f.domain.rawQuestion(q.id)),false);
  f.calls.length=0;
  f.domain.closeQuestion(f.manager,q.id,{body:'Общий итог для команды',sendToVolunteers:true});
  await f.bot.drainOutbox();
  const delivered=f.calls.filter(call=>call.method==='sendMessage' && call.text.includes('Общий итог для команды'));
  assert.deepEqual(delivered.map(call=>call.chat_id).sort(),[501,502]);
  assert.equal(f.domain.canReadQuestion(f.domain.user(f.b.id),f.domain.rawQuestion(q.id)),false);
  assert.throws(()=>f.domain.replyQuestion(f.domain.user(f.b.id),q.id,{body:'Ответ'}),{status:403});
  assert.ok(!f.calls.some(call=>call.chat_id===502 && call.text?.includes('Частная история вопроса')));
});

test('снятое назначение отменяет ожидающий групповой итог для постороннего обсуждению волонтёра',async t=>{
  const f=fixture(t); await f.connect(f.a,501); await f.connect(f.b,502); await f.bot.drainOutbox();
  const task=f.create(); f.domain.assignTask(f.manager,task.id,{volunteerIds:[f.a.id,f.b.id]}); await f.bot.drainOutbox();
  const q=f.domain.createQuestion(f.domain.user(f.a.id),task.id,{body:'Частный вопрос'},task.generation);
  f.domain.closeQuestion(f.manager,q.id,{body:'Устаревший групповой итог',sendToVolunteers:true});
  f.domain.resetTask(f.manager,task.id,'Новая команда');
  f.calls.length=0; await f.bot.drainOutbox();
  assert.ok(!f.calls.some(call=>call.chat_id===502 && call.text?.includes('Устаревший групповой итог')));
  const final=f.db.prepare(`SELECT status FROM outbox WHERE kind='message' AND user_id=? AND json_extract(payload,'$.sharedResolution')=1`).get(f.b.id);
  assert.equal(final.status,'cancelled');
});

test('групповой итог не обходит закрытие вопроса, поколение назначения и привязку к задаче',async t=>{
  const f=fixture(t); await f.connect(f.a,501); await f.connect(f.b,502); await f.bot.drainOutbox();
  const task=f.create(); f.domain.assignTask(f.manager,task.id,{volunteerIds:[f.a.id,f.b.id]});
  const q=f.domain.createQuestion(f.domain.user(f.a.id),task.id,{body:'Закрытое обсуждение'},task.generation);
  const enqueue=(key,taskId,generation)=>f.domain.enqueue('message',f.b.id,taskId,{text:'Недопустимый групповой итог',questionId:q.id,sharedResolution:true,generation},key);
  enqueue('resolution-open',task.id,task.generation);
  await f.bot.drainOutbox();
  f.domain.closeQuestion(f.manager,q.id,{body:'Обычный ответ автору'});
  enqueue('resolution-wrong-generation',task.id,task.generation+1);
  const other=f.create(); f.domain.assignTask(f.manager,other.id,{volunteerIds:[f.b.id]});
  enqueue('resolution-wrong-task',other.id,other.generation);
  await f.bot.drainOutbox();
  assert.ok(!f.calls.some(call=>call.chat_id===502 && call.text?.includes('Недопустимый групповой итог')));
  const jobs=f.db.prepare(`SELECT status FROM outbox WHERE event_key LIKE 'resolution-%'`).all();
  assert.equal(jobs.length,3); assert.ok(jobs.every(job=>job.status==='cancelled'));
  assert.equal(f.domain.canReadQuestion(f.domain.user(f.b.id),f.domain.rawQuestion(q.id)),false);
});
