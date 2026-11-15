import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { openDatabase } from '../lib/db.js';
import { Domain } from '../lib/domain.js';

function fixture(path = ':memory:') {
  const db = openDatabase(path);
  const domain = new Domain(db);
  const tag = (name) => domain.tags().find(t => t.name === name).id;
  const hall1 = tag('Hall 1'), hall2 = tag('Hall 2'), tc = tag('TC'), press = tag('Press');
  const add = (id, name, roles, tags = [], homeHallId = null, managerId = null) => db.prepare(
    'INSERT INTO users(id,name,login,password_hash,roles,tag_ids,home_hall_id,manager_id,available,active,created_at) VALUES(?,?,?,?,?,?,?,?,1,1,?)'
  ).run(id, name, `user${id}`, '', JSON.stringify(roles), JSON.stringify(tags), homeHallId, managerId, new Date().toISOString());
  if (!db.prepare('SELECT id FROM users WHERE id=1').get()) {
    add(1, 'Администратор', ['admin', 'organizer']);
    add(2, 'Менеджер первого', ['manager', 'organizer'], [hall1], hall1);
    add(3, 'Менеджер второго', ['manager', 'organizer'], [hall2], hall2);
    add(4, 'Волонтёр А', ['volunteer'], [], null, 2);
    add(5, 'Волонтёр Б', ['volunteer'], [], null, 2);
    add(6, 'Волонтёр В', ['volunteer'], [], null, 3);
    add(7, 'Техкомитет первого', ['organizer'], [tc, hall1], hall1);
    add(8, 'Техкомитет', ['organizer'], [tc]);
    add(9, 'Пресса', ['organizer'], [press]);
  }
  const u = (id) => domain.user(id);
  const create = (actor = 2, input = {}) => domain.createTask(u(actor), {
    title: 'Доставить оборудование', description: 'Принести удлинитель к стойке регистрации.',
    tagIds: [], ...input,
  })[0];
  return { db, domain, u, create, hall1, hall2, tc, press, close: () => db.close() };
}
function rejects(fn, statuses = [400, 403, 404, 409]) {
  assert.throws(fn, error => statuses.includes(error.status), 'Ожидалась контролируемая ошибка бизнес-операции');
}
const assignmentIds = (task) => task.assignments.map(a => a.volunteerId).sort((a, b) => a - b);

// These checks use the same domain methods called by HTTP and Telegram.
test('исходные общие теги включают Hall 5; задачи без тегов доступны общей очереди', t => {
  const f = fixture(); t.after(f.close);
  assert.ok(f.domain.tags().some(tag => tag.name === 'Hall 5' && tag.kind === 'hall'));
  const task = f.create(9);
  assert.deepEqual(task.tagIds, []);
  assert.ok(f.domain.listTasks(f.u(8), { scope: 'all' }).some(x => x.id === task.id));
  assert.equal(f.domain.claimTask(f.u(8), task.id).status, 'in_progress');
});

test('самостоятельное принятие сразу начинает работу и исключает конфликтующее назначение', t => {
  const f = fixture(); t.after(f.close);
  const task = f.create(2, { hallIds: [f.hall1] });
  assert.equal(f.domain.claimTask(f.u(2), task.id).status, 'in_progress');
  rejects(() => f.domain.claimTask(f.u(7), task.id));
  rejects(() => f.domain.assignTask(f.u(2), task.id, { volunteerIds: [4], mode: 'manual' }));
  const detail = f.domain.task(f.u(2), task.id);
  assert.equal(detail.claimedBy, 2);
  assert.deepEqual(assignmentIds(detail), []);
  assert.ok(detail.history.length > 0);
  assert.equal(f.domain.completeTask(f.u(2), task.id).status, 'done');
});

test('групповое назначение ждёт принятия; один участник начинает и завершает всю задачу', t => {
  const f = fixture(); t.after(f.close);
  const task = f.create();
  const assigned = f.domain.assignTask(f.u(2), task.id, { volunteerIds: [4, 4, 5], mode: 'manual' });
  assert.equal(assigned.status, 'queued');
  assert.equal(assigned.awaitingAcceptance, true);
  assert.deepEqual(assignmentIds(assigned), [4, 5]);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM outbox WHERE task_id=? AND kind='task'").get(task.id).n, 2);
  rejects(() => f.domain.claimTask(f.u(8), task.id));
  rejects(() => f.domain.assignTask(f.u(3), task.id, { volunteerIds: [6], mode: 'manual' }));
  const started = f.domain.acceptTask(f.u(4), task.id, assigned.generation);
  assert.equal(started.status, 'in_progress');
  f.domain.acceptTask(f.u(5), task.id, assigned.generation);
  assert.equal(f.domain.completeTask(f.u(4), task.id, assigned.generation).status, 'done');
  assert.equal(f.domain.task(f.u(5), task.id).status, 'done');
  try { f.domain.acceptTask(f.u(5), task.id, assigned.generation); } catch (error) { assert.ok(error.status); }
  try { f.domain.completeTask(f.u(5), task.id, assigned.generation); } catch (error) { assert.ok(error.status); }
  assert.equal(f.domain.task(f.u(2), task.id).status, 'done');
  assert.deepEqual(assignmentIds(f.domain.task(f.u(2), task.id)), [4, 5]);
});

test('пул менеджера проверяется на сервере, обычный организатор не назначает волонтёров', t => {
  const f = fixture(); t.after(f.close);
  const task = f.create();
  rejects(() => f.domain.assignTask(f.u(2), task.id, { volunteerIds: [6], mode: 'manual' }));
  rejects(() => f.domain.assignTask(f.u(8), task.id, { volunteerIds: [4], mode: 'manual' }));
  rejects(() => f.domain.acceptTask(f.u(4), task.id, 1));
  assert.deepEqual(assignmentIds(f.domain.task(f.u(2), task.id)), []);
});

test('доступность и занятость независимы; несколько задач допустимы, завершённые не занимают', t => {
  const f = fixture(); t.after(f.close);
  const a = f.create(), b = f.create();
  f.domain.assignTask(f.u(2), a.id, { volunteerIds: [4], mode: 'manual' });
  const assignedB = f.domain.assignTask(f.u(2), b.id, { volunteerIds: [4], mode: 'manual' });
  f.domain.setAvailability(f.u(5), false);
  assert.deepEqual(f.domain.previewAssignment(f.u(2), { mode: 'free' }).map(v => v.id), []);
  let volunteers = f.domain.listVolunteers(f.u(2));
  assert.equal(volunteers.find(v => v.id === 4).tasks.length, 2);
  assert.equal(volunteers.find(v => v.id === 4).available, true);
  assert.equal(volunteers.find(v => v.id === 5).available, false);
  f.domain.acceptTask(f.u(4), a.id, a.generation);
  f.domain.completeTask(f.u(4), a.id, a.generation);
  assert.equal(f.domain.listVolunteers(f.u(2)).find(v => v.id === 4).free, false);
  f.domain.cancelTask(f.u(2), b.id, 'Больше не требуется');
  assert.equal(f.domain.listVolunteers(f.u(2)).find(v => v.id === 4).free, true);
  assert.equal(f.domain.listVolunteers(f.u(2)).find(v => v.id === 5).free, false);
  assert.deepEqual(f.domain.previewAssignment(f.u(2), { mode: 'free' }).map(v => v.id), [4]);
  f.domain.setAvailability(f.u(5), true);
  assert.deepEqual(f.domain.previewAssignment(f.u(2), { mode: 'free' }).map(v => v.id).sort(), [4, 5]);
  assert.ok(assignedB.generation >= 1);
});

test('выбор всего пула включает недоступных с явными признаками, но без чужого пула', t => {
  const f = fixture(); t.after(f.close);
  f.domain.setAvailability(f.u(5), false);
  const preview = f.domain.previewAssignment(f.u(2), { mode: 'all' });
  assert.deepEqual(preview.map(v => v.id).sort(), [4, 5]);
  assert.equal(preview.find(v => v.id === 5).available, false);
  const task = f.create();
  const assigned = f.domain.assignTask(f.u(2), task.id, { mode: 'all' });
  assert.deepEqual(assignmentIds(assigned), [4, 5]);
});

test('личные теги локальны менеджеру, пересечения выбора не дублируют людей', t => {
  const f = fixture(); t.after(f.close);
  f.domain.setPersonalTags(f.u(2), 4, { names: ['Сильные', 'Утро'] });
  f.domain.setPersonalTags(f.u(2), 5, { names: ['Утро'] });
  f.domain.setPersonalTags(f.u(3), 6, { names: ['Утро'] });
  rejects(() => f.domain.setPersonalTags(f.u(2), 6, { names: ['Чужой'] }));
  const tags = f.domain.bootstrap(f.u(2)).personalTags;
  const morning = tags.find(tag => tag.name === 'Утро');
  assert.ok(morning);
  const people = f.domain.previewAssignment(f.u(2), { mode: 'manual', volunteerIds: [4], personalTagIds: [morning.id] });
  assert.deepEqual(people.map(v => v.id).sort(), [4, 5]);
  const task = f.create();
  const assigned = f.domain.assignTask(f.u(2), task.id, { mode: 'manual', volunteerIds: [4, 4], personalTagIds: [morning.id] });
  assert.deepEqual(assignmentIds(assigned), [4, 5]);
});

test('одна публикация на несколько холлов имеет независимые статусы; все холлы включают Hall 5', t => {
  const f = fixture(); t.after(f.close);
  const tasks = f.domain.createTask(f.u(1), { title: 'Открыть двери', description: 'По команде откройте вход.', hallIds: [f.hall1, f.hall2], tagIds: [] });
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].groupId, tasks[1].groupId);
  const first = tasks.find(task => task.hallId === f.hall1);
  const second = tasks.find(task => task.hallId === f.hall2);
  f.domain.claimTask(f.u(2), first.id);
  f.domain.completeTask(f.u(2), first.id);
  assert.equal(f.domain.task(f.u(3), second.id).status, 'queued');
  assert.equal(f.domain.task(f.u(2), first.id).siblings.length, 2);
  const all = f.domain.createTask(f.u(1), { title: 'Проверить воду', description: '', allHalls: true, tagIds: [] });
  assert.equal(all.length, f.domain.tags().filter(tag => tag.kind === 'hall').length);
  assert.ok(all.some(task => task.hallId === f.domain.tags().find(tag => tag.name === 'Hall 5').id));
});

test('основная очередь ограничена своим холлом, другие видимы; crossHall защищает операции', t => {
  const f = fixture(); t.after(f.close);
  const own = f.create(1, { hallIds: [f.hall1] });
  const other = f.create(1, { hallIds: [f.hall2] });
  assert.ok(f.domain.listTasks(f.u(2), { scope: 'home' }).some(task => task.id === own.id));
  assert.ok(!f.domain.listTasks(f.u(2), { scope: 'home' }).some(task => task.id === other.id));
  assert.ok(f.domain.listTasks(f.u(2), { scope: 'hall', hallId: f.hall2 }).some(task => task.id === other.id));
  rejects(() => f.domain.claimTask(f.u(2), other.id), [403]);
  rejects(() => f.domain.assignTask(f.u(2), other.id, { mode: 'manual', volunteerIds: [4] }), [403]);
  rejects(() => f.domain.adminSettings(f.u(2), { crossHall: true }), [403]);
  f.domain.adminSettings(f.u(1), { crossHall: true });
  assert.equal(f.domain.assignTask(f.u(2), other.id, { mode: 'manual', volunteerIds: [4] }).assignedBy, 2);
});

test('волонтёрский вопрос получает его менеджер; ответ сохраняется и ставится на доставку', t => {
  const f = fixture(); t.after(f.close);
  const task = f.create();
  const assigned = f.domain.assignTask(f.u(2), task.id, { mode: 'manual', volunteerIds: [4] });
  const question = f.domain.createQuestion(f.u(4), task.id, { body: 'Где находится кабель?', blocking: false }, assigned.generation);
  assert.ok(f.domain.listQuestions(f.u(2), { box: 'volunteer' }).some(q => q.id === question.id));
  assert.ok(!f.domain.listQuestions(f.u(3), { box: 'volunteer' }).some(q => q.id === question.id));
  f.domain.replyQuestion(f.u(2), question.id, { body: 'У стойки регистрации.' });
  const found = f.domain.listQuestions(f.u(2), { box: 'volunteer' }).find(q => q.id === question.id);
  assert.ok(found.messages.some(message => message.body === 'У стойки регистрации.'));
  assert.ok(f.db.prepare("SELECT id FROM outbox WHERE user_id=4 AND kind='message'").get());
  assert.equal(found.state, 'answered');
});

test('теги вопроса независимы от задачи; OR-получатели без дублей; ответ не снимает блокировку', t => {
  const f = fixture(); t.after(f.close);
  const task = f.create(3, { hallIds: [f.hall2] });
  const assigned = f.domain.assignTask(f.u(3), task.id, { mode: 'manual', volunteerIds: [6] });
  const question = f.domain.createQuestion(f.u(6), task.id, { body: 'Нет питания на стойке.' }, assigned.generation);
  const before = f.domain.bootstrap(f.u(7)).notifications.length;
  f.domain.forwardQuestion(f.u(3), question.id, { body: 'Нужна проверка щитка.', tagIds: [f.tc, f.hall1, f.tc], blocking: true, urgency: 'urgent' });
  for (const id of [2, 7, 8]) {
    assert.equal(f.domain.listQuestions(f.u(id), { box: 'incoming' }).filter(q => q.id === question.id).length, 1);
  }
  assert.equal(f.domain.bootstrap(f.u(7)).notifications.length - before, 1);
  assert.ok(!f.domain.listQuestions(f.u(9), { box: 'incoming' }).some(q => q.id === question.id));
  rejects(() => f.domain.replyQuestion(f.u(9), question.id, { body: 'Чужой ответ' }), [403]);
  assert.equal(f.domain.task(f.u(3), task.id).blocked, true);
  f.domain.replyQuestion(f.u(8), question.id, { body: 'Включили питание.' });
  assert.equal(f.domain.task(f.u(3), task.id).blocked, true);
  rejects(() => f.domain.closeQuestion(f.u(8), question.id, { body: 'Проверено' }), [403]);
  f.domain.closeQuestion(f.u(3), question.id, { body: 'Волонтёр проверил, всё работает.' });
  assert.equal(f.domain.task(f.u(3), task.id).blocked, false);
  assert.equal(f.domain.task(f.u(3), task.id).status, 'queued');
});

test('несколько блокирующих обсуждений закрываются независимо, неблокирующее не останавливает работу', t => {
  const f = fixture(); t.after(f.close);
  const task = f.create();
  f.domain.claimTask(f.u(2), task.id);
  const first = f.domain.createQuestion(f.u(2), task.id, { body: 'Не хватает кабеля.', tagIds: [f.tc], blocking: true, urgency: 'urgent' });
  const second = f.domain.createQuestion(f.u(2), task.id, { body: 'Нет доступа в комнату.', tagIds: [f.tc], blocking: true });
  const normal = f.domain.createQuestion(f.u(2), task.id, { body: 'Какой цвет ленты?', tagIds: [f.tc], blocking: false });
  assert.equal(f.domain.task(f.u(2), task.id).status, 'in_progress');
  assert.equal(f.domain.task(f.u(2), task.id).blocked, true);
  f.domain.closeQuestion(f.u(2), first.id, { body: 'Кабель нашли.' });
  assert.equal(f.domain.task(f.u(2), task.id).blocked, true);
  f.domain.closeQuestion(f.u(2), second.id, { body: 'Открыли дверь.' });
  assert.equal(f.domain.task(f.u(2), task.id).blocked, false);
  const detail = f.domain.task(f.u(2), task.id);
  assert.ok(detail.questions.some(q => q.id === normal.id && q.state !== 'closed'));
  assert.equal(detail.status, 'in_progress');
});

test('вопрос без тегов попадает в общую очередь без назначенных адресатов', t => {
  const f = fixture(); t.after(f.close);
  const task = f.create();
  const question = f.domain.createQuestion(f.u(2), task.id, { body: 'Кто знает, где маркеры?', tagIds: [], blocking: false });
  assert.ok(f.domain.listQuestions(f.u(9), { box: 'unaddressed' }).some(q => q.id === question.id));
  assert.deepEqual(question.recipientIds, []);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM notifications WHERE question_id=?').get(question.id).n, 0);
  assert.ok(!f.domain.listQuestions(f.u(9), { box: 'incoming' }).some(q => q.id === question.id));
  f.domain.replyQuestion(f.u(9), question.id, { body: 'Есть в пресс-центре.' });
  assert.ok(f.domain.listQuestions(f.u(2), { box: 'outgoing' }).some(q => q.id === question.id && q.state === 'answered'));
  f.domain.closeQuestion(f.u(2), question.id, { body: 'Забрали.' });
  assert.equal(f.domain.task(f.u(2), task.id).status, 'queued');
});

test('возврат в очередь сохраняет историю и инвалидирует старые кнопки даже после нового назначения', t => {
  const f = fixture(); t.after(f.close);
  const task = f.create();
  const assigned = f.domain.assignTask(f.u(2), task.id, { mode: 'manual', volunteerIds: [4] });
  f.domain.acceptTask(f.u(4), task.id, assigned.generation);
  rejects(() => f.domain.resetTask(f.u(9), task.id, 'Хочу перекинуть'), [403]);
  rejects(() => f.domain.resetTask(f.u(2), task.id, ''));
  const reset = f.domain.resetTask(f.u(2), task.id, 'Нужно передать следующей смене.');
  assert.equal(reset.status, 'queued');
  assert.deepEqual(assignmentIds(reset), []);
  assert.equal(reset.claimedBy, null);
  assert.ok(reset.generation > assigned.generation);
  f.domain.assignTask(f.u(2), task.id, { mode: 'manual', volunteerIds: [4, 5] });
  rejects(() => f.domain.acceptTask(f.u(4), task.id, assigned.generation));
  rejects(() => f.domain.completeTask(f.u(4), task.id, assigned.generation));
  assert.equal(f.domain.task(f.u(2), task.id).status, 'queued');
  assert.ok(f.domain.task(f.u(2), task.id).history.length >= 4);
});

test('неуспешная доставка не теряет назначение; повтор доступен только своему менеджеру или админу', t => {
  const f = fixture(); t.after(f.close);
  const task = f.create();
  f.domain.assignTask(f.u(2), task.id, { mode: 'manual', volunteerIds: [4] });
  const row = f.db.prepare('SELECT * FROM outbox WHERE task_id=? LIMIT 1').get(task.id);
  f.db.prepare("UPDATE outbox SET status='failed',attempts=1,last_error='Бот заблокирован' WHERE id=?").run(row.id);
  assert.deepEqual(assignmentIds(f.domain.task(f.u(2), task.id)), [4]);
  rejects(() => f.domain.retryDelivery(f.u(3), row.id), [403]);
  f.domain.retryDelivery(f.u(2), row.id);
  assert.equal(f.db.prepare('SELECT status FROM outbox WHERE id=?').get(row.id).status, 'pending');
});

test('только администратор меняет общие теги, пулы и роли; последний администратор защищён', t => {
  const f = fixture(); t.after(f.close);
  rejects(() => f.domain.adminSaveTag(f.u(2), { name: 'VIP', kind: 'direction' }), [403]);
  const tag = f.domain.adminSaveTag(f.u(1), { name: 'Дополнительный холл', kind: 'hall' });
  assert.equal(tag.kind, 'hall');
  rejects(() => f.domain.adminSaveUser(f.u(2), { id: 6, name: 'Волонтёр В', login: 'user6', roles: ['volunteer'], tagIds: [], managerId: 2 }), [403]);
  f.domain.adminSaveUser(f.u(1), { id: 6, name: 'Волонтёр В', login: 'user6', roles: ['volunteer'], tagIds: [], managerId: 2, active: true });
  assert.equal(f.u(6).managerId, 2);
  rejects(() => f.domain.adminSaveUser(f.u(1), { id: 1, name: 'Администратор', login: 'user1', roles: ['organizer'], tagIds: [], active: true }));
});

test('данные, назначения, вопросы и история переживают закрытие и повторное открытие SQLite', t => {
  const directory = mkdtempSync(join(tmpdir(), 'neerc-domain-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'app.sqlite');
  const f = fixture(path);
  const task = f.create();
  const assigned = f.domain.assignTask(f.u(2), task.id, { mode: 'manual', volunteerIds: [4] });
  f.domain.acceptTask(f.u(4), task.id, assigned.generation);
  const question = f.domain.createQuestion(f.u(4), task.id, { body: 'Уточните место.' }, assigned.generation);
  const historyCount = f.domain.task(f.u(2), task.id).history.length;
  f.close();
  const second = fixture(path); t.after(second.close);
  const restored = second.domain.task(second.u(2), task.id);
  assert.equal(restored.status, 'in_progress');
  assert.deepEqual(assignmentIds(restored), [4]);
  assert.equal(restored.history.length, historyCount);
  assert.ok(restored.questions.some(q => q.id === question.id));
});

test('два соединения с одним файлом не создают двух исполнителей одной задачи', t => {
  const directory = mkdtempSync(join(tmpdir(), 'neerc-race-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'app.sqlite');
  const f = fixture(path); t.after(f.close);
  const other = fixture(path); t.after(other.close);
  const task = f.create();
  assert.equal(other.domain.task(other.u(8), task.id).status, 'queued');
  f.domain.claimTask(f.u(2), task.id);
  rejects(() => other.domain.claimTask(other.u(8), task.id), [409]);
  assert.equal(other.domain.task(other.u(8), task.id).claimedBy, 2);
  assert.deepEqual(assignmentIds(f.domain.task(f.u(2), task.id)), []);
});


test('действительно одновременные принятия из разных потоков оставляют одного исполнителя', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'neerc-concurrent-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'app.sqlite');
  const f = fixture(path); t.after(f.close);
  const task = f.create();
  const source = `
    import { parentPort, workerData } from 'node:worker_threads';
    import { openDatabase } from '${new URL('../lib/db.js', import.meta.url).href}';
    import { Domain } from '${new URL('../lib/domain.js', import.meta.url).href}';
    const db = openDatabase(workerData.path);
    const domain = new Domain(db);
    parentPort.once('message', () => {
      try { domain.claimTask(domain.user(workerData.actorId), workerData.taskId); parentPort.postMessage({ok:true}); }
      catch(error) { parentPort.postMessage({ok:false,status:error.status,message:error.message}); }
      finally { db.close(); }
    });
    parentPort.postMessage({ready:true});
  `;
  const workers = [2, 8].map(actorId => new Worker(new URL('data:text/javascript,' + encodeURIComponent(source)), { workerData: { path, actorId, taskId: task.id } }));
  let ready = 0;
  const results = await Promise.all(workers.map(worker => new Promise((resolve, reject) => {
    worker.on('error', reject);
    worker.on('message', value => {
      if (value.ready) { if (++ready === workers.length) workers.forEach(thread => thread.postMessage('go')); }
      else resolve(value);
    });
  })));
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results.find(result => !result.ok).status, 409);
  const detail = f.domain.task(f.u(1), task.id);
  assert.equal(detail.status, 'in_progress');
  assert.ok([2, 8].includes(detail.claimedBy));
  assert.deepEqual(assignmentIds(detail), []);
});


test('совмещающий роли волонтёр задаёт вопрос по своему назначению через общий домен', t => {
  const f = fixture(); t.after(f.close);
  f.db.prepare('UPDATE users SET roles=? WHERE id=4').run(JSON.stringify(['volunteer', 'organizer']));
  const task = f.create();
  const assigned = f.domain.assignTask(f.u(2), task.id, { mode: 'manual', volunteerIds: [4] });
  const question = f.domain.createQuestion(f.u(4), task.id, { body: 'Куда нести коробку?' }, assigned.generation);
  assert.equal(question.source, 'volunteer');
  assert.equal(question.controllerId, 2);
  assert.ok(f.domain.listQuestions(f.u(2), { box: 'volunteer' }).some(q => q.id === question.id));
});


test('волонтёр с общими тегами получает адресованный вопрос один раз и отвечает без назначения на задачу', t => {
  const f = fixture(); t.after(f.close);
  f.db.prepare('UPDATE users SET tag_ids=? WHERE id=4').run(JSON.stringify([f.tc, f.hall1]));
  const task = f.create(3, { hallIds: [f.hall2] });
  const question = f.domain.createQuestion(f.u(3), task.id, { body: 'Кто знает код щитка?', tagIds: [f.tc, f.hall1], blocking: true });
  assert.equal(f.domain.listQuestions(f.u(4), { box: 'incoming' }).filter(q => q.id === question.id).length, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM notifications WHERE user_id=4 AND question_id=?').get(question.id).n, 1);
  const messages = f.db.prepare("SELECT payload FROM outbox WHERE user_id=4 AND kind='message'").all().filter(row => JSON.parse(row.payload).questionId === question.id);
  assert.equal(messages.length, 1);
  const answered = f.domain.replyQuestion(f.u(4), question.id, { body: 'Код 1234.' });
  assert.equal(answered.state, 'answered');
  assert.equal(f.domain.task(f.u(3), task.id).blocked, true);
  rejects(() => f.domain.closeQuestion(f.u(4), question.id, {}), [403]);
});

test('смена пула удаляет прежние личные теги волонтёра', t => {
  const f = fixture(); t.after(f.close);
  f.domain.setPersonalTags(f.u(2), 4, { names: ['Сильные'] });
  assert.equal(f.domain.listVolunteers(f.u(2)).find(v => v.id === 4).personalTagIds.length, 1);
  f.domain.adminSaveUser(f.u(1), { id: 4, name: 'Волонтёр А', login: 'user4', roles: ['volunteer'], tagIds: [], managerId: 3, active: true });
  assert.ok(!f.domain.listVolunteers(f.u(2)).some(v => v.id === 4));
  assert.deepEqual(f.domain.listVolunteers(f.u(3)).find(v => v.id === 4).personalTagIds, []);
});

test('переименованные общие теги после перезапуска не дублируются исходными', t => {
  const directory = mkdtempSync(join(tmpdir(), 'neerc-tags-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'app.sqlite');
  const f = fixture(path);
  const count = f.domain.tags().length;
  f.domain.adminSaveTag(f.u(1), { id: f.tc, name: 'Техкомитет', kind: 'direction' });
  f.close();
  const db = openDatabase(path); t.after(() => db.close());
  const domain = new Domain(db);
  assert.equal(domain.tags().length, count);
  assert.equal(domain.tags().find(tag => tag.id === f.tc).name, 'Техкомитет');
  assert.ok(!domain.tags().some(tag => tag.name === 'TC'));
});

test('переименование холла сохраняет выполняемые назначения, права менеджера и связи после перезапуска', t => {
  const directory = mkdtempSync(join(tmpdir(), 'nerc-hall-edit-'));
  t.after(() => rmSync(directory, {recursive:true,force:true}));
  const path = join(directory,'app.sqlite');
  const f = fixture(path);
  const task = f.create(2,{hallIds:[f.hall1]});
  f.domain.assignTask(f.u(2),task.id,{mode:'manual',volunteerIds:[4,5]});
  const before = f.domain.acceptTask(f.u(4),task.id,1);
  f.domain.adminSaveTag(f.u(1),{id:f.hall1,name:'Главный зал',kind:'hall'});
  const after = f.domain.task(f.u(2),task.id);
  assert.equal(after.status,'in_progress');
  assert.equal(after.generation,before.generation);
  assert.deepEqual(after.assignments,before.assignments);
  assert.equal(after.canWork,true);
  assert.equal(f.domain.user(2).homeHallId,f.hall1);
  assert.ok(f.domain.listTasks(f.u(2),{scope:'home'}).some(x=>x.id===task.id));
  f.close();
  const db = openDatabase(path); t.after(()=>db.close());
  const domain = new Domain(db);
  assert.equal(domain.tags().find(x=>x.id===f.hall1).name,'Главный зал');
  assert.ok(!domain.tags().some(x=>x.name==='Hall 1'));
  assert.equal(domain.task(domain.user(2),task.id).hallId,f.hall1);
});
