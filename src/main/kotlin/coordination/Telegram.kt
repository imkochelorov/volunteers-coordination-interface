package coordination

import java.io.Closeable
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.time.Instant
import java.util.Base64
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

fun interface TelegramApi {
    fun call(method: String, payload: Data): Any?
}

private class DeliveryError(message: String, val retry: Long? = null, val missing: Boolean = false) : RuntimeException(message)

class TelegramHttp(private val token: String) : TelegramApi {
    private val client by lazy { HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build() }

    override fun call(method: String, payload: Data): Any? {
        val request = HttpRequest.newBuilder(URI.create("https://api.telegram.org/bot$token/$method"))
            .timeout(Duration.ofSeconds(if (method == "getUpdates") 35 else 15))
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(json(payload))).build()
        val response = try {
            client.send(request, HttpResponse.BodyHandlers.ofString())
        } catch (error: InterruptedException) {
            throw error
        } catch (_: Exception) {
            throw DeliveryError("Нет связи с Telegram. Повторная отправка запланирована.")
        }
        val body = try { decode(response.body()).objectOrEmpty() } catch (_: Exception) {
            throw DeliveryError("Telegram вернул некорректный ответ.")
        }
        if (response.statusCode() in 200..299 && body.enabled("ok")) return body["result"]
        val description = body.string("description")
        if (method == "editMessageText" && description.contains("message is not modified", ignoreCase = true)) return true
        val code = body.longOrNull("error_code") ?: response.statusCode().toLong()
        val message = when (code) {
            403L -> "Волонтёр должен разблокировать бота и нажать /start."
            429L -> "Telegram ограничил частоту отправки. Будет выполнен повтор."
            else -> "Ошибка Telegram ($code). Будет выполнен повтор."
        }
        throw DeliveryError(message, body["parameters"].objectOrEmpty().longOrNull("retry_after"),
            method == "editMessageText" && Regex("message to edit not found|message can.t be edited", RegexOption.IGNORE_CASE).containsMatchIn(description))
    }
}

private val commandPattern = Regex("""/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?""")
private val actionPattern = Regex("""(accept|complete|question):(\d+):(\d+)""")
private val replyPattern = Regex("""(\d+)\s+([\s\S]+)""")
private val states = mapOf("queued" to "В очереди", "in_progress" to "В процессе", "done" to "Выполнена", "cancelled" to "Отменена")
private val commands = linkedMapOf("tasks" to "Мои задачи", "questions" to "Входящие вопросы по направлениям",
    "reply" to "Ответить: /reply номер текст", "available" to "Я доступен", "unavailable" to "Я недоступен",
    "cancel" to "Отменить ввод вопроса", "help" to "Помощь")

class Telegram(
    private val domain: Domain,
    private val discussions: Discussions,
    private val configured: Boolean,
    private val username: String,
    private val api: TelegramApi,
) : Closeable {
    private val db = domain.db
    private val workers = Executors.newScheduledThreadPool(2)
    @Volatile private var running = false
    @Volatile private var lastPoll: String? = null
    @Volatile private var pollError: String? = null
    private var initialized = false

    fun status(): Data = mapOf("configured" to configured, "running" to running,
        "username" to username.ifEmpty { null }, "lastPollAt" to lastPoll, "error" to pollError)

    fun createLink(actor: Long, target: Long): Data = db.transaction {
        val current = domain.manager(actor)
        val volunteer = domain.user(target)
        if (!volunteer.enabled("active") || !volunteer.hasRole("volunteer")) fail(404, "Волонтёр не найден.")
        if (!current.hasRole("admin") && volunteer.longOrNull("managerId") != actor) fail(403, "Можно подключать только волонтёров своего пула.")
        if (!configured) fail(503, "Настройте TELEGRAM_BOT_TOKEN и TELEGRAM_BOT_USERNAME на сервере.")
        if (volunteer.longOrNull("telegramId") != null) fail(409, "Волонтёр уже подключён к Telegram.")
        val token = Base64.getUrlEncoder().withoutPadding().encodeToString(randomBytes(24))
        val expires = milliseconds() + 86400000
        db.execute("DELETE FROM link_tokens WHERE user_id=? AND used_at IS NULL", target)
        db.execute("INSERT INTO link_tokens(token_hash,user_id,expires_at) VALUES(?,?,?)", hashToken(token), target, expires)
        mapOf("url" to "https://t.me/$username?start=$token", "expiresAt" to Instant.ofEpochMilli(expires).toString())
    }

    private fun message(event: String, user: Long?, body: String, chat: Long? = null) {
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
        val id = user.requiredLong("id")
        if (!user.enabled("active") || !user.hasRole("volunteer")) fail(409, "Подключение этого волонтёра недоступно.")
        if (db.one("SELECT id FROM users WHERE telegram_id=? AND id!=?", chat, id) != null ||
            (user.longOrNull("telegramId") != null && user.longOrNull("telegramId") != chat)) {
            fail(409, "Telegram уже связан с другим участником. Обратитесь к администратору.")
        }
        db.execute("UPDATE users SET telegram_id=?,chat_id=? WHERE id=?", chat, chat, id)
        db.execute("UPDATE link_tokens SET used_at=? WHERE token_hash=?", now, hash)
        message(event, id, "Здравствуйте, ${user.string("name")}! Telegram подключён.\n\n/tasks — мои задачи, /help — помощь.")
        db.execute("UPDATE outbox SET status='pending',next_attempt=0 WHERE user_id=? AND status='failed'", id)
    }

    private fun privateChat(update: Data): Long? {
        val callback = update["callback_query"].objectOrEmpty()
        val message = (callback["message"] ?: update["message"]).objectOrEmpty()
        val sender = (callback["from"] ?: message["from"]).objectOrEmpty()
        val chat = message["chat"].objectOrEmpty()
        return chat.longOrNull("id")?.takeIf { chat.string("type") == "private" && it == sender.longOrNull("id") && !sender.enabled("is_bot") }
    }

    fun handle(update: Data) {
        val id = update.longOrNull("update_id")?.takeIf { it >= 0 } ?: fail(400, "Некорректное событие Telegram.")
        val chat = privateChat(update)
        val callback = update["callback_query"].objectOrEmpty()
        val event = "telegram:$id"
        val answer = try {
            db.transaction {
                if (db.one("SELECT 1 FROM telegram_updates WHERE update_id=?", id) != null) {
                    return@transaction mapOf("text" to "Это действие уже обработано.")
                }
                val result = chat?.let { process(update, it, event) }
                db.execute("INSERT INTO telegram_updates(update_id,created_at) VALUES(?,?)", id, stamp())
                mapOf("text" to (result ?: "Готово."))
            }
        } catch (error: AppError) {
            db.transaction {
                val count = db.execute("INSERT OR IGNORE INTO telegram_updates(update_id,created_at) VALUES(?,?)", id, stamp())
                if (count != 0 && chat != null && callback.isEmpty()) message("$event:error", null, error.message.orEmpty(), chat)
            }
            mapOf("text" to error.message, "show_alert" to true)
        }
        if (configured && callback.string("id").isNotEmpty()) {
            try {
                api.call("answerCallbackQuery", answer + ("callback_query_id" to callback.string("id")))
            } catch (_: DeliveryError) {
                // The business operation has already committed.
            }
        }
    }

    private fun process(update: Data, chat: Long, event: String): String? {
        val callback = update["callback_query"].objectOrEmpty()
        val incoming = update["message"].objectOrEmpty()
        val body = incoming.string("text").trim()
        val command = commandPattern.matchEntire(body)
        val name = command?.groupValues?.get(1)
        val argument = command?.groupValues?.get(2).orEmpty().trim()
        if (callback.isEmpty() && name == "start" && argument.isNotEmpty()) {
            link(chat, argument, "$event:welcome")
            return null
        }
        val row = db.one("SELECT id FROM users WHERE telegram_id=? AND active=1", chat)
        val actor = row?.requiredLong("id")
        if (actor == null || !domain.user(actor).hasRole("volunteer")) {
            message("$event:unknown", null, "Попросите менеджера прислать личную ссылку и нажмите «Начать».", chat)
            return "Сначала подключитесь по ссылке менеджера."
        }
        if (callback.isNotEmpty()) return action(callback.string("data"), actor, event)
        if (name != null) {
            processCommand(name, argument, actor, event)
            return null
        }
        val repliedMessage = incoming["reply_to_message"].objectOrEmpty().longOrNull("message_id")
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
            discussions.create(actor, pending.requiredLong("task_id"), mapOf("body" to body), pending.requiredLong("generation"))
            db.execute("DELETE FROM telegram_state WHERE user_id=?", actor)
            message("$event:question", actor, "Вопрос отправлен менеджеру. Ответ придёт сюда.")
        } else {
            message("$event:hint", actor, "Продолжить обсуждение — /questions. Задать новый вопрос — /tasks → «Новый вопрос».")
        }
        return null
    }

    private fun replyInThread(actor: Long, questionId: Long, body: String): String {
        discussions.reply(actor, questionId, mapOf("body" to body))
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
                domain.accept(actor, task, generation)
                "Задача в процессе."
            }
            "complete" -> {
                domain.complete(actor, task, generation)
                db.execute("DELETE FROM telegram_state WHERE task_id=?", task)
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
                if (tasks.isEmpty()) "У вас пока нет назначенных задач." else tasks.joinToString("\n\n", "Ваши задачи\n\n") { task ->
                    val view = domain.taskSummary(task)
                    val blocked = if (view.blocked) "⛔ " else ""
                    val pending = if (view.awaitingAcceptance) " · ожидает принятия" else ""
                    "$blocked№${task.id} · ${task.title}\n${states.getValue(task.status.code)}$pending"
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
                domain.availability(actor, available)
                if (available) "Вы доступны. Занятость по задачам учитывается отдельно."
                else "Вы недоступны. Текущие назначения сохраняются. /available — снова стать доступным."
            }
            "cancel" -> {
                db.execute("DELETE FROM telegram_state WHERE user_id=?", actor)
                "Ввод вопроса отменён."
            }
            "start", "help" -> commands.entries.joinToString("\n", "Координация волонтёров\n\n") { (key, label) -> "/$key — $label" }
            else -> "Неизвестная команда. /help — доступные команды."
        }
        message("$event:$name", actor, response)
    }

    private data class Card(val text: String, val keyboard: Data, val remaining: String)
    private fun card(taskId: Long, actor: Long, generation: Long): Card {
        val task = domain.rawTask(taskId)
        val view = domain.taskSummary(task)
        val current = domain.assigned(taskId, actor) && task.generation == generation
        val hall = domain.tags().find { it.longOrNull("id") == task.hallId }?.string("name")?.let { " · $it" }.orEmpty()
        val label = if (task.description.startsWith(task.title)) "" else "\n${task.title}"
        val options = buildList {
            if (task.priority != TaskPriority.NORMAL) add("Приоритет: ${task.priority.label.lowercase()}")
            if (task.needsStrongVolunteers) add("Нужны сильные волонтёры")
            if (task.volunteerTarget.isNotEmpty()) add("Нужно волонтёров: ${task.volunteerTarget}")
        }.joinToString(" · ")
        val heading = "Задача №$taskId$hall$label" + if (options.isEmpty()) "\n\n" else "\n$options\n\n"
        val status = states.getValue(task.status.code) + if (view.blocked) " · ⛔ Заблокирована" else ""
        val note = when {
            !current -> "Это назначение снято. Кнопки недействительны."
            view.awaitingAcceptance -> "Назначена вам · ожидает принятия"
            else -> "Вы назначены на эту задачу"
        }
        val description = task.description
        val room = (3900 - heading.length - status.length - note.length - 4).coerceAtLeast(0)
        val split = safeBoundary(description, room)
        val keyboard = buildList {
            fun button(label: String, action: String) = listOf(mapOf("text" to label, "callback_data" to "$action:$taskId:$generation"))
            if (current && !task.status.isTerminal) {
                if (task.status == TaskStatus.QUEUED) add(button("Взять в работу", "accept"))
                if (task.status == TaskStatus.IN_PROGRESS) add(button("Готово", "complete"))
                add(button("Новый вопрос", "question"))
            }
        }
        return Card("$heading${description.take(split)}\n\n$status\n$note", mapOf("inline_keyboard" to keyboard), description.drop(split))
    }

    private fun safeBoundary(text: String, limit: Int): Int {
        val end = limit.coerceAtMost(text.length)
        return if (end in 1 until text.length && text[end - 1].isHighSurrogate()) end - 1 else end
    }

    private fun deliverTask(task: Long, user: Long, chat: Long) {
        val edits = db.all("SELECT * FROM telegram_messages WHERE task_id=? AND user_id=? ORDER BY id", task, user)
        for (record in edits) {
            val card = db.access { card(task, user, record.requiredLong("generation")) }
            try {
                api.call("editMessageText", mapOf("chat_id" to chat, "message_id" to record["message_id"],
                    "text" to card.text, "reply_markup" to card.keyboard))
            } catch (error: DeliveryError) {
                if (!error.missing) throw error
                db.execute("DELETE FROM telegram_messages WHERE id=?", record["id"])
            }
        }
        val pending = db.access {
            val state = domain.rawTask(task)
            val generation = state.generation
            val exists = db.one("SELECT 1 FROM telegram_messages WHERE task_id=? AND user_id=? AND generation=?", task, user, generation) != null
            if (exists || !domain.assigned(task, user)) null else generation to card(task, user, generation)
        } ?: return
        val (generation, card) = pending
        val sent = api.call("sendMessage", mapOf("chat_id" to chat, "text" to card.text, "reply_markup" to card.keyboard)).objectOrEmpty()
        val messageId = sent.requiredLong("message_id")
        db.transaction {
            db.execute("""INSERT INTO telegram_messages(task_id,user_id,generation,message_id) VALUES(?,?,?,?)
                ON CONFLICT(task_id,user_id,generation) DO UPDATE SET message_id=excluded.message_id""", task, user, generation, messageId)
            if (card != card(task, user, generation)) domain.enqueue("task", user, task, event = "reconcile:$task:$user:$messageId")
            if (card.remaining.isNotEmpty()) message("task-description:$task:$user:$generation", user,
                "Продолжение описания задачи №$task\n\n${card.remaining}")
        }
    }

    fun drain() {
        val jobs = db.all("SELECT * FROM outbox WHERE status IN ('pending','failed') AND next_attempt<=? ORDER BY id LIMIT 20", milliseconds())
        for (job in jobs) {
            if (Thread.currentThread().isInterrupted) return
            val id = job.requiredLong("id")
            try {
                val payload = decode(job.string("payload")).objectOrEmpty()
                val user = job.longOrNull("user_id")?.let { domain.user(it) }
                if (user != null && (!user.enabled("active") || user.longOrNull("chatId") == null)) {
                    fail(409, "Волонтёр ещё не подключил Telegram или отключён.")
                }
                val chat = user?.longOrNull("chatId") ?: payload.longOrNull("chatId") ?: fail(409, "Не указан чат получателя.")
                when (job.string("kind")) {
                    "task" -> deliverTask(job.requiredLong("task_id"), checkNotNull(user).requiredLong("id"), chat)
                    "message" -> {
                        var remaining = payload.string("text").ifEmpty { "Уведомление" }
                        val questionId = payload.longOrNull("questionId")
                        while (remaining.isNotEmpty()) {
                            val end = safeBoundary(remaining, 3800)
                            val prompt = if (questionId != null && payload.enabled("forceReply") && end == remaining.length) {
                                mapOf("reply_markup" to mapOf("force_reply" to true, "input_field_placeholder" to "Продолжить обсуждение"))
                            } else emptyMap()
                            val sent = api.call("sendMessage", mapOf("chat_id" to chat, "text" to remaining.take(end)) + prompt)
                            if (questionId != null) {
                                val messageId = sent.objectOrEmpty().requiredLong("message_id")
                                db.execute("INSERT OR IGNORE INTO telegram_question_messages(chat_id,message_id,question_id) VALUES (?,?,?)",
                                    chat, messageId, questionId)
                            }
                            remaining = remaining.drop(end)
                        }
                    }
                    else -> fail(400, "Неизвестный вид доставки.")
                }
                db.execute("UPDATE outbox SET status='sent',attempts=attempts+1,last_error=NULL WHERE id=?", id)
            } catch (error: InterruptedException) {
                Thread.currentThread().interrupt()
                return
            } catch (error: Exception) {
                val delay = (error as? DeliveryError)?.retry ?: (1L shl (job.requiredLong("attempts") + 1).coerceAtMost(11).toInt())
                val reason = if (error is AppError || error is DeliveryError) error.message else "Не удалось доставить сообщение. Повтор запланирован."
                db.execute("UPDATE outbox SET status='failed',attempts=attempts+1,next_attempt=?,last_error=? WHERE id=?",
                    milliseconds() + delay * 1000, reason, id)
            }
        }
    }

    private fun poll() {
        if (!running) return
        try {
            if (!initialized) {
                api.call("deleteWebhook", mapOf("drop_pending_updates" to false))
                api.call("setMyCommands", mapOf("commands" to commands.map { (name, label) -> mapOf("command" to name, "description" to label) }))
                initialized = true
            }
            val offset = db.one("SELECT value FROM meta WHERE key='telegram_offset'")?.longOrNull("value") ?: 0
            val updates = api.call("getUpdates", mapOf("offset" to offset, "timeout" to 25,
                "allowed_updates" to listOf("message", "callback_query"))).objects()
            for (update in updates) {
                if (!running) return
                handle(update)
                db.execute("""INSERT INTO meta(key,value) VALUES('telegram_offset',?)
                    ON CONFLICT(key) DO UPDATE SET value=excluded.value""", (update.requiredLong("update_id") + 1).toString())
            }
            lastPoll = stamp()
            pollError = null
        } catch (error: InterruptedException) {
            Thread.currentThread().interrupt()
            return
        } catch (error: Exception) {
            pollError = if (error is DeliveryError) error.message else "Ошибка обработки Telegram. Повторное подключение запланировано."
        }
        if (running) workers.schedule(::poll, if (pollError == null) 100 else 4000, TimeUnit.MILLISECONDS)
    }

    fun start() {
        if (running || !configured) return
        running = true
        workers.execute(::poll)
        workers.scheduleWithFixedDelay({
            try { drain() } catch (_: Exception) { pollError = "Ошибка очереди доставки. Повтор запланирован." }
        }, 0, 1, TimeUnit.SECONDS)
    }

    override fun close() {
        running = false
        workers.shutdownNow()
        workers.awaitTermination(5, TimeUnit.SECONDS)
    }
}
