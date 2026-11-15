import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../server.js';
import { TelegramBot } from '../lib/telegram.js';
import { Readable } from 'node:stream';

const password = 'test-password-123';
async function setup(t) {
  let bot;
  const calls = [];
  let failDelivery = false;
  let messageId = 100;
  const proxy = { status: () => bot?.status() || {}, stop: () => bot?.stop(), createLink: (...args) => bot.createLink(...args) };
  const app = createApplication({ database: ':memory:', adminPassword: password, port: 0, host: '127.0.0.1', token: '', bot: proxy });
  bot = new TelegramBot({ db: app.db, domain: app.domain, token: 'fake-integration-token', username: 'integration_bot', fetchImpl: async (url, options) => {
    const method = url.split('/').at(-1), payload = JSON.parse(options.body);
    calls.push({ method, payload });
    const failed = failDelivery && ['sendMessage', 'editMessageText'].includes(method);
    return new Response(JSON.stringify(failed ? { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' } : { ok: true, result: { message_id: ++messageId } }), { status: failed ? 403 : 200 });
  } });
  // Managed task execution denies listen(2). Exercise the real HTTP handler,
  // including its request stream, parsing, cookies, headers and transactions.
  // TCP listening and browser rendering need an unrestricted deployment host.
  t.after(() => app.close());
  const handler = app.server.listeners('request')[0];
  const request = async (path, { method = 'GET', body, session, headers = {} } = {}) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    req.url = path;
    req.headers = Object.fromEntries(Object.entries({ host: '127.0.0.1:4319',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}), ...headers,
    }).map(([key, value]) => [key.toLowerCase(), value]));
    req.socket = { remoteAddress: '127.0.0.1' };
    const responseHeaders = new Headers();
    let status = 200, responseBody;
    const res = {
      headersSent: false,
      setHeader(name, value) { responseHeaders.set(name, value); },
      writeHead(value, values = {}) { status = value; this.headersSent = true; for (const [name, header] of Object.entries(values)) responseHeaders.set(name, header); },
      end(value) { responseBody = String(value ?? ''); },
    };
    await handler(req, res);
    return { status, body: JSON.parse(responseBody), headers: responseHeaders };
  };
  const login = async (name = 'admin') => {
    const response = await request('/api/login', { method: 'POST', body: { login: name, password } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: response.body.csrf, user: response.body.user };
  };
  const admin = await login();
  const tags = (await request('/api/bootstrap', { session: admin })).body.tags;
  const tag = name => tags.find(item => item.name === name).id;
  const saveUser = async input => {
    const response = await request('/api/admin/users', { method: 'POST', session: admin, body: { active: true, tagIds: [], password, ...input } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  };
  const manager = await saveUser({ name: 'Менеджер первого', login: 'manager', roles: ['manager', 'organizer'], tagIds: [tag('Hall 1')], homeHallId: tag('Hall 1') });
  const manager2 = await saveUser({ name: 'Менеджер второго', login: 'manager2', roles: ['manager', 'organizer'], tagIds: [tag('Hall 2')], homeHallId: tag('Hall 2') });
  const tc = await saveUser({ name: 'Техкомитет', login: 'tc', roles: ['organizer'], tagIds: [tag('TC'), tag('Hall 1')], homeHallId: tag('Hall 1') });
  const volunteer = await saveUser({ name: 'Волонтёр А', login: 'volunteer', roles: ['volunteer'], managerId: manager.id });
  const volunteer2 = await saveUser({ name: 'Волонтёр Б', login: 'volunteer2', roles: ['volunteer'], managerId: manager.id });
  const otherVolunteer = await saveUser({ name: 'Волонтёр В', login: 'volunteer3', roles: ['volunteer'], managerId: manager2.id });
  const session = await login('manager'), session2 = await login('manager2'), tcSession = await login('tc');
  let updateId = 1;
  const message = (telegramId, text) => ({ update_id: updateId++, message: { message_id: updateId, text, from: { id: telegramId, is_bot: false }, chat: { id: telegramId, type: 'private' } } });
  const callback = (telegramId, data) => ({ update_id: updateId++, callback_query: { id: `callback-${updateId}`, data, from: { id: telegramId, is_bot: false }, message: { message_id: 10, chat: { id: telegramId, type: 'private' } } } });
  const link = async (user, telegramId, ownerSession = session) => {
    const response = await request(`/api/volunteers/${user.id}/link`, { method: 'POST', session: ownerSession, body: {} });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    await bot.handleUpdate(message(telegramId, '/start ' + new URL(response.body.url).searchParams.get('start')));
  };
  const createTask = async (body = {}, ownerSession = session) => {
    const response = await request('/api/tasks', { method: 'POST', session: ownerSession, body: { title: 'Перенести коробки', description: 'Из склада к стойке.', tagIds: [], ...body } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.tasks[0];
  };
  return { app, bot, calls, request, login, admin, session, session2, tcSession, manager, manager2, tc, volunteer, volunteer2, otherVolunteer, link, message, callback, createTask, tag, failDelivery: value => { failDelivery = value; } };
}

test('HTTP: аутентификация, CSRF, источник, недоступность веба волонтёру и безопасные ответы', async t => {
  const f = await setup(t);
  assert.equal((await f.request('/api/bootstrap')).status, 401);
  assert.equal((await f.request('/api/login', { method: 'POST', body: { login: 'volunteer', password } })).status, 401);
  assert.equal((await f.request('/api/tasks', { method: 'POST', session: f.session, headers: { 'X-CSRF-Token': 'wrong' }, body: { title: 'Задача' } })).status, 403);
  assert.equal((await f.request('/api/tasks', { method: 'POST', session: f.session, headers: { Origin: 'https://malicious.example' }, body: { title: 'Задача' } })).status, 403);
  const bootstrap = await f.request('/api/bootstrap', { session: f.admin });
  assert.equal(bootstrap.status, 200);
  assert.equal(JSON.stringify(bootstrap.body).includes('password_hash'), false);
  assert.equal(JSON.stringify(bootstrap.body).includes(password), false);
  assert.equal(bootstrap.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await f.request('/api/admin/settings', { method: 'POST', session: f.session, body: { crossHall: true } })).status, 403);
  assert.equal((await f.request('/api/logout', { method: 'POST', session: f.session, body: {} })).status, 200);
  assert.equal((await f.request('/api/bootstrap', { session: f.session })).status, 401);
});

test('HTTP: повторный ключ не создаёт дубликат, а несовпавшее действие отклоняется', async t => {
  const f = await setup(t);
  const body = { title: 'Проверить пропуска', description: '', tagIds: [] };
  const headers = { 'Idempotency-Key': 'same-action-123' };
  const first = await f.request('/api/tasks', { method: 'POST', session: f.session, body, headers });
  const second = await f.request('/api/tasks', { method: 'POST', session: f.session, body, headers });
  assert.equal(first.status, 200);
  assert.deepEqual(second.body, first.body);
  assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM tasks').get().n, 1);
  const conflict = await f.request('/api/tasks', { method: 'POST', session: f.session, body: { ...body, title: 'Другая задача' }, headers });
  assert.equal(conflict.status, 409);
});

test('HTTP + Telegram: прямые права холлов, назначение группы, принятие и завершение отражаются в вебе', async t => {
  const f = await setup(t);
  await f.link(f.volunteer, 10001);
  await f.link(f.volunteer2, 10002);
  const task = await f.createTask({ hallIds: [f.tag('Hall 2')] }, f.admin);
  const assignment = { mode: 'manual', volunteerIds: [f.volunteer.id, f.volunteer2.id] };
  assert.equal((await f.request(`/api/tasks/${task.id}/claim`, { method: 'POST', session: f.session, body: {} })).status, 403);
  assert.equal((await f.request(`/api/tasks/${task.id}/assign`, { method: 'POST', session: f.session, body: assignment })).status, 403);
  assert.equal((await f.request('/api/admin/settings', { method: 'POST', session: f.admin, body: { crossHall: true } })).status, 200);
  const assigned = await f.request(`/api/tasks/${task.id}/assign`, { method: 'POST', session: f.session, body: assignment });
  assert.equal(assigned.status, 200);
  assert.equal(assigned.body.status, 'queued');
  assert.equal(assigned.body.awaitingAcceptance, true);
  assert.equal(assigned.body.assignments.length, 2);
  await f.bot.drainOutbox();
  const taskCards = f.calls.filter(call => call.method === 'sendMessage' && call.payload.text.includes(`Задача №${task.id}`));
  assert.equal(taskCards.length, 2);
  const accept = f.callback(10001, `accept:${task.id}:${assigned.body.generation}`);
  await f.bot.handleUpdate(accept);
  await f.bot.handleUpdate(accept);
  let detail = await f.request(`/api/tasks/${task.id}`, { session: f.session });
  assert.equal(detail.body.status, 'in_progress');
  assert.equal(detail.body.history.filter(event => event.event === 'Волонтёр начал выполнение').length, 1);
  await f.bot.handleUpdate(f.callback(10001, `complete:${task.id}:${assigned.body.generation}`));
  await f.bot.drainOutbox();
  detail = await f.request(`/api/tasks/${task.id}`, { session: f.session });
  assert.equal(detail.body.status, 'done');
  const old = await f.bot.handleUpdate(f.callback(10002, `accept:${task.id}:${assigned.body.generation}`));
  assert.equal(old.show_alert, true);
  assert.equal((await f.request(`/api/tasks/${task.id}`, { session: f.session })).body.status, 'done');
  const updatedForOther = f.calls.filter(call => call.method === 'editMessageText' && call.payload.chat_id === 10002).at(-1);
  assert.ok(updatedForOther.payload.text.includes('Выполнена'));
  assert.deepEqual(updatedForOther.payload.reply_markup.inline_keyboard, []);
});

test('HTTP + Telegram: вопрос волонтёра передаётся тегам, ответ ждёт подтверждения и приходит в бот', async t => {
  const f = await setup(t);
  await f.link(f.volunteer, 10001);
  const task = await f.createTask();
  const assigned = await f.request(`/api/tasks/${task.id}/assign`, { method: 'POST', session: f.session, body: { mode: 'manual', volunteerIds: [f.volunteer.id] } });
  await f.bot.handleUpdate(f.callback(10001, `question:${task.id}:${assigned.body.generation}`));
  await f.bot.handleUpdate(f.message(10001, 'В комнате нет электричества.'));
  let incoming = await f.request('/api/questions?box=volunteer', { session: f.session });
  assert.equal(incoming.body.questions.length, 1);
  const questionId = incoming.body.questions[0].id;
  const forward = await f.request(`/api/questions/${questionId}/forward`, { method: 'POST', session: f.session, body: { body: 'Проверьте автомат.', tagIds: [f.tag('TC'), f.tag('Hall 1')], blocking: true, urgency: 'urgent' } });
  assert.equal(forward.status, 200);
  const tcQuestions = await f.request('/api/questions?box=incoming', { session: f.tcSession });
  assert.equal(tcQuestions.body.questions.filter(question => question.id === questionId).length, 1);
  assert.equal((await f.request(`/api/tasks/${task.id}`, { session: f.session })).body.blocked, true);
  const answer = await f.request(`/api/questions/${questionId}/reply`, { method: 'POST', session: f.tcSession, body: { body: 'Автомат включён, проверьте.' } });
  assert.equal(answer.status, 200);
  assert.equal(answer.body.state, 'answered');
  assert.equal((await f.request(`/api/tasks/${task.id}`, { session: f.session })).body.blocked, true);
  assert.equal((await f.request(`/api/questions/${questionId}/close`, { method: 'POST', session: f.tcSession, body: {} })).status, 403);
  const closed = await f.request(`/api/questions/${questionId}/close`, { method: 'POST', session: f.session, body: { body: 'Работает, продолжайте.' } });
  assert.equal(closed.status, 200);
  assert.equal((await f.request(`/api/tasks/${task.id}`, { session: f.session })).body.blocked, false);
  await f.bot.drainOutbox();
  assert.ok(f.calls.some(call => call.method === 'sendMessage' && call.payload.chat_id === 10001 && call.payload.text.includes('Работает, продолжайте.')));
  incoming = await f.request('/api/questions?box=outgoing', { session: f.session });
  assert.equal(incoming.body.questions.find(question => question.id === questionId).state, 'closed');
});

test('HTTP + Telegram: ошибка доставки видна своему менеджеру, назначение сохраняется и повтор работает', async t => {
  const f = await setup(t);
  await f.link(f.volunteer, 10001);
  await f.bot.drainOutbox();
  const task = await f.createTask();
  await f.request(`/api/tasks/${task.id}/assign`, { method: 'POST', session: f.session, body: { mode: 'manual', volunteerIds: [f.volunteer.id] } });
  f.failDelivery(true);
  await f.bot.drainOutbox();
  const deliveries = await f.request('/api/deliveries', { session: f.session });
  const failed = deliveries.body.deliveries.find(delivery => delivery.taskId === task.id && delivery.status === 'failed');
  assert.ok(failed);
  assert.ok(failed.error.includes('Telegram'));
  const others = await f.request('/api/deliveries', { session: f.session2 });
  assert.ok(!others.body.deliveries.some(delivery => delivery.id === failed.id));
  assert.equal((await f.request(`/api/deliveries/${failed.id}/retry`, { method: 'POST', session: f.session2, body: {} })).status, 403);
  assert.equal((await f.request(`/api/tasks/${task.id}`, { session: f.session })).body.assignments.length, 1);
  f.failDelivery(false);
  assert.equal((await f.request(`/api/deliveries/${failed.id}/retry`, { method: 'POST', session: f.session, body: {} })).status, 200);
  await f.bot.drainOutbox();
  assert.equal(f.app.db.prepare('SELECT status FROM outbox WHERE id=?').get(failed.id).status, 'sent');
});

test('HTTP + Telegram: приглашение не сохраняется открытым текстом и отзывается при смене пула', async t => {
  const f = await setup(t);
  const request = {method:'POST', session:f.session, body:{}, headers:{'Idempotency-Key':'invitation-request'}};
  const invitation = await f.request(`/api/volunteers/${f.volunteer.id}/link`,request);
  assert.equal(invitation.status,200);
  const token = new URL(invitation.body.url).searchParams.get('start');
  assert.equal(JSON.stringify(f.app.db.prepare('SELECT * FROM request_keys').all()).includes(token),false);
  const transfer = await f.request('/api/admin/users',{method:'POST',session:f.admin,body:{id:f.volunteer.id,managerId:f.manager2.id}});
  assert.equal(transfer.status,200);
  assert.equal((await f.request(`/api/volunteers/${f.volunteer.id}/link`,request)).status,403);
  const result = await f.bot.handleUpdate(f.message(10001,`/start ${token}`));
  assert.equal(result.show_alert,true);
  assert.equal(f.app.domain.user(f.volunteer.id).telegramId,null);
});

test('HTTP: только администратор создаёт и переименовывает холлы; коллизии и смена типа запрещены', async t => {
  const f=await setup(t);
  const post=(session,body)=>f.request('/api/admin/tags',{method:'POST',session,body});
  assert.equal((await post(f.session,{name:'Hall 6',kind:'hall'})).status,403);
  const added=await post(f.admin,{name:'Hall 6',kind:'hall'});
  assert.equal(added.status,200);
  const renamed=await post(f.admin,{id:added.body.id,name:'Аудитория «Север»',kind:'hall'});
  assert.equal(renamed.status,200);
  assert.equal(renamed.body.id,added.body.id);
  assert.equal((await post(f.admin,{id:added.body.id,name:'Hall 1',kind:'hall'})).status,409);
  assert.equal((await post(f.admin,{id:added.body.id,name:'Направление',kind:'direction'})).status,409);
  const bootstrap=(await f.request('/api/bootstrap',{session:f.session})).body;
  assert.equal(bootstrap.tags.find(x=>x.id===added.body.id).name,'Аудитория «Север»');
});
