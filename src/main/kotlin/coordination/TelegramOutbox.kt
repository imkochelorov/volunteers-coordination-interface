package coordination

internal fun telegramTextEnd(text: String, limit: Int): Int {
    val end = limit.coerceAtMost(text.length)
    return if (end in 1 until text.length && text[end - 1].isHighSurrogate()) end - 1 else end
}

internal class TelegramOutbox(private val domain: Domain, private val api: TelegramApi) {
    private val db = domain.db

    private data class Card(val text: String, val keyboard: Data, val remaining: String)
    private fun card(taskId: Long, actor: Long, generation: Long): Card {
        val task = domain.rawTask(taskId)
        val view = domain.taskSummary(task)
        val assignment = view.assignments.firstOrNull { it.volunteerId == actor }
        val current = assignment != null && task.generation == generation
        val hall = domain.tags().find { it.longOrNull("id") == task.hallId }?.string("name")?.let { " · $it" }.orEmpty()
        val label = if (task.description.startsWith(task.title)) "" else "\n${task.title}"
        val options = buildList {
            if (task.priority != TaskPriority.NORMAL) add("Приоритет: ${task.priority.label.lowercase()}")
            if (task.needsStrongVolunteers) add("Нужны сильные волонтёры")
            if (task.volunteerTarget.isNotEmpty()) add("Нужно волонтёров: ${task.volunteerTarget}")
        }.joinToString(" · ")
        val heading = "Задача №$taskId$hall$label" + if (options.isEmpty()) "\n\n" else "\n$options\n\n"
        val status = telegramTaskStatuses.getValue(task.status.code) + if (view.blocked) " · ⛔ Заблокирована" else ""
        val note = when {
            task.status == TaskStatus.CANCELLED && assignment != null -> "Задача отменена."
            !current -> "Это назначение снято. Кнопки недействительны."
            assignment?.acceptedAt == null && !task.status.isTerminal -> "Назначена вам · ожидает принятия"
            else -> "Вы назначены на эту задачу"
        }
        val description = task.description
        val room = (3900 - heading.length - status.length - note.length - 4).coerceAtLeast(0)
        val split = telegramTextEnd(description, room)
        val keyboard = buildList {
            fun button(label: String, action: String) = listOf(mapOf("text" to label, "callback_data" to "$action:$taskId:$generation"))
            if (current && !task.status.isTerminal) {
                if (assignment?.acceptedAt == null) add(button("Взять в работу", "accept"))
                if (task.status == TaskStatus.IN_PROGRESS) add(button("Готово", "complete"))
                add(button("Новый вопрос", "question"))
            }
        }
        return Card("$heading${description.take(split)}\n\n$status\n$note", mapOf("inline_keyboard" to keyboard), description.drop(split))
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
            val exists = db.one(
                "SELECT 1 FROM telegram_messages WHERE task_id=? AND user_id=? AND (generation=? OR ?=1)",
                task, user, generation, if (state.status.isTerminal) 1 else 0,
            ) != null
            if (exists || !domain.assigned(task, user)) null else generation to card(task, user, generation)
        } ?: return
        val (generation, card) = pending
        val sent = api.call("sendMessage", mapOf("chat_id" to chat, "text" to card.text, "reply_markup" to card.keyboard)).objectOrEmpty()
        val messageId = sent.requiredLong("message_id")
        db.transaction {
            db.execute("""INSERT INTO telegram_messages(task_id,user_id,generation,message_id) VALUES(?,?,?,?)
                ON CONFLICT(task_id,user_id,generation) DO UPDATE SET message_id=excluded.message_id""", task, user, generation, messageId)
            if (card != card(task, user, generation)) domain.enqueue("task", user, task, event = "reconcile:$task:$user:$messageId")
            if (card.remaining.isNotEmpty()) {
                domain.enqueue(
                    "message", user, task,
                    mapOf("text" to "Продолжение описания задачи №$task\n\n${card.remaining}"),
                    "task-description:$task:$user:$generation",
                )
            }
        }
    }

    private enum class Kind(val code: String) { TASK("task"), MESSAGE("message") }

    private data class Job(
        val id: Long,
        val kind: Kind,
        val userId: Long?,
        val taskId: Long?,
        val payload: Data,
    )

    private fun job(row: Data): Job = Job(
        id = row.requiredLong("id"),
        kind = Kind.entries.firstOrNull { it.code == row.string("kind") } ?: fail(400, "Неизвестный вид доставки."),
        userId = row.longOrNull("user_id"),
        taskId = row.longOrNull("task_id"),
        payload = decode(row.string("payload")).objectOrEmpty(),
    )

    @Synchronized
    fun drain() {
        val rows = db.all(
            """SELECT * FROM outbox WHERE status IN ('pending','failed')
                AND next_attempt<=? ORDER BY id LIMIT 20""", milliseconds(),
        )
        for (row in rows) {
            if (Thread.currentThread().isInterrupted) return
            val id = row.requiredLong("id")
            try {
                deliver(job(row))
                db.execute("UPDATE outbox SET status='sent',attempts=attempts+1,last_error=NULL WHERE id=?", id)
            } catch (error: InterruptedException) {
                Thread.currentThread().interrupt()
                return
            } catch (error: Exception) {
                val delay = (error as? DeliveryError)?.retry?.coerceAtLeast(1)
                    ?: (1L shl (row.requiredLong("attempts") + 1).coerceIn(1, 11).toInt())
                val reason = when (error) {
                    is AppError, is DeliveryError -> error.message
                    else -> "Не удалось доставить сообщение. Повтор запланирован."
                }
                db.execute(
                    "UPDATE outbox SET status='failed',attempts=attempts+1,next_attempt=?,last_error=? WHERE id=?",
                    milliseconds() + delay.coerceAtMost(86400) * 1000, reason, id,
                )
            }
        }
    }

    private fun deliver(job: Job) {
        val user = job.userId?.let(domain::user)
        if (user != null && (!user.profile.active || !user.isVolunteer || user.chatId == null)) {
            fail(409, "Волонтёр ещё не подключил Telegram или отключён.")
        }
        val chat = user?.chatId ?: job.payload.longOrNull("chatId") ?: fail(409, "Не указан чат получателя.")
        when (job.kind) {
            Kind.TASK -> deliverTask(checkNotNull(job.taskId), checkNotNull(user).id, chat)
            Kind.MESSAGE -> deliverMessage(job, chat)
        }
    }

    private fun deliverMessage(job: Job, chat: Long) {
        val text = job.payload.string("text").ifEmpty { "Уведомление" }
        val question = job.payload.longOrNull("questionId")
        var offset = job.payload.longOrNull("sentChars")?.takeIf { it in 0..text.length.toLong() }?.toInt() ?: 0
        while (offset < text.length) {
            val end = offset + telegramTextEnd(text.substring(offset), 3800)
            val payload = buildMap {
                put("chat_id", chat)
                put("text", text.substring(offset, end))
                if (question != null && job.payload.enabled("forceReply") && end == text.length) {
                    put("reply_markup", mapOf("force_reply" to true, "input_field_placeholder" to "Продолжить обсуждение"))
                }
            }
            val sent = api.call("sendMessage", payload)
            db.transaction {
                if (question != null) {
                    val messageId = sent.objectOrEmpty().requiredLong("message_id")
                    db.execute(
                        "INSERT OR IGNORE INTO telegram_question_messages(chat_id,message_id,question_id) VALUES (?,?,?)",
                        chat, messageId, question,
                    )
                }
                // Resume multipart messages at the last part Telegram acknowledged.
                if (offset != 0 || end != text.length) db.execute(
                    "UPDATE outbox SET payload=? WHERE id=?", json(job.payload + ("sentChars" to end)), job.id,
                )
            }
            offset = end
        }
    }
}
