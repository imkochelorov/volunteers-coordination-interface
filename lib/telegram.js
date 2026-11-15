import { createHash, randomBytes } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const states = { queued: 'В очереди', in_progress: 'В процессе', done: 'Выполнена', cancelled: 'Отменена' };
const terminal = value => value === 'done' || value === 'cancelled';
const chunks = text => Array.from({ length: Math.ceil(text.length / 3800) }, (_, i) => text.slice(i * 3800, (i + 1) * 3800));

function failure(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export class TelegramBot {
  constructor({ db, domain, token = '', username = '', apiBase = 'https://api.telegram.org', fetchImpl = globalThis.fetch }) {
    this.db = db;
    this.domain = domain;
    this.token = token;
    this.username = username.replace(/^@/, '');
    this.apiBase = apiBase.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.running = false;
    this.draining = false;
    this.timer = null;
    this.deliveryTimer = null;
    this.pollAbort = null;
    this.shutdownAbort = new AbortController();
    this.pollWork = null;
    this.deliveryWork = null;
    this.initialized = false;
    this.lastPollError = null;
    this.lastPollAt = null;
  }

  status() {
    return { configured: Boolean(this.token && this.username), running: this.running, username: this.username || null, lastPollAt: this.lastPollAt, error: this.lastPollError };
  }

  transaction(fn) {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createLink(actor, volunteerId) {
    const current = this.domain.user(actor.id);
    const target = this.domain.user(Number(volunteerId));
    if (!current?.active || !target?.active || !target.roles.includes('volunteer')) throw failure('Волонтёр не найден.', 404);
    if (!current.roles.includes('admin') && (!current.roles.includes('manager') || target.managerId !== current.id)) throw failure('Можно подключать только волонтёров своего пула.', 403);
    if (!this.token || !this.username) throw failure('Сначала настройте TELEGRAM_BOT_TOKEN и TELEGRAM_BOT_USERNAME на сервере.', 503);
    if (target.telegramId) throw failure('Волонтёр уже подключён к Telegram. Смена привязанного аккаунта требует отдельной проверки администратором.', 409);
    const token = randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
    this.transaction(() => {
      this.db.prepare('DELETE FROM link_tokens WHERE user_id=? AND used_at IS NULL').run(target.id);
      this.db.prepare('INSERT INTO link_tokens(token_hash,user_id,expires_at,used_at) VALUES(?,?,?,NULL)').run(hash(token), target.id, expiresAt);
    });
    return { url: `https://t.me/${this.username}?start=${token}`, expiresAt: new Date(expiresAt).toISOString() };
  }

  enqueue(key, userId, text, extra = {}) {
    this.db.prepare(`INSERT OR IGNORE INTO outbox(event_key,kind,user_id,task_id,payload,status,created_at)
      VALUES(?, 'message', ?, NULL, ?, 'pending', ?)`).run(key, userId, JSON.stringify({ text, ...extra }), now());
  }

  enqueueDirect(key, chatId, text) {
    this.db.prepare(`INSERT OR IGNORE INTO outbox(event_key,kind,user_id,task_id,payload,status,created_at)
      VALUES(?, 'message', NULL, NULL, ?, 'pending', ?)`).run(key, JSON.stringify({ text, chatId }), now());
  }

  linkedUser(telegramId) {
    const row = this.db.prepare('SELECT id FROM users WHERE telegram_id=? AND active=1').get(telegramId);
    return row ? this.domain.user(row.id) : null;
  }

  link(telegramId, chatId, token, key) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw failure('Ссылка подключения неверна. Попросите менеджера создать новую.');
    const invitation = this.db.prepare('SELECT * FROM link_tokens WHERE token_hash=?').get(hash(token));
    if (!invitation || invitation.used_at !== null || invitation.expires_at < Date.now()) throw failure('Ссылка использована или срок её действия истёк. Попросите менеджера создать новую.');
    const target = this.domain.user(invitation.user_id);
    if (!target?.active || !target.roles.includes('volunteer')) throw failure('Подключение этого волонтёра недоступно.');
    const existing = this.linkedUser(telegramId);
    if ((existing && existing.id !== target.id) || (target.telegramId && target.telegramId !== telegramId)) throw failure('Telegram уже связан с другим участником. Обратитесь к администратору.');
    this.db.prepare('UPDATE users SET telegram_id=?,chat_id=? WHERE id=?').run(telegramId, chatId, target.id);
    this.db.prepare('UPDATE link_tokens SET used_at=? WHERE token_hash=? AND used_at IS NULL').run(Date.now(), hash(token));
    this.enqueue(key, target.id, `Здравствуйте, ${target.name}! Telegram подключён.\n\nЗдесь будут появляться назначения. /tasks — мои задачи, /unavailable — стать недоступным, /available — вернуться, /help — помощь.`);
    this.db.prepare("UPDATE outbox SET status='pending', next_attempt=0 WHERE user_id=? AND status='failed'").run(target.id);
    return target;
  }

  process(update) {
    const callback = update.callback_query;
    const message = callback?.message || update.message;
    const sender = callback?.from || update.message?.from;
    if (!message || !sender || sender.is_bot || message.chat?.type !== 'private' || message.chat.id !== sender.id) return null;
    const key = `telegram:${update.update_id}`;
    const telegramId = sender.id;
    const chatId = message.chat.id;
    const body = update.message?.text?.trim() || '';
    const command = body.match(/^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
    let actor = this.linkedUser(telegramId);

    if (!callback && command?.[1] === 'start' && command[2]) {
      actor = this.link(telegramId, chatId, command[2].trim(), `${key}:welcome`);
      return { text: 'Telegram подключён.' };
    }
    if (!actor || !actor.roles.includes('volunteer')) {
      this.enqueueDirect(`${key}:unknown`, chatId, 'Для подключения попросите у своего менеджера личную ссылку и нажмите «Начать». Не передавайте эту ссылку другим людям.');
      return { text: 'Сначала подключитесь по ссылке менеджера.' };
    }
    if (callback) {
      const match = /^(accept|complete|question):(\d+):(\d+)$/.exec(callback.data || '');
      if (!match) throw failure('Эта кнопка больше не поддерживается. Используйте /tasks.');
      const [, action, id, generation] = match;
      const taskId = Number(id);
      const revision = Number(generation);
      if (action === 'accept') {
        this.domain.acceptTask(actor, taskId, revision);
        return { text: 'Задача в процессе.' };
      }
      if (action === 'complete') {
        this.domain.completeTask(actor, taskId, revision);
        this.db.prepare('DELETE FROM telegram_state WHERE task_id=?').run(taskId);
        return { text: 'Вся задача выполнена. Спасибо!' };
      }
      const task = this.domain.task(actor, taskId);
      if (terminal(task.status) || task.generation !== revision || !task.assignments.some(a => a.volunteerId === actor.id)) throw failure('Назначение изменилось или задача завершена. Используйте /tasks.');
      this.db.prepare(`INSERT INTO telegram_state(user_id,task_id,generation) VALUES(?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET task_id=excluded.task_id,generation=excluded.generation`).run(actor.id, taskId, revision);
      this.enqueue(`${key}:question-prompt`, actor.id, `Вопрос по задаче №${taskId} «${task.title}».\nОтправьте текст следующим сообщением. Его получит ваш менеджер. /cancel — отменить ввод.`);
      return { text: 'Отправьте текст вопроса следующим сообщением.' };
    }

    if (command) {
      switch (command[1]) {
        case 'tasks': {
          const ids = this.db.prepare(`SELECT a.task_id FROM assignments a JOIN tasks t ON t.id=a.task_id
            WHERE a.volunteer_id=? ORDER BY CASE WHEN t.status IN ('done','cancelled') THEN 1 ELSE 0 END,t.id DESC LIMIT 50`).all(actor.id);
          const tasks = ids.map(row => this.domain.task(actor, row.task_id));
          const lines = tasks.map(t => `${t.blocked ? '⛔ ' : ''}№${t.id} · ${t.title}\n${states[t.status]}${t.awaitingAcceptance ? ' · ожидает принятия' : ''}`);
          this.enqueue(`${key}:tasks`, actor.id, lines.length ? `Ваши задачи\n\n${lines.join('\n\n')}\n\nДействия доступны в сообщениях с заданиями. Показаны последние 50 назначений.` : 'У вас пока нет назначенных задач.');
          for (const t of tasks.filter(t => !terminal(t.status))) this.db.prepare(`INSERT OR IGNORE INTO outbox(event_key,kind,user_id,task_id,payload,status,created_at)
            VALUES(?,'task',?,?,?,'pending',?)`).run(`${key}:task:${t.id}`, actor.id, t.id, '{}', now());
          return null;
        }
        case 'questions': {
          const questions = this.domain.listQuestions(actor, { box: 'incoming' }).filter(q => q.state !== 'closed');
          const lines = questions.map(q => `Вопрос №${q.id} · задача №${q.taskId}${q.blocking ? ' · ⛔ блокирует работу' : ''}\n${q.messages?.at(-1)?.body || ''}\n/reply ${q.id} ваш ответ`);
          this.enqueue(`${key}:questions`, actor.id, lines.length ? `Входящие вопросы\n\n${lines.join('\n\n')}` : 'Открытых входящих вопросов нет.');
          return null;
        }
        case 'reply': {
          const reply = /^(\d+)\s+([\s\S]+)$/.exec(command[2] || '');
          if (!reply) throw failure('Укажите номер вопроса и текст: /reply 123 ваш ответ');
          this.domain.replyQuestion(actor, Number(reply[1]), { body: reply[2].trim() });
          this.enqueue(`${key}:reply`, actor.id, `Ответ добавлен в обсуждение №${reply[1]}. Блокировку снимает явное подтверждение решения.`);
          return null;
        }
        case 'available':
        case 'unavailable':
          this.domain.setAvailability(actor, command[1] === 'available');
          this.enqueue(`${key}:availability`, actor.id, command[1] === 'available' ? 'Вы доступны. Занятость по задачам учитывается отдельно.' : 'Вы отметили себя недоступным. Текущие назначения сохраняются. /available — снова стать доступным.');
          return null;
        case 'cancel':
          this.db.prepare('DELETE FROM telegram_state WHERE user_id=?').run(actor.id);
          this.enqueue(`${key}:cancel`, actor.id, 'Ввод вопроса отменён. Назначенные задачи сохранены.');
          return null;
        case 'start':
        case 'help':
          this.enqueue(`${key}:help`, actor.id, 'Координация волонтёров\n\n/tasks — мои задачи\n/questions — входящие вопросы по вашим направлениям\n/reply номер текст — ответить в обсуждении\n/unavailable — отметить недоступность\n/available — снова стать доступным\n/cancel — отменить ввод вопроса\n/help — эта справка\n\nВ сообщении задания нажмите «Взять в работу», чтобы начать. Одно нажатие «Готово» завершает всю групповую задачу. «Задать вопрос» отправляет вопрос вашему менеджеру.');
          return null;
        default:
          this.enqueue(`${key}:unknown-command`, actor.id, 'Неизвестная команда. /help — доступные команды.');
          return null;
      }
    }
    const pending = this.db.prepare('SELECT * FROM telegram_state WHERE user_id=?').get(actor.id);
    if (pending && body) {
      this.domain.createQuestion(actor, pending.task_id, { body, tagIds: [], blocking: false, urgency: 'normal' }, pending.generation);
      this.db.prepare('DELETE FROM telegram_state WHERE user_id=?').run(actor.id);
      this.enqueue(`${key}:question-sent`, actor.id, 'Вопрос отправлен менеджеру. Ответ придёт сюда.');
    } else {
      this.enqueue(`${key}:choose-task`, actor.id, 'Чтобы задать вопрос, нажмите «Задать вопрос» в сообщении конкретного задания. /tasks — список задач.');
    }
    return null;
  }

  async handleUpdate(update) {
    if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) throw failure('Некорректное событие Telegram.');
    let answer = null;
    let duplicate = false;
    try {
      this.transaction(() => {
        if (this.db.prepare('SELECT 1 FROM telegram_updates WHERE update_id=?').get(update.update_id)) {
          duplicate = true;
          return;
        }
        answer = this.process(update);
        this.db.prepare('INSERT INTO telegram_updates(update_id,created_at) VALUES(?,?)').run(update.update_id, now());
      });
    } catch (error) {
      const text = error.status ? error.message : 'Не удалось выполнить действие. Состояние сохранено. Повторите попытку или обратитесь к менеджеру.';
      answer = { text, show_alert: true };
      // Invalid actions are consumed atomically with an error notification. Unexpected
      // failures stay retryable so a transient database fault cannot lose the event.
      if (!error.status) throw failure(text, 503);
      this.transaction(() => {
        if (this.db.prepare('SELECT 1 FROM telegram_updates WHERE update_id=?').get(update.update_id)) return;
        if (!update.callback_query && update.message?.chat?.type === 'private' && update.message.chat.id === update.message.from?.id) this.enqueueDirect(`telegram:${update.update_id}:error`, update.message.chat.id, text);
        this.db.prepare('INSERT INTO telegram_updates(update_id,created_at) VALUES(?,?)').run(update.update_id, now());
      });
    }
    if (update.callback_query?.id && this.token) {
      await this.call('answerCallbackQuery', { callback_query_id: update.callback_query.id, ...(duplicate ? { text: 'Это действие уже обработано.' } : answer || { text: 'Готово.' }) }).catch(() => {});
    }
    return { duplicate, ...answer };
  }

  async call(method, payload, signal) {
    if (!this.token) throw failure('Telegram-бот не настроен.', 503);
    let response;
    try {
      const requestSignal = AbortSignal.any([signal || AbortSignal.timeout(15000), this.shutdownAbort.signal]);
      response = await this.fetchImpl(`${this.apiBase}/bot${this.token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: requestSignal });
    } catch {
      throw failure('Нет связи с Telegram. Повторная отправка запланирована.', 503);
    }
    let body;
    try { body = await response.json(); } catch { throw failure('Telegram вернул некорректный ответ.', 502); }
    if (!response.ok || !body.ok) {
      if (method === 'editMessageText' && /message is not modified/i.test(body.description || '')) return true;
      const code = body.error_code || response.status;
      const text = code === 403 ? 'Telegram запретил отправку. Волонтёр должен разблокировать бота и нажать /start.' : code === 429 ? 'Telegram ограничил частоту отправки. Будет выполнен повтор.' : `Ошибка Telegram (${code}). Будет выполнен повтор.`;
      const error = failure(text, 502);
      error.telegramCode = code;
      error.retryAfter = Number(body.parameters?.retry_after) || null;
      if (method === 'editMessageText' && /message to edit not found|message can.t be edited/i.test(body.description || '')) error.messageMissing = true;
      throw error;
    }
    return body.result;
  }

  taskCard(taskId, userId, generation) {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
    if (!row) throw failure('Задача удалена или недоступна.', 404);
    const assigned = this.db.prepare('SELECT 1 FROM assignments WHERE task_id=? AND volunteer_id=?').get(taskId, userId);
    const current = Boolean(assigned) && row.generation === generation;
    let task = row;
    if (assigned) task = this.domain.task(this.domain.user(userId), taskId);
    const hallId = task.hallId ?? row.hall_id;
    const hall = this.domain.tags().find(tag => tag.id === hallId)?.name;
    const heading = `Задача №${taskId}${hall ? ` · ${hall}` : ''}\n${task.title}\n\n`;
    const status = `${states[task.status] || task.status}${task.blocked ? ' · ⛔ Заблокирована' : ''}`;
    const assignmentNote = current ? task.awaitingAcceptance ? '\nНазначена вам · ожидает принятия' : '\nВы назначены на эту задачу' : '\nЭто назначение снято. Кнопки недействительны.';
    const description = task.description || '';
    const room = Math.max(0, 3900 - heading.length - status.length - assignmentNote.length - 5);
    const text = `${heading}${description.slice(0, room)}\n\n${status}${assignmentNote}`;
    const inline_keyboard = [];
    if (current && !terminal(task.status)) {
      if (task.status === 'queued') inline_keyboard.push([{ text: 'Взять в работу', callback_data: `accept:${taskId}:${generation}` }]);
      if (task.status === 'in_progress') inline_keyboard.push([{ text: 'Готово', callback_data: `complete:${taskId}:${generation}` }]);
      inline_keyboard.push([{ text: 'Задать вопрос', callback_data: `question:${taskId}:${generation}` }]);
    }
    return { text, reply_markup: { inline_keyboard }, remainder: description.slice(room), current };
  }

  async deliverTask(job, user) {
    if (!this.db.prepare('SELECT id FROM tasks WHERE id=?').get(job.task_id)) throw failure('Задача не найдена.', 404);
    const messages = this.db.prepare('SELECT * FROM telegram_messages WHERE task_id=? AND user_id=? ORDER BY id').all(job.task_id, user.id);
    for (const record of messages) {
      const card = this.taskCard(job.task_id, user.id, record.generation);
      try {
        await this.call('editMessageText', { chat_id: user.chatId, message_id: record.message_id, text: card.text, reply_markup: card.reply_markup });
      } catch (error) {
        if (!error.messageMissing) throw error;
        this.db.prepare('DELETE FROM telegram_messages WHERE id=?').run(record.id);
      }
    }
    // Edits above await Telegram. Read assignment and generation again immediately
    // before sending so an old queue item cannot create a new card after reset.
    const row = this.db.prepare('SELECT generation,status FROM tasks WHERE id=?').get(job.task_id);
    const assigned = this.db.prepare('SELECT 1 FROM assignments WHERE task_id=? AND volunteer_id=?').get(job.task_id, user.id);
    const existing = this.db.prepare('SELECT 1 FROM telegram_messages WHERE task_id=? AND user_id=? AND generation=?').get(job.task_id, user.id, row.generation);
    if (assigned && !existing) {
      const card = this.taskCard(job.task_id, user.id, row.generation);
      const sent = await this.call('sendMessage', { chat_id: user.chatId, text: card.text, reply_markup: card.reply_markup });
      this.db.prepare(`INSERT INTO telegram_messages(task_id,user_id,generation,message_id) VALUES(?,?,?,?)
        ON CONFLICT(task_id,user_id,generation) DO UPDATE SET message_id=excluded.message_id`).run(job.task_id, user.id, row.generation, sent.message_id);
      const latest = this.db.prepare('SELECT generation,status FROM tasks WHERE id=?').get(job.task_id);
      const stillAssigned = this.db.prepare('SELECT 1 FROM assignments WHERE task_id=? AND volunteer_id=?').get(job.task_id, user.id);
      if (latest.generation !== row.generation || latest.status !== row.status || !stillAssigned) {
        this.db.prepare(`INSERT OR IGNORE INTO outbox(event_key,kind,user_id,task_id,payload,status,created_at)
          VALUES(?,'task',?,?,?,'pending',?)`).run(`reconcile:${job.task_id}:${user.id}:${sent.message_id}`, user.id, job.task_id, '{}', now());
      }
      if (card.remainder) {
        this.enqueue(`task-description:${job.task_id}:${user.id}:${row.generation}`, user.id, `Продолжение описания задачи №${job.task_id}\n\n${card.remainder}`);
      }
    }
  }

  drainOutbox() {
    if (this.draining || !this.token) return this.deliveryWork || Promise.resolve();
    this.deliveryWork = this.runOutbox();
    return this.deliveryWork;
  }

  async runOutbox() {
    this.draining = true;
    try {
      const jobs = this.db.prepare("SELECT * FROM outbox WHERE status IN ('pending','failed') AND next_attempt<=? ORDER BY id LIMIT 20").all(Date.now());
      for (const job of jobs) {
        try {
          const payload = JSON.parse(job.payload || '{}');
          const user = job.user_id ? this.domain.user(job.user_id) : null;
          if (job.user_id && (!user?.active || !user.chatId)) throw failure('Волонтёр ещё не подключил Telegram или отключён. Создайте ссылку подключения и повторите отправку.', 409);
          if (job.kind === 'task') {
            if (!user) throw failure('Получатель задания не найден.', 404);
            await this.deliverTask(job, user);
          } else if (job.kind === 'message') {
            const chatId = user?.chatId || payload.chatId;
            if (!Number.isSafeInteger(Number(chatId))) throw failure('Не указан чат получателя.', 409);
            for (const text of chunks(String(payload.text || 'Уведомление'))) await this.call('sendMessage', { chat_id: chatId, text });
          } else throw failure('Неизвестный вид доставки.', 400);
          this.db.prepare("UPDATE outbox SET status='sent',attempts=attempts+1,last_error=NULL WHERE id=?").run(job.id);
        } catch (error) {
          const delay = (error.retryAfter || Math.min(3600, 2 ** Math.min(job.attempts + 1, 11))) * 1000;
          this.db.prepare("UPDATE outbox SET status='failed',attempts=attempts+1,next_attempt=?,last_error=? WHERE id=?").run(Date.now() + delay, error.status ? error.message : 'Не удалось доставить сообщение. Повтор запланирован.', job.id);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  async tick() {
    if (!this.running) return;
    this.pollWork = this.runTick();
    await this.pollWork;
    if (this.running) this.timer = setTimeout(() => this.tick(), this.lastPollError ? 4000 : 100);
  }

  async runTick() {
    try {
      if (!this.initialized) {
        // Bootstrap is retryable too: a network outage at launch must not disable
        // the bot until the server is restarted. Pending updates are preserved.
        await this.call('deleteWebhook', { drop_pending_updates: false });
        await this.call('setMyCommands', { commands: [
          { command: 'tasks', description: 'Мои задачи' },
          { command: 'questions', description: 'Входящие вопросы по направлениям' },
          { command: 'reply', description: 'Ответить: /reply номер текст' },
          { command: 'available', description: 'Я доступен' },
          { command: 'unavailable', description: 'Я недоступен' },
          { command: 'cancel', description: 'Отменить ввод вопроса' },
          { command: 'help', description: 'Помощь' }
        ] });
        this.initialized = true;
      }
      await this.drainOutbox();
      if (!this.running) return;
      const offset = Number(this.db.prepare("SELECT value FROM meta WHERE key='telegram_offset'").get()?.value || 0);
      this.pollAbort = new AbortController();
      const timeout = setTimeout(() => this.pollAbort?.abort(), 35000);
      let updates;
      try {
        updates = await this.call('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, this.pollAbort.signal);
      } finally { clearTimeout(timeout); }
      for (const update of updates) {
        if (!this.running) break;
        await this.handleUpdate(update);
        this.db.prepare("INSERT INTO meta(key,value) VALUES('telegram_offset',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(update.update_id + 1));
      }
      this.lastPollError = null;
      this.lastPollAt = now();
      await this.drainOutbox();
    } catch (error) {
      this.lastPollError = error.status ? error.message : 'Ошибка обработки Telegram. Повторное подключение запланировано.';
    }
  }

  async start() {
    if (this.running || !this.token) return;
    if (this.shutdownAbort.signal.aborted) this.shutdownAbort = new AbortController();
    this.initialized = false;
    this.running = true;
    this.deliveryTimer = setInterval(() => this.drainOutbox().catch(() => {
      this.lastPollError = 'Ошибка очереди доставки. Повтор запланирован.';
    }), 1000);
    this.tick();
  }

  async stop() {
    this.running = false;
    clearTimeout(this.timer);
    clearInterval(this.deliveryTimer);
    this.pollAbort?.abort();
    this.shutdownAbort.abort();
    await Promise.allSettled([this.pollWork, this.deliveryWork].filter(Boolean));
  }
}
