import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../lib/db.js';
import {Domain} from '../lib/domain.js';
import {TelegramBot} from '../lib/telegram.js';

function fixture(t) {
  const db=openDatabase(':memory:');
  const domain=new Domain(db);
  const add=(id,roles,tagIds=[],home=null,pool=null)=>db.prepare('INSERT INTO users(id,name,login,roles,tag_ids,home_hall_id,manager_id) VALUES(?,?,?,?,?,?,?)').run(id,`Участник ${id}`,`user${id}`,JSON.stringify(roles),JSON.stringify(tagIds),home,pool);
  const hall1=domain.tags().find(t=>t.name==='Hall 1').id,hall2=domain.tags().find(t=>t.name==='Hall 2').id;
  add(1,['admin','organizer']);add(2,['manager','organizer'],[hall1],hall1);add(3,['manager','organizer'],[hall2],hall2);add(4,['volunteer'],[],null,2);
  db.prepare('UPDATE users SET telegram_id=501,chat_id=501 WHERE id=4').run();
  const user=id=>domain.user(id);
  const create=(input={})=>domain.createTask(user(2),{title:'Проверить оборудование',hallIds:[hall1],...input})[0];
  const calls=[];let messageId=100;
  const bot=new TelegramBot({db,domain,token:'TEST_ONLY',username:'isolated_fixture_bot',fetchImpl:async(url,options)=>{
    const method=url.split('/').at(-1),payload=JSON.parse(options.body);calls.push({method,payload});
    return new Response(JSON.stringify({ok:true,result:method==='sendMessage'?{message_id:++messageId}:true}),{status:200});
  }});
  t.after(async()=>{await bot.stop();db.close();});
  return {db,domain,hall1,hall2,user,create,bot,calls};
}

test('E2E regression: блокировка скрывает reset capability, сохраняя разрешённую отмену',t=>{
  const f=fixture(t),task=f.create();f.domain.claimTask(f.user(2),task.id);
  const question=f.domain.createQuestion(f.user(2),task.id,{body:'Нет доступа',blocking:true});
  const blocked=f.domain.task(f.user(2),task.id);
  assert.equal(blocked.canReset,false);
  assert.equal(blocked.canCancel,true);
  assert.throws(()=>f.domain.resetTask(f.user(2),task.id,'Сменить исполнителя'),{status:409});
  f.domain.closeQuestion(f.user(2),question.id,{});
  assert.equal(f.domain.task(f.user(2),task.id).canReset,true);
});

test('E2E regression: capabilities отмены и возврата согласованы с терминальными статусами и доступом',t=>{
  const f=fixture(t),task=f.create();
  assert.equal(f.domain.task(f.user(2),task.id).canReset,true);
  assert.equal(f.domain.task(f.user(2),task.id).canCancel,true);
  assert.equal(f.domain.task(f.user(3),task.id).canReset,false);
  assert.equal(f.domain.task(f.user(3),task.id).canCancel,false);
  f.domain.cancelTask(f.user(2),task.id,'Отменена тестом');
  assert.equal(f.domain.task(f.user(2),task.id).canReset,false);
  assert.equal(f.domain.task(f.user(2),task.id).canCancel,false);
  const done=f.create();f.domain.claimTask(f.user(2),done.id);f.domain.completeTask(f.user(2),done.id);
  assert.equal(f.domain.task(f.user(2),done.id).canReset,false);
  assert.equal(f.domain.task(f.user(2),done.id).canCancel,false);
});

test('E2E regression: собственный вопрос и ответы различают одинаковые задачи разных холлов',async t=>{
  const f=fixture(t);f.domain.adminSettings(f.user(1),{crossHall:true});
  const tasks=f.domain.createTask(f.user(2),{title:'Одинаковая задача',hallIds:[f.hall1,f.hall2]});
  let updateId=1;
  for(const task of tasks){
    f.domain.assignTask(f.user(2),task.id,{volunteerIds:[4]});
    await f.bot.handleUpdate({update_id:updateId++,callback_query:{id:`question-${task.id}`,from:{id:501},message:{message_id:1,chat:{id:501,type:'private'}},data:`question:${task.id}:${task.generation}`}});
    await f.bot.handleUpdate({update_id:updateId++,message:{message_id:updateId,from:{id:501},chat:{id:501,type:'private'},text:'Куда принести оборудование?'}});
  }
  await f.bot.drainOutbox();
  const questions=f.domain.listQuestions(f.user(2),{box:'volunteer'});
  for(const question of questions){
    const task=tasks.find(t=>t.id===question.taskId);
    const hall=f.domain.tags().find(t=>t.id===task.hallId).name;
    const ack=f.calls.find(c=>c.method==='sendMessage'&&c.payload.text.startsWith('Вопрос отправлен менеджеру.')&&c.payload.text.includes(`Вопрос #${question.id}`));
    assert.ok(ack,`Волонтёр должен получить номер своего вопроса ${question.id}`);
    assert.ok(ack.payload.text.includes(`Задача №${task.id}`));assert.ok(ack.payload.text.includes(hall));
    assert.ok(ack.payload.text.includes(`/reply ${question.id} `));
    f.domain.replyQuestion(f.user(2),question.id,{body:'Принесите к стойке.'});
    f.domain.closeQuestion(f.user(2),question.id,{body:'Оборудование получено.'});
  }
  await f.bot.drainOutbox();
  for(const question of questions){
    const task=tasks.find(t=>t.id===question.taskId),hall=f.domain.tags().find(t=>t.id===task.hallId).name;
    const direct=f.calls.filter(c=>c.method==='sendMessage'&&c.payload.text.includes(`Вопрос #${question.id}`)&&(/Ответ менеджера/.test(c.payload.text)||/Оборудование получено/.test(c.payload.text)));
    assert.equal(direct.length,2);
    assert.ok(direct.every(c=>c.payload.text.includes(`Задача №${task.id}`)&&c.payload.text.includes(hall)));
    const final=direct.find(c=>c.payload.text.includes('Оборудование получено.'));
    assert.ok(!final.payload.text.includes('/reply'));
  }
});
