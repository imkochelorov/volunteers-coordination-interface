import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../lib/db.js';
import { Domain } from '../lib/domain.js';

function fixture(t) {
  const db=openDatabase(':memory:'); t.after(()=>db.close());
  const domain=new Domain(db);
  const hall1=domain.tags().find(x=>x.name==='Hall 1').id;
  const hall2=domain.tags().find(x=>x.name==='Hall 2').id;
  const tc=domain.tags().find(x=>x.name==='TC').id;
  const add=(id,roles,tagIds=[],home=null,pool=null)=>db.prepare('INSERT INTO users(id,name,login,roles,tag_ids,home_hall_id,manager_id) VALUES(?,?,?,?,?,?,?)').run(id,`Участник ${id}`,`user${id}`,JSON.stringify(roles),JSON.stringify(tagIds),home,pool);
  add(1,['admin','organizer']);
  add(2,['manager','organizer'],[hall1],hall1);
  add(3,['manager','organizer'],[hall2],hall2);
  add(4,['volunteer'],[],null,2);
  add(5,['volunteer'],[],null,2);
  add(6,['organizer'],[tc]);
  add(7,['organizer','volunteer'],[hall2],hall2,2);
  const u=id=>domain.user(id);
  const create=(input={},actor=2)=>domain.createTask(u(actor),{title:'Проверить оборудование',tagIds:[],...input})[0];
  const rejects=(fn,status)=>assert.throws(fn,e=>e.status===status);
  return {db,domain,hall1,hall2,tc,u,create,rejects};
}

test('закрыть блокирующий вопрос может только его автор/передавший менеджер, не чужой администратор',t=>{
  const f=fixture(t), task=f.create();
  const q=f.domain.createQuestion(f.u(2),task.id,{body:'Нет доступа',tagIds:[f.tc],blocking:true});
  f.rejects(()=>f.domain.closeQuestion(f.u(1),q.id,{}),403);
  assert.equal(f.domain.task(f.u(2),task.id).blocked,true);
  f.domain.closeQuestion(f.u(2),q.id,{});
  assert.equal(f.domain.task(f.u(2),task.id).blocked,false);
});

test('завершение не обходит открытые блокировки; закрытие одного вопроса не закрывает другой и не завершает задачу',t=>{
  const f=fixture(t), task=f.create();
  f.domain.claimTask(f.u(2),task.id);
  const first=f.domain.createQuestion(f.u(2),task.id,{body:'Нет ключа',blocking:true,tagIds:[f.tc]});
  const second=f.domain.createQuestion(f.u(2),task.id,{body:'Нет питания',blocking:true,tagIds:[f.tc]});
  f.domain.replyQuestion(f.u(6),first.id,{body:'Ключ принесли'});
  f.rejects(()=>f.domain.completeTask(f.u(2),task.id),409);
  f.domain.closeQuestion(f.u(2),first.id,{});
  f.rejects(()=>f.domain.completeTask(f.u(2),task.id),409);
  f.domain.closeQuestion(f.u(2),second.id,{});
  assert.equal(f.domain.task(f.u(2),task.id).status,'in_progress');
  assert.equal(f.domain.completeTask(f.u(2),task.id).status,'done');
});

test('выключенный флаг чужого холла проверяется при завершении самостоятельно взятой задачи',t=>{
  const f=fixture(t), task=f.create({hallIds:[f.hall2]},1);
  f.domain.adminSettings(f.u(1),{crossHall:true});
  f.domain.claimTask(f.u(2),task.id);
  f.domain.adminSettings(f.u(1),{crossHall:false});
  f.rejects(()=>f.domain.completeTask(f.u(2),task.id),403);
  assert.equal(f.domain.task(f.u(2),task.id).status,'in_progress');
});

test('волонтёр с совмещённой ролью выполняет назначение через бот, независимо от флага чужого холла',t=>{
  const f=fixture(t), task=f.create({hallIds:[f.hall1]});
  const assigned=f.domain.assignTask(f.u(2),task.id,{volunteerIds:[7]});
  f.domain.acceptTask(f.u(7),task.id,assigned.generation);
  f.rejects(()=>f.domain.completeTask(f.u(7),task.id),403);
  assert.equal(f.domain.completeTask(f.u(7),task.id,assigned.generation).status,'done');
});

test('групповая задача не завершается волонтёром до закрытия всех блокирующих обсуждений',t=>{
  const f=fixture(t), task=f.create();
  const assigned=f.domain.assignTask(f.u(2),task.id,{volunteerIds:[4,5]});
  f.domain.acceptTask(f.u(4),task.id,assigned.generation);
  const q=f.domain.createQuestion(f.u(4),task.id,{body:'Не можем пройти'},assigned.generation);
  f.domain.forwardQuestion(f.u(2),q.id,{blocking:true,tagIds:[f.tc]});
  f.rejects(()=>f.domain.completeTask(f.u(5),task.id,assigned.generation),409);
  assert.equal(f.domain.task(f.u(2),task.id).assignments.length,2);
  f.domain.closeQuestion(f.u(2),q.id,{});
  assert.equal(f.domain.completeTask(f.u(5),task.id,assigned.generation).status,'done');
});

test('идентификаторы и флаги не принимают JSON-coercion; невалидный запрос не создаёт публикаций',t=>{
  const f=fixture(t); f.create();
  for(const value of [true,[1],{},'1e0']) f.rejects(()=>f.domain.task(f.u(1),value),400);
  for(const input of [{allHalls:'false'},{allHalls:1},{tagIds:[true]},{hallIds:[[f.hall1]]}]) f.rejects(()=>f.create(input),400);
  assert.equal(f.domain.listTasks(f.u(1)).length,1);
});

test('некорректная блокировка и срочность вопроса возвращают 400 вместо скрытого изменения смысла',t=>{
  const f=fixture(t), task=f.create();
  f.rejects(()=>f.domain.createQuestion(f.u(2),task.id,{body:'Уточнение',blocking:'false'}),400);
  f.rejects(()=>f.domain.createQuestion(f.u(2),task.id,{body:'Уточнение',urgency:'critical'}),400);
  const q=f.domain.createQuestion(f.u(4),f.domain.assignTask(f.u(2),task.id,{volunteerIds:[4]}).id,{body:'Помогите'},1);
  f.rejects(()=>f.domain.forwardQuestion(f.u(2),q.id,{blocking:'false',tagIds:[f.tc]}),400);
  assert.equal(f.domain.task(f.u(2),task.id).blocked,false);
});

test('нельзя отключить менеджера или снять роль, пока активные волонтёры закреплены за его пулом',t=>{
  const f=fixture(t);
  f.rejects(()=>f.domain.adminSaveUser(f.u(1),{id:2,active:false}),409);
  f.rejects(()=>f.domain.adminSaveUser(f.u(1),{id:2,roles:['organizer']}),409);
  f.rejects(()=>f.domain.adminSaveUser(f.u(1),{id:4,active:'false'}),400);
  assert.equal(f.domain.user(2).active,true);
});

test('основной холл входит в общие теги и получает адресованные холлу вопросы',t=>{
  const f=fixture(t);
  const manager=f.domain.adminSaveUser(f.u(1),{name:'Менеджер',login:'new-manager',roles:['manager'],tagIds:[],homeHallId:f.hall1});
  assert.ok(manager.tagIds.includes(f.hall1));
  const q=f.domain.createQuestion(f.u(2),f.create().id,{body:'Кто поможет?',tagIds:[f.hall1]});
  assert.ok(q.recipientIds.includes(manager.id));
});

test('менеджер с единственным тегом холла имеет корректную основную очередь; несколько холлов требуют выбора',t=>{
  const f=fixture(t);
  f.db.prepare('UPDATE users SET home_hall_id=NULL WHERE id=2').run();
  const own=f.create({hallIds:[f.hall1]}), other=f.create({hallIds:[f.hall2]},1);
  assert.equal(f.domain.user(2).homeHallId,f.hall1);
  assert.deepEqual(f.domain.listTasks(f.u(2),{scope:'home'}).map(x=>x.id),[own.id]);
  assert.ok(!f.domain.listTasks(f.u(2),{scope:'home'}).some(x=>x.id===other.id));
  f.rejects(()=>f.domain.adminSaveUser(f.u(1),{name:'Без основного',login:'ambiguous',roles:['manager'],tagIds:[f.hall1,f.hall2]}),400);
});

test('возврат в очередь сохраняет полный снимок прежних назначений и очищает устаревший ввод бота',t=>{
  const f=fixture(t), task=f.create();
  f.domain.assignTask(f.u(2),task.id,{volunteerIds:[4,5]});
  const before=f.domain.acceptTask(f.u(4),task.id,1);
  f.db.prepare('INSERT INTO telegram_state(user_id,task_id,generation) VALUES(4,?,1)').run(task.id);
  const reset=f.domain.resetTask(f.u(2),task.id,'Нужна другая команда');
  const event=reset.history.find(x=>x.event==='Задача возвращена в очередь');
  assert.equal(event.data.previous.status,'in_progress');
  assert.equal(event.data.previous.assignedBy,2);
  assert.deepEqual(event.data.previous.assignments,before.assignments.map(a=>({...a})));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM telegram_state WHERE task_id=?').get(task.id).n,0);
});

test('доставка, отменённая из-за отзыва доступа, не возобновляется обычным ретраем',t=>{
  const f=fixture(t), task=f.create();
  f.domain.assignTask(f.u(2),task.id,{volunteerIds:[4]});
  const row=f.db.prepare('SELECT id FROM outbox WHERE task_id=? LIMIT 1').get(task.id);
  f.db.prepare("UPDATE outbox SET status='cancelled' WHERE id=?").run(row.id);
  f.rejects(()=>f.domain.retryDelivery(f.u(2),row.id),409);
  assert.equal(f.db.prepare('SELECT status FROM outbox WHERE id=?').get(row.id).status,'cancelled');
});

test('возврат заблокированной задачи в свободную очередь невозможен до явного решения вопросов',t=>{
  const f=fixture(t), task=f.create();
  f.domain.assignTask(f.u(2),task.id,{volunteerIds:[4]});
  const q=f.domain.createQuestion(f.u(4),task.id,{body:'Нет доступа'},1);
  f.domain.forwardQuestion(f.u(2),q.id,{tagIds:[f.tc],blocking:true});
  f.rejects(()=>f.domain.resetTask(f.u(2),task.id,'Сменить исполнителей'),409);
  assert.equal(f.domain.task(f.u(2),task.id).assignments.length,1);
  assert.equal(f.domain.listQuestions(f.u(2),{box:'outgoing'}).find(x=>x.id===q.id).state,'open');
  f.domain.closeQuestion(f.u(2),q.id,{});
  assert.equal(f.domain.resetTask(f.u(2),task.id,'Теперь можно сменить исполнителей').assignments.length,0);
});

test('журнал действий сохраняет администрирование, личные теги и доступность без секретов',t=>{
  const f=fixture(t);
  f.domain.adminSettings(f.u(1),{crossHall:true});
  f.domain.adminSaveTag(f.u(1),{name:'Новый холл',kind:'hall'});
  f.domain.setPersonalTags(f.u(2),4,{names:['Монтаж']});
  f.domain.setAvailability(f.u(4),false);
  f.domain.adminSaveUser(f.u(1),{id:4,managerId:3});
  const rows=f.db.prepare('SELECT * FROM activity ORDER BY id').all();
  assert.equal(rows.length,5);
  assert.ok(rows.every(row=>row.actor_id&&row.entity_type&&row.event&&row.created_at));
  const poolChange=rows.find(row=>row.event==='Пользователь изменён');
  const data=JSON.parse(poolChange.data);
  assert.equal(data.before.managerId,2);
  assert.equal(data.after.managerId,3);
  f.domain.logActivity(1,'Проверка редактирования',{password:'private-password',nested:{token:'private-token',note:'visible'}},'user',4);
  const raw=f.db.prepare('SELECT data FROM activity ORDER BY id DESC LIMIT 1').get().data;
  assert.equal(raw.includes('private-'),false);
  assert.ok(raw.includes('visible'));
});

test('новый журнал переживает повторное открытие файла, а будущая версия базы не понижается',async t=>{
  const {mkdtempSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const {DatabaseSync}=await import('node:sqlite');
  const directory=mkdtempSync(join(tmpdir(),'nerc-activity-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const path=join(directory,'audit.sqlite');
  let db=openDatabase(path);
  db.prepare("INSERT INTO users(id,name,roles,tag_ids) VALUES(1,'Администратор','[\"admin\"]','[]')").run();
  let domain=new Domain(db);
  domain.adminSettings(domain.user(1),{crossHall:true});
  db.close();
  db=openDatabase(path); domain=new Domain(db);
  assert.equal(domain.settings().crossHall,true);
  assert.equal(db.prepare('SELECT count(*) AS n FROM activity').get().n,1);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,2);
  db.exec('PRAGMA user_version=99'); db.close();
  assert.throws(()=>openDatabase(path),/новее/);
  db=new DatabaseSync(path);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,99);
  db.close();
});

test('серия обновлений объединяет только ожидающие карточки задачи, не теряет событие во время отправки',t=>{
  const f=fixture(t), task=f.create();
  f.domain.assignTask(f.u(2),task.id,{volunteerIds:[4,5]});
  for(let i=0;i<50;i++)f.domain.refresh(task.id);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM outbox WHERE task_id=? AND kind='task'").get(task.id).n,2);
  f.db.prepare("UPDATE outbox SET status='processing' WHERE task_id=? AND kind='task'").run(task.id);
  f.domain.refresh(task.id);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM outbox WHERE task_id=? AND kind='task' AND status='pending'").get(task.id).n,2);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM outbox WHERE task_id=? AND kind='task' AND status='processing'").get(task.id).n,2);
});

test('ретрай не перехватывает уже отправляемую карточку и не отменяет processing claim',t=>{
  const f=fixture(t), task=f.create();
  f.domain.assignTask(f.u(2),task.id,{volunteerIds:[4]});
  const row=f.db.prepare('SELECT id FROM outbox WHERE task_id=?').get(task.id);
  f.db.prepare("UPDATE outbox SET status='processing' WHERE id=?").run(row.id);
  f.rejects(()=>f.domain.retryDelivery(f.u(2),row.id),409);
  assert.equal(f.db.prepare('SELECT status FROM outbox WHERE id=?').get(row.id).status,'processing');
});

test('новое состояние задачи будит ранее неудачную доставку, сохраняя попытки и диагностику',t=>{
  const f=fixture(t), task=f.create();
  f.domain.assignTask(f.u(2),task.id,{volunteerIds:[4]});
  const row=f.db.prepare('SELECT id FROM outbox WHERE task_id=?').get(task.id);
  f.db.prepare("UPDATE outbox SET status='failed',next_attempt=?,attempts=8,last_error='Нет сети' WHERE id=?").run(Date.now()+3600000,row.id);
  f.domain.acceptTask(f.u(4),task.id,1);
  const updated=f.db.prepare('SELECT * FROM outbox WHERE id=?').get(row.id);
  assert.equal(updated.status,'pending');
  assert.equal(updated.next_attempt,0);
  assert.equal(updated.attempts,8);
  assert.equal(updated.last_error,'Нет сети');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM outbox WHERE task_id=?').get(task.id).n,1);
});

test('волонтёр-получатель вопроса получает весь текст без обрыва на границе emoji',t=>{
  const f=fixture(t);
  f.db.prepare('UPDATE users SET tag_ids=? WHERE id=4').run(JSON.stringify([f.tc]));
  const body='а'.repeat(2799)+'😀 Полное продолжение вопроса.';
  const task=f.create();
  const question=f.domain.createQuestion(f.u(2),task.id,{body,tagIds:[f.tc]});
  const jobs=f.db.prepare("SELECT payload FROM outbox WHERE user_id=4 AND kind='message'").all().map(row=>JSON.parse(row.payload)).filter(data=>data.questionId===question.id);
  assert.equal(jobs.length,1);
  assert.ok(jobs[0].text.includes(body));
});

test('переименование холла обновляет связанные Telegram-карточки, сохраняя поколение назначения',t=>{
  const f=fixture(t), task=f.create({hallIds:[f.hall1]});
  f.domain.assignTask(f.u(2),task.id,{volunteerIds:[4]});
  f.db.prepare("UPDATE outbox SET status='sent' WHERE task_id=?").run(task.id);
  f.domain.adminSaveTag(f.u(1),{id:f.hall1,name:'Главный зал',kind:'hall'});
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM outbox WHERE task_id=? AND kind='task' AND status='pending'").get(task.id).n,1);
  assert.equal(f.domain.task(f.u(2),task.id).generation,1);
});

test('закрытый адресованный вопрос не предлагает волонтёру заведомо недоступный ответ',t=>{
  const f=fixture(t);
  f.db.prepare('UPDATE users SET tag_ids=? WHERE id=4').run(JSON.stringify([f.tc]));
  const question=f.domain.createQuestion(f.u(2),f.create().id,{body:'Проверить готовность',tagIds:[f.tc]});
  f.domain.closeQuestion(f.u(2),question.id,{});
  const messages=f.db.prepare("SELECT payload FROM outbox WHERE user_id=4 AND kind='message' ORDER BY id").all().map(row=>JSON.parse(row.payload));
  assert.ok(messages.at(-1).text.includes('Ответ не требуется'));
  assert.equal(messages.at(-1).text.includes('/reply'),false);
});

test('некорректный режим назначения не превращается в ручное назначение и не меняет задачу',t=>{
  const f=fixture(t), task=f.create();
  for(const mode of [null,false,0,'',[],{}]) {
    f.rejects(()=>f.domain.previewAssignment(f.u(2),{mode,volunteerIds:[4]}),400);
    f.rejects(()=>f.domain.assignTask(f.u(2),task.id,{mode,volunteerIds:[4]}),400);
  }
  assert.equal(f.domain.task(f.u(2),task.id).assignments.length,0);
});

test('ошибка первого запуска не оставляет частично созданные исходные теги',async t=>{
  const {mkdtempSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const {DatabaseSync}=await import('node:sqlite');
  const directory=mkdtempSync(join(tmpdir(),'nerc-seed-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const path=join(directory,'app.sqlite');
  const original=DatabaseSync.prototype.prepare;
  let captured;
  DatabaseSync.prototype.prepare=function(sql){
    const stmt=original.call(this,sql);
    if(sql.startsWith('INSERT OR IGNORE INTO tags')){
      captured=this;
      return {run(...args){stmt.run(...args);throw new Error('Injected first-seed failure');}};
    }
    return stmt;
  };
  try{assert.throws(()=>openDatabase(path),/Injected/);}finally{
    DatabaseSync.prototype.prepare=original;
    if(captured?.isOpen)captured.close();
  }
  const db=openDatabase(path); t.after(()=>db.close());
  assert.equal(db.prepare('SELECT count(*) AS n FROM tags').get().n,13);
  assert.equal(db.prepare("SELECT count(*) AS n FROM tags WHERE name='Hall 5'").get().n,1);
});

test('менеджер передаёт итоговое пояснение всей группе один раз без дублирования и завершения задачи',t=>{
  const f=fixture(t), task=f.create();
  f.db.prepare('UPDATE users SET tag_ids=? WHERE id=5').run(JSON.stringify([f.tc]));
  f.domain.assignTask(f.u(2),task.id,{volunteerIds:[4,5]});
  f.domain.acceptTask(f.u(4),task.id,1);
  const q=f.domain.createQuestion(f.u(4),task.id,{body:'Где ставить столы?'},1);
  f.domain.forwardQuestion(f.u(2),q.id,{tagIds:[f.tc],blocking:true});
  const before=f.db.prepare("SELECT count(*) AS n FROM outbox WHERE kind='message'").get().n;
  f.domain.closeQuestion(f.u(2),q.id,{body:'Ставьте у северной стены.',sendToVolunteers:true});
  const jobs=f.db.prepare("SELECT user_id,payload FROM outbox WHERE kind='message' ORDER BY id").all().filter(row=>JSON.parse(row.payload).sharedResolution);
  assert.deepEqual(jobs.map(row=>row.user_id),[4,5]);
  assert.ok(jobs.every(row=>JSON.parse(row.payload).generation===1&&JSON.parse(row.payload).text.includes('северной стены')));
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM outbox WHERE kind='message'").get().n-before,2);
  assert.equal(f.domain.task(f.u(2),task.id).status,'in_progress');
  f.domain.closeQuestion(f.u(2),q.id,{body:'Ставьте у северной стены.',sendToVolunteers:true});
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM outbox WHERE kind='message'").get().n-before,2);
});

test('итог без выбора отправки группе получает только исходный волонтёр',t=>{
  const f=fixture(t), task=f.create();
  f.domain.assignTask(f.u(2),task.id,{volunteerIds:[4,5]});
  const q=f.domain.createQuestion(f.u(4),task.id,{body:'Уточните место'},1);
  f.domain.closeQuestion(f.u(2),q.id,{body:'У центрального входа.'});
  const users=f.db.prepare("SELECT user_id FROM outbox WHERE kind='message'").all().map(row=>row.user_id);
  assert.deepEqual(users,[4]);
});

test('рассылка итога группе требует явного boolean, текста и полномочий назначившего менеджера',t=>{
  const f=fixture(t), task=f.create({},6);
  f.domain.assignTask(f.u(2),task.id,{volunteerIds:[4,5]});
  const q=f.domain.createQuestion(f.u(6),task.id,{body:'Какая схема?' });
  f.rejects(()=>f.domain.closeQuestion(f.u(6),q.id,{body:'Схема готова',sendToVolunteers:true}),403);
  const own=f.domain.createQuestion(f.u(2),task.id,{body:'Уточните схему'});
  f.rejects(()=>f.domain.closeQuestion(f.u(2),own.id,{body:'',sendToVolunteers:true}),400);
  for(const value of [null,'true',1,[],{}])f.rejects(()=>f.domain.closeQuestion(f.u(2),own.id,{body:'Схема готова',sendToVolunteers:value}),400);
  assert.equal(f.domain.listQuestions(f.u(2),{box:'outgoing'}).find(row=>row.id===own.id).state,'open');
});
