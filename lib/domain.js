import { randomUUID } from 'node:crypto';

export class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new AppError(status, message); };
const stamp = () => new Date().toISOString();
const json = value => JSON.stringify(value);
const parse = value => JSON.parse(value || '[]');
const unique = list => [...new Set(list)];
const terminal = task => ['done','cancelled'].includes(task.status);
const web = user => user.roles.some(role => ['admin','organizer','manager'].includes(role));
const admin = user => user.roles.includes('admin');
const manager = user => user.roles.includes('manager');
function text(value, label, max = 10000, required = true) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(400, `${label}: укажите текст${max ? ` до ${max} символов` : ''}.`);
  return value.trim();
}
function id(value) { const n = Number(value); if (!Number.isSafeInteger(n) || n < 1) fail(400, 'Некорректный идентификатор.'); return n; }
function ids(value = []) { if (!Array.isArray(value) || value.length > 2000) fail(400, 'Ожидается список идентификаторов.'); return unique(value.map(id)); }

export class Domain {
  constructor(db) { this.db = db; }
  transaction(fn) {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  user(userId) {
    const row = this.db.prepare('SELECT * FROM users WHERE id=?').get(id(userId));
    if (!row) fail(404, 'Пользователь не найден.');
    return { id:row.id,name:row.name,login:row.login,roles:parse(row.roles),tagIds:parse(row.tag_ids),homeHallId:row.home_hall_id,managerId:row.manager_id,available:!!row.available,telegramId:row.telegram_id,chatId:row.chat_id,active:!!row.active,createdAt:row.created_at };
  }
  actor(actor) { const user=this.user(actor?.id); if (!user.active) fail(403,'Учётная запись отключена.'); return user; }
  organizer(actor) { const user=this.actor(actor); if (!web(user)) fail(403,'Действие доступно организаторам.'); return user; }
  administrator(actor) { const user=this.organizer(actor); if (!admin(user)) fail(403,'Действие доступно администратору.'); return user; }
  poolManager(actor) { const user=this.organizer(actor); if (!manager(user) && !admin(user)) fail(403,'Действие доступно менеджеру.'); return user; }
  tags() { return this.db.prepare('SELECT id,name,kind FROM tags ORDER BY id').all(); }
  settings() { return { crossHall: this.db.prepare("SELECT value FROM settings WHERE key='crossHall'").get()?.value === 'true' }; }
  validateTags(input) { const selected=ids(input); const available=new Set(this.tags().map(t=>t.id)); if (selected.some(i=>!available.has(i))) fail(400,'Неизвестный общий тег.'); return selected; }
  rawTask(taskId) { const row=this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id(taskId)); if (!row) fail(404,'Задача не найдена.'); return row; }
  rawQuestion(questionId) { const row=this.db.prepare('SELECT * FROM questions WHERE id=?').get(id(questionId)); if (!row) fail(404,'Вопрос не найден.'); return row; }
  isAssigned(taskId,userId) { return !!this.db.prepare('SELECT 1 FROM assignments WHERE task_id=? AND volunteer_id=?').get(taskId,userId); }
  readTask(actor, task) { if (web(actor) || this.isAssigned(task.id,actor.id)) return; fail(403,'Задача недоступна.'); }
  workTask(actor, task) {
    if (!web(actor)) fail(403,'Действие доступно организаторам.');
    if (admin(actor) || !task.hall_id) return;
    const own=actor.homeHallId ? actor.homeHallId === task.hall_id : actor.tagIds.includes(task.hall_id);
    if (!own && !this.settings().crossHall) fail(403,'Работа с задачами других холлов отключена администратором.');
  }
  unchangedGeneration(task,generation) { if (generation !== undefined && Number(generation) !== task.generation) fail(409,'Это устаревшее сообщение: назначения задачи изменились. Откройте /tasks.'); }
  activeTask(task) { if (terminal(task)) fail(409,'Задача уже завершена или отменена.'); }
  record(taskId,actorId,event,data={}) {
    const now=stamp(); this.db.prepare('INSERT INTO audit(task_id,actor_id,event,data,created_at) VALUES (?,?,?,?,?)').run(taskId,actorId,event,json(data),now);
    this.db.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run(now,taskId);
  }
  enqueue(kind,userId,taskId,payload={},eventKey=randomUUID()) {
    this.db.prepare('INSERT OR IGNORE INTO outbox(event_key,kind,user_id,task_id,payload,created_at) VALUES (?,?,?,?,?,?)').run(eventKey,kind,userId,taskId,json(payload),stamp());
  }
  refresh(taskId,extra=[]) {
    const people=unique([...extra,...this.db.prepare('SELECT volunteer_id AS id FROM assignments WHERE task_id=?').all(taskId).map(r=>r.id),...this.db.prepare('SELECT DISTINCT user_id AS id FROM telegram_messages WHERE task_id=?').all(taskId).map(r=>r.id)]);
    for (const userId of people) this.enqueue('task',userId,taskId);
  }
  notify(userIds,questionId,eventKey,message) {
    for (const userId of unique(userIds)) {
      const inserted=this.db.prepare('INSERT OR IGNORE INTO notifications(user_id,question_id,event_key,text,created_at) VALUES (?,?,?,?,?)').run(userId,questionId,eventKey,message,stamp());
      if (inserted.changes && this.user(userId).roles.includes('volunteer')) {
        const question=this.rawQuestion(questionId), latest=this.db.prepare('SELECT body FROM question_messages WHERE question_id=? ORDER BY id DESC LIMIT 1').get(questionId)?.body||'';
        this.enqueue('message',userId,question.task_id,{text:`${message}\nВопрос #${questionId}\n${latest.slice(0,2800)}\nОтветить: /reply ${questionId} текст ответа`,questionId},`notification:${userId}:${eventKey}`);
      }
    }
  }
  recipients(question) {
    if (question.source==='volunteer' && !question.forwarded) return [question.controller_id];
    const tags=parse(question.tag_ids);
    if (!tags.length) return [];
    return this.db.prepare('SELECT id FROM users WHERE active=1').all().map(row=>this.user(row.id)).filter(u=>u.tagIds.some(t=>tags.includes(t))).map(u=>u.id);
  }
  canReadQuestion(actor,q) { return admin(actor) || actor.id===q.asked_by || actor.id===q.controller_id || this.recipients(q).includes(actor.id) || (web(actor) && parse(q.tag_ids).length===0 && (q.source!=='volunteer'||q.forwarded)); }
  questionView(q) {
    return {id:q.id,taskId:q.task_id,askedBy:q.asked_by,controllerId:q.controller_id,source:q.source,forwarded:!!q.forwarded,tagIds:parse(q.tag_ids),blocking:!!q.blocking,urgency:q.urgency,state:q.state,createdAt:q.created_at,updatedAt:q.updated_at,recipientIds:this.recipients(q),expectedAction:q.state==='closed'?'Вопрос решён':q.state==='answered'?'Ожидается подтверждение решения':'Ожидается ответ',messages:this.db.prepare('SELECT id,author_id AS authorId,body,created_at AS createdAt FROM question_messages WHERE question_id=? ORDER BY id').all(q.id),taskTitle:this.rawTask(q.task_id).title,hallId:this.rawTask(q.task_id).hall_id};
  }
  taskView(task) {
    const assignments=this.db.prepare('SELECT volunteer_id AS volunteerId,accepted_at AS acceptedAt FROM assignments WHERE task_id=? ORDER BY volunteer_id').all(task.id);
    const questions=this.db.prepare("SELECT id,blocking,state FROM questions WHERE task_id=? AND state!='closed'").all(task.id);
    return {id:task.id,groupId:task.group_id,title:task.title,description:task.description,authorId:task.author_id,hallId:task.hall_id,tagIds:parse(task.tag_ids),status:task.status,claimedBy:task.claimed_by,assignedBy:task.assigned_by,generation:task.generation,createdAt:task.created_at,updatedAt:task.updated_at,assignments,blocked:questions.some(q=>!!q.blocking),openQuestions:questions.length,awaitingAcceptance:task.status==='queued' && assignments.length>0,awaitingReply:questions.some(q=>q.state==='open'),awaitingConfirmation:questions.some(q=>q.state==='answered')};
  }
  bootstrap(actor) {
    const user=this.organizer(actor);
    const users=this.db.prepare('SELECT id FROM users ORDER BY name').all().map(row=>this.user(row.id));
    // Password material is never returned. Telegram identity only matters to pool managers/admins.
    for (const u of users) if (!admin(user) && u.managerId!==user.id && u.id!==user.id) { delete u.telegramId; delete u.chatId; delete u.login; }
    return {user,tags:this.tags(),users,settings:this.settings(),personalTags:this.db.prepare('SELECT id,name,manager_id AS managerId FROM personal_tags WHERE manager_id=? ORDER BY name').all(user.id),notifications:this.db.prepare('SELECT n.id,n.question_id AS questionId,q.task_id AS taskId,n.text,n.created_at AS createdAt FROM notifications n LEFT JOIN questions q ON q.id=n.question_id WHERE n.user_id=? ORDER BY n.id DESC LIMIT 100').all(user.id)};
  }
  listTasks(actor,filters={}) {
    const user=this.actor(actor);
    let tasks=this.db.prepare('SELECT * FROM tasks ORDER BY id DESC').all().filter(t=>web(user)||this.isAssigned(t.id,user.id)).map(t=>this.taskView(t));
    const yes=v=>v===true||v==='1'||v==='true';
    if(filters.scope==='mine') tasks=tasks.filter(t=>t.claimedBy===user.id||t.assignedBy===user.id||t.authorId===user.id||t.assignments.some(a=>a.volunteerId===user.id));
    if(filters.scope==='home'&&user.homeHallId) tasks=tasks.filter(t=>t.hallId===user.homeHallId);
    if(filters.scope==='hall'||filters.hallId) tasks=tasks.filter(t=>t.hallId===Number(filters.hallId));
    if(filters.status) tasks=tasks.filter(t=>t.status===filters.status);
    if(filters.tagId) tasks=tasks.filter(t=>t.tagIds.includes(Number(filters.tagId)));
    if(filters.q) { const q=String(filters.q).toLocaleLowerCase('ru'); tasks=tasks.filter(t=>`${t.title} ${t.description} ${t.id}`.toLocaleLowerCase('ru').includes(q)); }
    if(yes(filters.blocked)) tasks=tasks.filter(t=>t.blocked);
    if(yes(filters.openQuestions)) tasks=tasks.filter(t=>t.openQuestions>0);
    if(filters.assignment==='free') tasks=tasks.filter(t=>!t.claimedBy&&!t.assignments.length&&!terminal(t));
    if(filters.assignment==='assigned') tasks=tasks.filter(t=>t.claimedBy||t.assignments.length);
    if(filters.assignment==='waiting') tasks=tasks.filter(t=>t.awaitingAcceptance);
    return tasks.sort((a,b)=>Number(b.blocked)-Number(a.blocked)||b.id-a.id);
  }
  task(actor,taskId) {
    const user=this.actor(actor), task=this.rawTask(taskId); this.readTask(user,task);
    const view=this.taskView(task);
    view.questions=this.db.prepare('SELECT * FROM questions WHERE task_id=? ORDER BY id').all(task.id).filter(q=>this.canReadQuestion(user,q)).map(q=>this.questionView(q));
    view.history=this.db.prepare('SELECT id,actor_id AS actorId,event,data,created_at AS createdAt FROM audit WHERE task_id=? ORDER BY id DESC').all(task.id).map(row=>({...row,data:JSON.parse(row.data)}));
    view.siblings=this.db.prepare('SELECT * FROM tasks WHERE group_id=? ORDER BY hall_id,id').all(task.group_id).map(t=>this.taskView(t));
    view.canWork=web(user)&&(!task.hall_id||admin(user)||this.settings().crossHall||(user.homeHallId?user.homeHallId===task.hall_id:user.tagIds.includes(task.hall_id)));
    view.canReset=view.canWork&&!terminal(task)&&(admin(user)||[task.author_id,task.claimed_by,task.assigned_by].includes(user.id));
    return view;
  }
  createTask(actor,input) { return this.transaction(()=>{
    const user=this.organizer(actor), title=text(input.title,'Название',250), description=text(input.description??'','Описание',15000,false);
    const tagIds=this.validateTags(input.tagIds), allTags=this.tags(), hallIds=unique([...ids(input.hallIds),...tagIds.filter(i=>allTags.find(t=>t.id===i)?.kind==='hall'),...(input.allHalls?allTags.filter(t=>t.kind==='hall').map(t=>t.id):[])]);
    if(hallIds.some(i=>allTags.find(t=>t.id===i)?.kind!=='hall')) fail(400,'Выберите существующие холлы.');
    const directions=tagIds.filter(i=>allTags.find(t=>t.id===i)?.kind!=='hall'), now=stamp();
    const groupId=Number(this.db.prepare('INSERT INTO task_groups(title,description,author_id,created_at) VALUES (?,?,?,?)').run(title,description,user.id,now).lastInsertRowid);
    return (hallIds.length?hallIds:[null]).map(hallId=>{
      const currentTags=unique([...directions,...(hallId?[hallId]:[])]);
      const taskId=Number(this.db.prepare("INSERT INTO tasks(group_id,title,description,author_id,hall_id,tag_ids,status,created_at,updated_at) VALUES (?,?,?,?,?,?,'queued',?,?)").run(groupId,title,description,user.id,hallId,json(currentTags),now,now).lastInsertRowid);
      this.record(taskId,user.id,'Задача опубликована',{groupId,hallId}); return this.taskView(this.rawTask(taskId));
    });
  }); }
  claimTask(actor,taskId) { return this.transaction(()=>{
    const user=this.organizer(actor), task=this.rawTask(taskId); this.workTask(user,task); this.activeTask(task);
    if(task.status!=='queued'||task.claimed_by||task.assigned_by||this.db.prepare('SELECT 1 FROM assignments WHERE task_id=?').get(task.id)) fail(409,'Задача уже взята или назначена волонтёрам.');
    this.db.prepare("UPDATE tasks SET claimed_by=?,status='in_progress' WHERE id=?").run(user.id,task.id);
    this.record(task.id,user.id,'Задача взята в работу'); this.refresh(task.id); return this.task(user,task.id);
  }); }
  volunteerView(user) {
    const tasks=this.db.prepare("SELECT t.* FROM tasks t JOIN assignments a ON a.task_id=t.id WHERE a.volunteer_id=? AND t.status IN ('queued','in_progress') ORDER BY t.id DESC").all(user.id).map(t=>this.taskView(t));
    const personalTagIds=this.db.prepare('SELECT personal_tag_id AS id FROM volunteer_personal_tags WHERE volunteer_id=?').all(user.id).map(t=>t.id);
    return {...user,tasks,free:user.available&&tasks.length===0,personalTagIds};
  }
  listVolunteers(actor) {
    const user=this.poolManager(actor);
    const pool=this.db.prepare('SELECT id FROM users WHERE active=1 ORDER BY name').all().map(r=>this.user(r.id)).filter(u=>u.roles.includes('volunteer')&&(u.managerId===user.id||admin(user)));
    return pool.map(u=>this.volunteerView(u));
  }
  previewAssignment(actor,input={}) {
    const user=this.poolManager(actor), pool=this.listVolunteers(user).filter(v=>v.managerId===user.id), mode=input.mode||'manual';
    if(!['manual','free','all'].includes(mode)) fail(400,'Неизвестный способ выбора волонтёров.');
    const selected=ids(input.volunteerIds), personal=ids(input.personalTagIds);
    if(selected.some(i=>!pool.some(v=>v.id===i))) fail(403,'Можно назначать только волонтёров своего пула.');
    const owned=new Set(this.db.prepare('SELECT id FROM personal_tags WHERE manager_id=?').all(user.id).map(t=>t.id));
    if(personal.some(i=>!owned.has(i))) fail(403,'Личные теги другого менеджера недоступны.');
    return pool.filter(v=>selected.includes(v.id)||v.personalTagIds.some(t=>personal.includes(t))||mode==='all'||(mode==='free'&&v.free));
  }
  assignTask(actor,taskId,input) { return this.transaction(()=>{
    const user=this.poolManager(actor), task=this.rawTask(taskId); this.workTask(user,task); this.activeTask(task);
    if(task.status!=='queued'||task.claimed_by||task.assigned_by||this.db.prepare('SELECT 1 FROM assignments WHERE task_id=?').get(task.id)) fail(409,'Задача уже взята или назначена. Для смены исполнителей верните её в очередь.');
    const volunteers=this.previewAssignment(user,input); if(!volunteers.length) fail(400,'Не выбраны волонтёры.');
    this.db.prepare('UPDATE tasks SET assigned_by=? WHERE id=?').run(user.id,task.id);
    const stmt=this.db.prepare('INSERT INTO assignments(task_id,volunteer_id) VALUES (?,?)');
    for(const v of volunteers) stmt.run(task.id,v.id);
    this.record(task.id,user.id,'Волонтёры назначены',{volunteerIds:volunteers.map(v=>v.id)}); this.refresh(task.id); return this.task(user,task.id);
  }); }
  acceptTask(actor,taskId,generation) { return this.transaction(()=>{
    const user=this.actor(actor), task=this.rawTask(taskId); this.unchangedGeneration(task,generation); this.activeTask(task);
    if(!this.isAssigned(task.id,user.id)) fail(403,'Вы не назначены на эту задачу.');
    const a=this.db.prepare('SELECT accepted_at FROM assignments WHERE task_id=? AND volunteer_id=?').get(task.id,user.id);
    if(!a.accepted_at) { this.db.prepare('UPDATE assignments SET accepted_at=? WHERE task_id=? AND volunteer_id=?').run(stamp(),task.id,user.id); this.db.prepare("UPDATE tasks SET status='in_progress' WHERE id=?").run(task.id); this.record(task.id,user.id,'Волонтёр начал выполнение'); this.refresh(task.id); }
    return this.task(user,task.id);
  }); }
  completeTask(actor,taskId,generation) { return this.transaction(()=>{
    const user=this.actor(actor), task=this.rawTask(taskId); this.unchangedGeneration(task,generation); this.activeTask(task);
    if(user.id!==task.claimed_by&&!this.isAssigned(task.id,user.id)) fail(403,'Завершить задачу может её самостоятельный исполнитель или назначенный волонтёр.');
    if(task.status!=='in_progress') fail(409,'Сначала возьмите задачу в работу.');
    this.db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(task.id); this.record(task.id,user.id,'Задача выполнена'); this.refresh(task.id); return this.task(user,task.id);
  }); }
  modifyTask(actor,taskId,reason,reset) { return this.transaction(()=>{
    const user=this.organizer(actor), task=this.rawTask(taskId); this.workTask(user,task); this.activeTask(task);
    if(!admin(user)&&![task.author_id,task.claimed_by,task.assigned_by].includes(user.id)) fail(403,'Изменить задачу может автор, участник или администратор.');
    const explanation=text(reason,'Причина',2000), old=this.db.prepare('SELECT volunteer_id AS id FROM assignments WHERE task_id=?').all(task.id).map(r=>r.id);
    if(reset) this.db.prepare('DELETE FROM assignments WHERE task_id=?').run(task.id);
    this.db.prepare('UPDATE tasks SET status=?,claimed_by=?,assigned_by=?,generation=generation+1 WHERE id=?').run(reset?'queued':'cancelled',reset?null:task.claimed_by,reset?null:task.assigned_by,task.id);
    this.record(task.id,user.id,reset?'Задача возвращена в очередь':'Задача отменена',{reason:explanation,previousVolunteerIds:old}); this.refresh(task.id,old); return this.task(user,task.id);
  }); }
  cancelTask(actor,taskId,reason) { return this.modifyTask(actor,taskId,reason,false); }
  resetTask(actor,taskId,reason) { return this.modifyTask(actor,taskId,reason,true); }
  setAvailability(actor,value) { return this.transaction(()=>{
    const user=this.actor(actor); if(!user.roles.includes('volunteer')) fail(403,'Доступность устанавливает волонтёр.'); if(typeof value!=='boolean') fail(400,'Укажите доступность.');
    this.db.prepare('UPDATE users SET available=? WHERE id=?').run(Number(value),user.id); return this.user(user.id);
  }); }
  setPersonalTags(actor,volunteerId,input) { return this.transaction(()=>{
    const user=this.poolManager(actor), volunteer=this.user(volunteerId); if(volunteer.managerId!==user.id) fail(403,'Личные теги доступны только внутри своего пула.');
    if(!Array.isArray(input.names)||input.names.length>100) fail(400,'Укажите список личных тегов.');
    const names=unique(input.names.map(v=>text(v,'Название личного тега',80)));
    const owned=this.db.prepare('SELECT id FROM personal_tags WHERE manager_id=?').all(user.id).map(t=>t.id);
    for(const tagId of owned) this.db.prepare('DELETE FROM volunteer_personal_tags WHERE volunteer_id=? AND personal_tag_id=?').run(volunteer.id,tagId);
    for(const name of names) { this.db.prepare('INSERT OR IGNORE INTO personal_tags(manager_id,name) VALUES (?,?)').run(user.id,name); const tag=this.db.prepare('SELECT id FROM personal_tags WHERE manager_id=? AND name=?').get(user.id,name); this.db.prepare('INSERT OR IGNORE INTO volunteer_personal_tags(volunteer_id,personal_tag_id) VALUES (?,?)').run(volunteer.id,tag.id); }
    return this.volunteerView(this.user(volunteer.id));
  }); }
  listQuestions(actor,{box='incoming'}={}) {
    const user=this.actor(actor);
    if(!web(user)&&box!=='incoming') fail(403,'Эта очередь доступна организаторам.');
    let rows=this.db.prepare('SELECT * FROM questions ORDER BY id DESC').all().filter(q=>this.canReadQuestion(user,q));
    if(box==='incoming') rows=rows.filter(q=>q.state!=='closed'&&this.recipients(q).includes(user.id)&&(q.source!=='volunteer'||q.forwarded));
    else if(box==='outgoing') rows=rows.filter(q=>q.controller_id===user.id||q.asked_by===user.id);
    else if(box==='volunteer') rows=rows.filter(q=>q.source==='volunteer'&&q.controller_id===user.id);
    else if(box==='unaddressed') rows=rows.filter(q=>q.state!=='closed'&&parse(q.tag_ids).length===0&&(q.source!=='volunteer'||q.forwarded));
    else fail(400,'Неизвестная очередь вопросов.');
    return rows.map(q=>this.questionView(q)).sort((a,b)=>Number(b.blocking)-Number(a.blocking)||Number(b.urgency==='urgent')-Number(a.urgency==='urgent')||b.id-a.id);
  }
  createQuestion(actor,taskId,input,generation) { return this.transaction(()=>{
    const user=this.actor(actor), task=this.rawTask(taskId); this.readTask(user,task); this.unchangedGeneration(task,generation); this.activeTask(task);
    const volunteer=this.isAssigned(task.id,user.id)&&user.id!==task.claimed_by&&(generation!==undefined||!web(user));
    if(!volunteer&&!admin(user)&&![task.author_id,task.claimed_by,task.assigned_by].includes(user.id)) fail(403,'Вопрос создаёт автор или участник задачи.');
    let controllerId=user.id;
    if(volunteer) { if(!user.managerId||!this.user(user.managerId).active) fail(409,'У вас не назначен активный менеджер. Обратитесь к администратору.'); controllerId=user.managerId; }
    const body=text(input.body,'Вопрос',10000), tags=volunteer?[]:this.validateTags(input.tagIds), blocking=volunteer?false:!!input.blocking, urgency=input.urgency==='urgent'?'urgent':'normal', now=stamp();
    const qid=Number(this.db.prepare('INSERT INTO questions(task_id,asked_by,controller_id,source,tag_ids,blocking,urgency,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(task.id,user.id,controllerId,volunteer?'volunteer':'web',json(tags),Number(blocking),urgency,now,now).lastInsertRowid);
    this.db.prepare('INSERT INTO question_messages(question_id,author_id,body,created_at) VALUES (?,?,?,?)').run(qid,user.id,body,now);
    const q=this.rawQuestion(qid); this.notify(this.recipients(q),qid,`question:${qid}:created`,`${blocking?'Блокирующий вопрос':'Новый вопрос'} по задаче «${task.title}»`);
    this.record(task.id,user.id,'Задан вопрос',{questionId:qid,blocking,tagIds:tags}); this.refresh(task.id); return this.questionView(q);
  }); }
  replyQuestion(actor,questionId,input) { return this.transaction(()=>{
    const user=this.actor(actor), q=this.rawQuestion(questionId); if(!this.canReadQuestion(user,q)) fail(403,'Обсуждение недоступно.');
    if(q.state==='closed') fail(409,'Обсуждение уже закрыто.');
    const body=text(input.body,'Ответ',10000), now=stamp();
    const result=this.db.prepare('INSERT INTO question_messages(question_id,author_id,body,created_at) VALUES (?,?,?,?)').run(q.id,user.id,body,now);
    const state=user.id===q.asked_by?'open':'answered';
    this.db.prepare('UPDATE questions SET state=?,updated_at=? WHERE id=?').run(state,now,q.id);
    this.notify(unique([q.controller_id,...this.recipients(q)]).filter(i=>i!==user.id && !(q.source==='volunteer' && user.id===q.controller_id && i===q.asked_by)),q.id,`question:${q.id}:message:${result.lastInsertRowid}`,`Новый ответ по задаче «${this.rawTask(q.task_id).title}»`);
    if(q.source==='volunteer'&&user.id===q.controller_id) this.enqueue('message',q.asked_by,q.task_id,{text:`Ответ менеджера по задаче «${this.rawTask(q.task_id).title}»:\n${body}`,questionId:q.id});
    this.record(q.task_id,user.id,'Добавлен ответ на вопрос',{questionId:q.id}); this.refresh(q.task_id); return this.questionView(this.rawQuestion(q.id));
  }); }
  forwardQuestion(actor,questionId,input) { return this.transaction(()=>{
    const user=this.organizer(actor), q=this.rawQuestion(questionId); if(q.source!=='volunteer'||q.controller_id!==user.id) fail(403,'Передать вопрос может менеджер, получивший его от волонтёра.');
    if(q.state==='closed') fail(409,'Обсуждение уже закрыто.');
    const tags=this.validateTags(input.tagIds), body=input.body?text(input.body,'Пояснение',10000):'', blocking=!!input.blocking, urgency=input.urgency==='urgent'?'urgent':'normal';
    if(body) this.db.prepare('INSERT INTO question_messages(question_id,author_id,body,created_at) VALUES (?,?,?,?)').run(q.id,user.id,body,stamp());
    this.db.prepare("UPDATE questions SET forwarded=1,tag_ids=?,blocking=?,urgency=?,state='open',updated_at=? WHERE id=?").run(json(tags),Number(blocking),urgency,stamp(),q.id);
    const updated=this.rawQuestion(q.id); this.notify(this.recipients(updated),q.id,randomUUID(),`${blocking?'Блокирующий вопрос':'Вопрос волонтёра'} по задаче «${this.rawTask(q.task_id).title}»`);
    this.record(q.task_id,user.id,'Вопрос направлен получателям',{questionId:q.id,tagIds:tags,blocking}); this.refresh(q.task_id); return this.questionView(updated);
  }); }
  closeQuestion(actor,questionId,input={}) { return this.transaction(()=>{
    const user=this.organizer(actor), q=this.rawQuestion(questionId); if(!admin(user)&&q.controller_id!==user.id) fail(403,'Подтвердить решение может задавший вопрос организатор или передавший его менеджер.');
    if(q.state==='closed') return this.questionView(q);
    const body=input.body?text(input.body,'Итоговое пояснение',10000):'';
    if(body) this.db.prepare('INSERT INTO question_messages(question_id,author_id,body,created_at) VALUES (?,?,?,?)').run(q.id,user.id,body,stamp());
    this.db.prepare("UPDATE questions SET state='closed',updated_at=? WHERE id=?").run(stamp(),q.id);
    this.notify(this.recipients(q).filter(i=>q.source!=='volunteer'||i!==q.asked_by),q.id,`question:${q.id}:closed`,`Вопрос по задаче «${this.rawTask(q.task_id).title}» решён`);
    if(q.source==='volunteer') this.enqueue('message',q.asked_by,q.task_id,{text:`Вопрос по задаче «${this.rawTask(q.task_id).title}» решён.${body?'\n'+body:''}`,questionId:q.id});
    this.record(q.task_id,user.id,'Решение вопроса подтверждено',{questionId:q.id}); this.refresh(q.task_id); return this.questionView(this.rawQuestion(q.id));
  }); }
  adminSaveUser(actor,input) { return this.transaction(()=>{
    const operator=this.administrator(actor), old=input.id?this.user(input.id):null;
    const name=text(input.name??old?.name,'Имя',200), login=input.login===undefined?(old?.login||null):input.login?text(input.login,'Логин',100):null;
    const roles=input.roles??old?.roles??[];
    if(!Array.isArray(roles)||!roles.length||roles.some(r=>!['admin','organizer','manager','volunteer'].includes(r))) fail(400,'Выберите корректные роли.');
    if(roles.some(r=>['admin','organizer','manager'].includes(r))&&!login) fail(400,'Для веб-доступа нужен логин.');
    const tagIds=this.validateTags(input.tagIds??old?.tagIds), homeHallId=input.homeHallId===undefined?(old?.homeHallId||null):input.homeHallId?id(input.homeHallId):null, managerId=input.managerId===undefined?(old?.managerId||null):input.managerId?id(input.managerId):null, active=input.active===undefined?(old?.active??true):!!input.active;
    if(homeHallId&&this.tags().find(t=>t.id===homeHallId)?.kind!=='hall') fail(400,'Домашний холл должен быть тегом холла.');
    if(managerId) { const pool=this.user(managerId); if(!pool.roles.includes('manager')||!pool.active||old?.id===managerId) fail(400,'Выберите активного менеджера пула.'); if(!roles.includes('volunteer')) fail(400,'Пул назначается волонтёру.'); }
    if(old?.id===operator.id&&(!active||!roles.includes('admin'))) fail(409,'Нельзя отключить собственный административный доступ.');
    if(old?.roles.includes('admin')&&(!roles.includes('admin')||!active)) { const remaining=this.db.prepare('SELECT id FROM users WHERE active=1 AND id!=?').all(old.id).map(r=>this.user(r.id)).filter(u=>admin(u)); if(!remaining.length) fail(409,'В системе должен оставаться активный администратор.'); }
    if(login&&this.db.prepare('SELECT id FROM users WHERE login=? AND id!=?').get(login,old?.id||0)) fail(409,'Логин уже занят.');
    if(old && (old.managerId!==managerId || old.active!==active || json(old.roles)!==json(unique(roles)))) this.db.prepare('DELETE FROM link_tokens WHERE user_id=? AND used_at IS NULL').run(old.id);
    let userId=old?.id;
    if(old) {
      if(old.managerId!==managerId) this.db.prepare('DELETE FROM volunteer_personal_tags WHERE volunteer_id=?').run(old.id);
      this.db.prepare('UPDATE users SET name=?,login=?,roles=?,tag_ids=?,home_hall_id=?,manager_id=?,active=? WHERE id=?').run(name,login,json(unique(roles)),json(tagIds),homeHallId,managerId,Number(active),old.id); if(!active) this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(old.id); }
    else userId=Number(this.db.prepare('INSERT INTO users(name,login,roles,tag_ids,home_hall_id,manager_id,active) VALUES (?,?,?,?,?,?,?)').run(name,login,json(unique(roles)),json(tagIds),homeHallId,managerId,Number(active)).lastInsertRowid);
    return this.user(userId);
  }); }
  adminSaveTag(actor,input) { return this.transaction(()=>{
    this.administrator(actor); const name=text(input.name,'Название тега',80), kind=input.kind;
    if(!['hall','direction'].includes(kind)) fail(400,'Выберите тип тега.');
    const old=input.id?this.db.prepare('SELECT * FROM tags WHERE id=?').get(id(input.id)):null;
    if(input.id&&!old) fail(404,'Тег не найден.');
    if(old&&old.kind!==kind) fail(409,'Тип существующего тега изменить нельзя. Создайте другой тег.');
    if(this.db.prepare('SELECT id FROM tags WHERE name=? AND id!=?').get(name,old?.id||0)) fail(409,'Такой тег уже существует.');
    const tagId=old?.id||Number(this.db.prepare('INSERT INTO tags(name,kind) VALUES (?,?)').run(name,kind).lastInsertRowid);
    if(old) this.db.prepare('UPDATE tags SET name=? WHERE id=?').run(name,tagId);
    return this.db.prepare('SELECT id,name,kind FROM tags WHERE id=?').get(tagId);
  }); }
  adminSettings(actor,input) { return this.transaction(()=>{
    this.administrator(actor); if(typeof input.crossHall!=='boolean') fail(400,'Укажите значение флага работы с другими холлами.');
    this.db.prepare("UPDATE settings SET value=? WHERE key='crossHall'").run(json(input.crossHall)); return this.settings();
  }); }
  retryDelivery(actor,outboxId) { return this.transaction(()=>{
    const user=this.poolManager(actor), row=this.db.prepare('SELECT * FROM outbox WHERE id=?').get(id(outboxId)); if(!row) fail(404,'Отправка не найдена.');
    if(!admin(user)&&this.user(row.user_id).managerId!==user.id) fail(403,'Отправка чужому пулу недоступна.');
    if(row.status==='sent') fail(409,'Сообщение уже доставлено.');
    this.db.prepare("UPDATE outbox SET status='pending',next_attempt=0,last_error=NULL WHERE id=?").run(row.id); return {ok:true};
  }); }
}
