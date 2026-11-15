import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../lib/db.js';
import { Domain } from '../lib/domain.js';
import { TelegramBot } from '../lib/telegram.js';

function fixture(path = ':memory:') {
  const db = openDatabase(path);
  const domain = new Domain(db);
  const adminId = Number(db.prepare("INSERT INTO users(name,login,roles,tag_ids) VALUES('Администратор','admin','[\"admin\"]','[]')").run().lastInsertRowid);
  const admin = domain.user(adminId);
  const hall = domain.tags().find(t => t.name === 'Hall 1').id;
  const tc = domain.tags().find(t => t.name === 'TC').id;
  const press = domain.tags().find(t => t.name === 'Press').id;
  const manager = domain.adminSaveUser(admin, { name: 'Менеджер', login: 'manager', roles: ['manager'], tagIds: [hall], homeHallId: hall });
  const volunteer = domain.adminSaveUser(admin, { name: 'Первый волонтёр', roles: ['volunteer'], managerId: manager.id });
  const other = domain.adminSaveUser(admin, { name: 'Второй волонтёр', roles: ['volunteer'], managerId: manager.id });
  const calls = [];
  let nextMessage = 100;
  let failSend = false;
  let onSend = null;
  const fetchImpl = async (url, request) => {
    const method = url.split('/').at(-1);
    const data = JSON.parse(request.body);
    calls.push({ method, ...data });
    if (method === 'sendMessage' && onSend) { const action = onSend; onSend = null; await action(data); }
    if (method === 'sendMessage' && failSend) return { ok: false, status: 403, json: async () => ({ ok: false, error_code: 403, description: 'Forbidden' }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, result: method === 'sendMessage' ? { message_id: nextMessage++ } : method === 'getUpdates' ? [] : true }) };
  };
  const bot = new TelegramBot({ db, domain, token: 'TEST_TOKEN', username: 'coordination_test_bot', fetchImpl });
  const update = (updateId, telegramId, text) => ({ update_id: updateId, message: { message_id: updateId, from: { id: telegramId }, chat: { id: telegramId, type: 'private' }, text } });
  const callback = (updateId, telegramId, data) => ({ update_id: updateId, callback_query: { id: `cb${updateId}`, from: { id: telegramId }, message: { message_id: 100, chat: { id: telegramId, type: 'private' } }, data } });
  const connect = async (user, telegramId, updateId) => {
    const link = bot.createLink(manager, user.id);
    const token = new URL(link.url).searchParams.get('start');
    await bot.handleUpdate(update(updateId, telegramId, `/start ${token}`));
    return token;
  };
  const create = () => domain.createTask(manager, { title: 'Перенести оборудование', description: 'Доставить на стойку регистрации', hallIds: [hall] })[0];
  return { db, domain, admin, manager, volunteer, other, hall, tc, press, bot, calls, update, callback, connect, create,
    failSend(value) { failSend = value; }, onSend(fn) { onSend = fn; } };
}

test('Telegram links are private, single use, hashed, expiring and scoped to manager pool', async t => {
  const f = fixture(); t.after(() => f.db.close());
  const outsider = f.domain.adminSaveUser(f.admin, { name: 'Другой менеджер', login: 'outside', roles: ['manager'] });
  assert.throws(() => f.bot.createLink(outsider, f.volunteer.id), { status: 403 });
  const link = f.bot.createLink(f.manager, f.volunteer.id);
  const token = new URL(link.url).searchParams.get('start');
  assert.equal(f.db.prepare('SELECT token_hash FROM link_tokens').get().token_hash.includes(token), false);
  await f.bot.handleUpdate({ update_id: 1, message: { from: { id: 501 }, chat: { id: -1, type: 'group' }, text: `/start ${token}` } });
  assert.equal(f.domain.user(f.volunteer.id).telegramId, null);
  await f.bot.handleUpdate(f.update(2, 501, `/start ${token}`));
  assert.equal(f.domain.user(f.volunteer.id).telegramId, 501);
  assert.throws(() => f.bot.createLink(f.manager, f.volunteer.id), { status: 409 });
  const result = await f.bot.handleUpdate(f.update(3, 502, `/start ${token}`));
  assert.match(result.text, /использована/);
  assert.equal(f.domain.user(f.volunteer.id).telegramId, 501);
  const expiredLink = f.bot.createLink(f.manager, f.other.id);
  const expired = new URL(expiredLink.url).searchParams.get('start');
  f.db.prepare('UPDATE link_tokens SET expires_at=0 WHERE user_id=?').run(f.other.id);
  await f.bot.handleUpdate(f.update(4, 502, `/start ${expired}`));
  assert.equal(f.domain.user(f.other.id).telegramId, null);
});

test('real Bot API adapter carries group assignment, acceptance, one completion and edited terminal cards', async t => {
  const f = fixture(); t.after(() => f.db.close());
  await f.connect(f.volunteer, 501, 1); await f.connect(f.other, 502, 2);
  const task = f.create();
  f.domain.assignTask(f.manager, task.id, { volunteerIds: [f.volunteer.id, f.other.id, f.volunteer.id] });
  await f.bot.drainOutbox();
  const cards = f.calls.filter(c => c.method === 'sendMessage' && c.reply_markup);
  assert.equal(cards.length, 2);
  assert.equal(f.domain.task(f.manager, task.id).status, 'queued');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM telegram_messages').get().n, 2);
  const event = f.callback(10, 501, `accept:${task.id}:${task.generation}`);
  await f.bot.handleUpdate(event); await f.bot.handleUpdate(event);
  assert.equal(f.domain.task(f.manager, task.id).status, 'in_progress');
  const started = f.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE event='Волонтёр начал выполнение'").get().n;
  assert.equal(started, 1);
  await f.bot.handleUpdate(f.callback(11, 502, `complete:${task.id}:${task.generation}`));
  assert.equal(f.domain.task(f.manager, task.id).status, 'done');
  await f.bot.drainOutbox();
  const edits = f.calls.filter(c => c.method === 'editMessageText' && c.text.includes('Выполнена'));
  assert.ok(edits.some(c => c.chat_id === 501)); assert.ok(edits.some(c => c.chat_id === 502));
  assert.ok(edits.every(c => c.reply_markup.inline_keyboard.length === 0));
  const stale = await f.bot.handleUpdate(f.callback(12, 501, `accept:${task.id}:${task.generation}`));
  assert.equal(stale.show_alert, true);
  assert.equal(f.domain.task(f.manager, task.id).status, 'done');
  assert.equal(f.calls.filter(c => c.method === 'answerCallbackQuery').length, 4);
});

test('volunteer questions, manager forwarding, tag-union recipient and reply use one discussion', async t => {
  const f = fixture(); t.after(() => f.db.close());
  await f.connect(f.volunteer, 501, 1);
  const recipient = f.domain.adminSaveUser(f.admin, { name: 'Волонтёр техкомитета', roles: ['volunteer'], managerId: f.manager.id, tagIds: [f.tc, f.press] });
  await f.connect(recipient, 503, 2);
  const task = f.create();
  f.domain.assignTask(f.manager, task.id, { volunteerIds: [f.volunteer.id] });
  await f.bot.handleUpdate(f.callback(3, 501, `question:${task.id}:${task.generation}`));
  const questionMessage = f.update(4, 501, 'Где взять кабель?');
  await f.bot.handleUpdate(questionMessage); await f.bot.handleUpdate(questionMessage);
  const questions = f.domain.listQuestions(f.manager, { box: 'volunteer' });
  assert.equal(questions.length, 1);
  const question = questions[0];
  f.domain.replyQuestion(f.manager, question.id, { body: 'Уточняю у техкомитета.' });
  await f.bot.drainOutbox();
  assert.ok(f.calls.some(c => c.chat_id === 501 && c.text?.includes('Уточняю у техкомитета.')));
  f.domain.forwardQuestion(f.manager, question.id, { body: 'Нужен кабель', tagIds: [f.tc, f.press], blocking: true, urgency: 'urgent' });
  const recipientNotifications = f.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND question_id=?').get(recipient.id, question.id).n;
  assert.equal(recipientNotifications, 1);
  await f.bot.handleUpdate(f.update(5, 503, '/questions'));
  await f.bot.handleUpdate(f.update(6, 503, `/reply ${question.id} На стойке TC`));
  const answered = f.domain.listQuestions(f.manager, { box: 'outgoing' })[0];
  assert.equal(answered.messages.at(-1).body, 'На стойке TC');
  assert.equal(f.domain.task(f.manager, task.id).blocked, true);
  assert.throws(() => f.domain.task(recipient, task.id), { status: 403 });
  f.domain.closeQuestion(f.manager, question.id, { body: 'Кабель нашли.' });
  assert.equal(f.domain.task(f.manager, task.id).blocked, false);
  await f.bot.drainOutbox();
  assert.ok(f.calls.some(c => c.chat_id === 501 && c.text?.includes('Кабель нашли.')));
});

test('delivery failure is persisted, retry does not lose assignment, and stale generation cannot mutate reset task', async t => {
  const f = fixture(); t.after(() => f.db.close());
  await f.connect(f.volunteer, 501, 1); await f.bot.drainOutbox();
  const task = f.create(); f.domain.assignTask(f.manager, task.id, { volunteerIds: [f.volunteer.id] });
  f.failSend(true); await f.bot.drainOutbox();
  const failed = f.db.prepare("SELECT * FROM outbox WHERE kind='task' AND status='failed'").get();
  assert.match(failed.last_error, /запретил/);
  assert.equal(f.domain.task(f.manager, task.id).assignments.length, 1);
  f.failSend(false); f.domain.retryDelivery(f.manager, failed.id); await f.bot.drainOutbox();
  assert.equal(f.db.prepare('SELECT status FROM outbox WHERE id=?').get(failed.id).status, 'sent');
  f.domain.resetTask(f.manager, task.id, 'Нужна другая команда');
  await f.bot.handleUpdate(f.callback(2, 501, `accept:${task.id}:${task.generation}`));
  assert.equal(f.domain.task(f.manager, task.id).status, 'queued');
  assert.equal(f.domain.task(f.manager, task.id).assignments.length, 0);
  await f.bot.drainOutbox();
  assert.ok(f.calls.some(c => c.method === 'editMessageText' && c.text.includes('назначение снято') && !c.reply_markup.inline_keyboard.length));
});

test('send racing reset records actual generation and schedules disabling the old card', async t => {
  const f = fixture(); t.after(() => f.db.close());
  await f.connect(f.volunteer, 501, 1); await f.bot.drainOutbox();
  const task = f.create(); f.domain.assignTask(f.manager, task.id, { volunteerIds: [f.volunteer.id] });
  f.onSend(() => { f.domain.resetTask(f.manager, task.id, 'Смена команды во время доставки'); });
  await f.bot.drainOutbox();
  assert.equal(f.db.prepare('SELECT generation FROM telegram_messages').get().generation, task.generation);
  await f.bot.drainOutbox();
  assert.ok(f.calls.some(c => c.method === 'editMessageText' && c.text.includes('назначение снято')));
  assert.equal(f.calls.filter(c => c.method === 'sendMessage' && c.reply_markup).length, 1);
});

test('restart preserves Telegram identity, event dedupe and question input', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'coordination-telegram-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'test.sqlite');
  const f = fixture(path);
  await f.connect(f.volunteer, 501, 1);
  const task = f.create(); f.domain.assignTask(f.manager, task.id, { volunteerIds: [f.volunteer.id] });
  const question = f.callback(2, 501, `question:${task.id}:${task.generation}`);
  await f.bot.handleUpdate(question);
  const userId = f.volunteer.id; f.db.close();
  const db = openDatabase(path); t.after(() => db.close());
  const domain = new Domain(db);
  const bot = new TelegramBot({ db, domain });
  assert.equal(domain.user(userId).telegramId, 501);
  assert.equal((await bot.handleUpdate(question)).duplicate, true);
  await bot.handleUpdate(f.update(3, 501, 'Вопрос после перезапуска'));
  assert.equal(domain.listQuestions(f.manager, { box: 'volunteer' }).length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM telegram_state').get().n, 0);
});

test('polling bootstrap recovers and stop awaits in-flight work before database close', async t => {
  const f = fixture(); t.after(() => f.db.close());
  let failBootstrap = true;
  let polls = 0;
  const bot = new TelegramBot({ db: f.db, domain: f.domain, token: 'TEST', username: 'test_bot', fetchImpl: async (url, request) => {
    const method = url.split('/').at(-1);
    if (method === 'deleteWebhook' && failBootstrap) { failBootstrap = false; throw new Error('network offline'); }
    if (method === 'getUpdates') {
      polls++;
      return new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) };
  } });
  await bot.start(); await bot.pollWork;
  assert.equal(bot.status().running, true);
  assert.match(bot.status().error, /Нет связи/);
  const retry = bot.runTick();
  for (let i = 0; i < 20 && !polls; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(polls, 1);
  // The normal tick owns pollWork. Record this explicit retry the same way.
  bot.pollWork = retry;
  await bot.stop();
  assert.equal(bot.status().running, false);
  assert.equal(bot.draining, false);
});
