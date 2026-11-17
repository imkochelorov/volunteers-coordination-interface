package coordination

import java.time.Instant
import java.util.Base64

internal data class TelegramUpdate(
    val id: Long,
    val chatId: Long?,
    val callbackId: String?,
    val callbackData: String,
    val text: String,
    val replyToMessageId: Long?,
) {
    val eventKey: String get() = "telegram:$id"

    companion object {
        fun parse(input: Data): TelegramUpdate {
            val id = input.longOrNull("update_id")?.takeIf { it in 0 until Long.MAX_VALUE }
                ?: fail(400, "Некорректное событие Telegram.")
            val callback = input["callback_query"].objectOrEmpty()
            val incoming = input["message"].objectOrEmpty()
            val message = (callback["message"] ?: incoming).objectOrEmpty()
            val sender = (callback["from"] ?: message["from"]).objectOrEmpty()
            val chat = message["chat"].objectOrEmpty()
            val chatId = chat.longOrNull("id")?.takeIf {
                chat.string("type") == "private" && it == sender.longOrNull("id") && !sender.enabled("is_bot")
            }
            return TelegramUpdate(
                id, chatId, callback.string("id").takeIf(String::isNotEmpty), callback.string("data"),
                incoming.string("text"), incoming["reply_to_message"].objectOrEmpty().longOrNull("message_id"),
            )
        }
    }
}

private val commandPattern = Regex("""/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?""")
private val actionPattern = Regex("""(accept|complete|question):(\d+):(\d+)""")
private val replyPattern = Regex("""(\d+)\s+([\s\S]+)""")
internal val telegramTaskStatuses = mapOf("queued" to "В очереди", "in_progress" to "В процессе", "done" to "Выполнена", "cancelled" to "Отменена")
internal val telegramCommands = linkedMapOf("tasks" to "Мои задачи", "questions" to "Входящие вопросы по направлениям",
    "reply" to "Ответить: /reply номер текст", "available" to "Я доступен", "unavailable" to "Я недоступен",
    "cancel" to "Отменить ввод вопроса", "help" to "Помощь")

internal class TelegramUpdates(
    private val domain: Domain,
    private val discussions: Discussions,
    private val configured: Boolean,
    private val username: String,
) {
    private val db = domain.db

    fun createLink(actor: Long, target: Long): Data = db.transaction {
        val current = domain.manager(actor)
        val volunteer = domain.user(target)
        if (!volunteer.profile.active || !volunteer.isVolunteer) fail(404, "Волонтёр не найден.")
        if (!current.isAdmin && volunteer.profile.managerId != actor) fail(403, "Можно подключать только волонтёров своего пула.")
        if (!configured) fail(503, "Настройте TELEGRAM_BOT_TOKEN и TELEGRAM_BOT_USERNAME на сервере.")
        if (volunteer.telegramId != null) fail(409, "Волонтёр уже подключён к Telegram.")
        val token = Base64.getUrlEncoder().withoutPadding().encodeToString(randomBytes(24))
        val expires = milliseconds() + 86400000
        db.execute("DELETE FROM link_tokens WHERE user_id=? AND used_at IS NULL", target)
        db.execute("INSERT INTO link_tokens(token_hash,user_id,expires_at) VALUES(?,?,?)", hashToken(token), target, expires)
        mapOf("url" to "https://t.me/$username?start=$token", "expiresAt" to Instant.ofEpochMilli(expires).toString())
    }

    fun message(event: String, user: Long?, body: String, chat: Long? = null) {
        domain.enqueue("message", user, null, mapOf("text" to body, "chatId" to chat), event)
    }
    private fun link(chat: Long, token: String, event: String) {
        if (!token.matches(Regex("[A-Za-z0-9_-]{20,64}"))) fail(400, "Ссылка подключения неверна. Попросите менеджера создать новую.")
        val hash = hashToken(token)
        val invite = db.one("SELECT * FROM link_tokens WHERE token_hash=?", hash)
        val now = milliseconds()
        if (invite == null || invite["used_at"] != null || invite.requiredLong("expires_at") <= now) {
            fail(400, "Ссылка использована или срок её действия истёк. Попросите менеджера создать новую.")
        }
        val user = domain.user(invite.requiredLong("user_id"))
        val id = user.id
        if (!user.profile.active || !user.isVolunteer) fail(409, "Подключение этого волонтёра недоступно.")
        if (db.one("SELECT id FROM users WHERE telegram_id=? AND id!=?", chat, id) != null ||
            (user.telegramId != null && user.telegramId != chat)) {
            fail(409, "Telegram уже связан с другим участником. Обратитесь к администратору.")
        }
        db.execute("UPDATE users SET telegram_id=?,chat_id=? WHERE id=?", chat, chat, id)
        db.execute("UPDATE link_tokens SET used_at=? WHERE token_hash=?", now, hash)
        message(event, id, "Здравствуйте, ${user.profile.name}! Telegram подключён.\n\n/tasks — мои задачи, /help — помощь.")
        db.execute("UPDATE outbox SET status='pending',next_attempt=0 WHERE user_id=? AND status='failed'", id)
    }

    fun process(update: TelegramUpdate, chat: Long): String? {
        val event = update.eventKey
        val callback = update.callbackId
        val body = update.text.trim()
        val command = commandPattern.matchEntire(body)
        val name = command?.groupValues?.get(1)
        val argument = command?.groupValues?.get(2).orEmpty().trim()
        if (callback == null && name == "start" && argument.isNotEmpty()) {
            link(chat, argument, "$event:welcome")
            return null
        }
        val row = db.one("SELECT id FROM users WHERE telegram_id=? AND active=1", chat)
        val actor = row?.requiredLong("id")
        if (actor == null || !domain.user(actor).isVolunteer) {
            message("$event:unknown", null, "Попросите менеджера прислать личную ссылку и нажмите «Начать».", chat)
            return "Сначала подключитесь по ссылке менеджера."
        }
        if (callback != null) return action(update.callbackData, actor, event)
        if (name != null) {
            processCommand(name, argument, actor, event)
            return null
        }
        val repliedMessage = update.replyToMessageId
        if (repliedMessage != null && body.isNotEmpty()) {
            val thread = db.one("SELECT question_id FROM telegram_question_messages WHERE chat_id=? AND message_id=?",
                chat, repliedMessage)?.requiredLong("question_id")
            if (thread != null) {
                message("$event:reply", actor, replyInThread(actor, thread, body))
            } else {
                message("$event:reply-hint", actor, "Это сообщение не связано с обсуждением. Откройте /questions и ответьте в нужном треде.")
            }
            return null
        }
        val pending = db.one("SELECT * FROM telegram_state WHERE user_id=?", actor)
        if (pending != null && body.isNotEmpty()) {
            discussions.create(
                actor, pending.requiredLong("task_id"), QuestionInput(text(body, "Вопрос", 10000)),
                pending.requiredLong("generation"),
            )
            db.execute("DELETE FROM telegram_state WHERE user_id=?", actor)
            message("$event:question", actor, "Вопрос отправлен менеджеру. Ответ придёт сюда.")
        } else {
            message("$event:hint", actor, "Продолжить обсуждение — /questions. Задать новый вопрос — /tasks → «Новый вопрос».")
        }
        return null
    }

    private fun replyInThread(actor: Long, questionId: Long, body: String): String {
        discussions.reply(actor, questionId, text(body, "Ответ", 10000))
        db.execute("DELETE FROM telegram_state WHERE user_id=?", actor)
        return "Ответ добавлен в обсуждение №$questionId."
    }

    private fun action(data: String, actor: Long, event: String): String {
        val match = actionPattern.matchEntire(data) ?: fail(400, "Эта кнопка больше не поддерживается. Используйте /tasks.")
        val (action, taskId, revision) = match.destructured
        val task = id(taskId)
        val generation = id(revision)
        return when (action) {
            "accept" -> {
                domain.taskWorkflow.accept(actor, task, generation)
                "Задача в процессе."
            }
            "complete" -> {
                domain.taskWorkflow.complete(actor, task, generation)
                "Вся задача выполнена. Спасибо!"
            }
            else -> {
                val current = domain.rawTask(task)
                domain.active(current, generation)
                if (!domain.assigned(task, actor)) fail(403, "Назначение недоступно. Используйте /tasks.")
                db.execute("""INSERT INTO telegram_state(user_id,task_id,generation) VALUES(?,?,?)
                    ON CONFLICT(user_id) DO UPDATE SET task_id=excluded.task_id,generation=excluded.generation""", actor, task, generation)
                message("$event:prompt", actor, "Новый вопрос по задаче №$task «${current.title}».\nНапишите его обычным сообщением. /cancel — отменить.")
                "Напишите новый вопрос обычным сообщением."
            }
        }
    }

    private fun processCommand(name: String, argument: String, actor: Long, event: String) {
        val response = when (name) {
            "tasks" -> {
                val tasks = db.all("""SELECT t.* FROM assignments a JOIN tasks t ON t.id=a.task_id WHERE a.volunteer_id=?
                    ORDER BY CASE WHEN t.status IN ('done','cancelled') THEN 1 ELSE 0 END,t.id DESC LIMIT 50""", actor).map(Task::fromRow)
                for (task in tasks.filterNot { it.status.isTerminal }) {
                    domain.enqueue("task", actor, task.id, event = "$event:task:${task.id}")
                }
                if (tasks.isEmpty()) "У вас пока нет назначенных задач." else domain.taskSummaries(tasks).joinToString("\n\n", "Ваши задачи\n\n") { view ->
                    val task = view.task
                    val blocked = if (view.blocked) "⛔ " else ""
                    val awaitingMyAcceptance = !task.status.isTerminal &&
                        view.assignments.any { it.volunteerId == actor && it.acceptedAt == null }
                    val pending = if (awaitingMyAcceptance) " · ожидает вашего принятия" else ""
                    "$blocked№${task.id} · ${task.title}\n${telegramTaskStatuses.getValue(task.status.code)}$pending"
                }
            }
            "questions" -> {
                val items = discussions.telegramThreads(actor)
                if (items.isEmpty()) "Открытых обсуждений нет." else items.joinToString("\n\n", "Открытые обсуждения\n\n") { q ->
                    val blocked = if (q.enabled("blocking")) " · блокирует работу" else ""
                    "Вопрос №${q["id"]} · задача №${q["taskId"]}$blocked\n${q["messages"].objects().lastOrNull()?.string("body").orEmpty()}\n/reply ${q["id"]} ваш ответ"
                }
            }
            "reply" -> {
                val match = replyPattern.matchEntire(argument) ?: fail(400, "Укажите номер вопроса и текст: /reply 123 ваш ответ")
                replyInThread(actor, id(match.groupValues[1]), match.groupValues[2])
            }
            "available", "unavailable" -> {
                val available = name == "available"
                domain.pool.setAvailability(actor, available)
                if (available) "Вы доступны. Занятость по задачам учитывается отдельно."
                else "Вы недоступны. Текущие назначения сохраняются. /available — снова стать доступным."
            }
            "cancel" -> {
                db.execute("DELETE FROM telegram_state WHERE user_id=?", actor)
                "Ввод вопроса отменён."
            }
            "start", "help" -> telegramCommands.entries.joinToString("\n", "Координация волонтёров\n\n") { (key, label) -> "/$key — $label" }
            else -> "Неизвестная команда. /help — доступные команды."
        }
        message("$event:$name", actor, response)
    }
}
