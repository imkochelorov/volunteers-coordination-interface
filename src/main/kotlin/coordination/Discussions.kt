package coordination

private enum class QuestionSource(val code: String) { WEB("web"), VOLUNTEER("volunteer") }

private enum class QuestionState(val code: String, val expectedAction: String) {
    OPEN("open", "Ожидается ответ"),
    ANSWERED("answered", "Ожидается подтверждение решения"),
    CLOSED("closed", "Вопрос решён"),
}

internal enum class Urgency(val code: String) { NORMAL("normal"), URGENT("urgent") }

internal data class QuestionInput(
    val body: String,
    val tagIds: List<Long> = emptyList(),
    val blocking: Boolean = false,
    val urgency: Urgency = Urgency.NORMAL,
) {
    companion object {
        fun parse(input: Data, forwarding: Boolean = false): QuestionInput {
            val body = if (forwarding) text(input["body"] ?: "", "Пояснение", 10000, false)
                else text(input["body"], "Вопрос", 10000)
            val urgency = if (input.string("urgency") == "urgent") Urgency.URGENT else Urgency.NORMAL
            return QuestionInput(body, ids(input["tagIds"]), input.booleanOrDefault("blocking", false), urgency)
        }
    }
}

private enum class QuestionBox(val code: String) {
    INCOMING("incoming"), OUTGOING("outgoing"), VOLUNTEER("volunteer"), UNADDRESSED("unaddressed"),
}

private data class Question(
    val id: Long,
    val taskId: Long,
    val title: String,
    val hallId: Long?,
    val asker: Long,
    val controller: Long,
    val source: QuestionSource,
    val forwarded: Boolean,
    val tagIds: Set<Long>,
    val blocking: Boolean,
    val urgency: Urgency,
    val state: QuestionState,
    val createdAt: String,
    val updatedAt: String,
) {
    val shared: Boolean get() = source == QuestionSource.WEB || forwarded
    val closed: Boolean get() = state == QuestionState.CLOSED

    fun includes(actor: Long): Boolean = actor == asker || actor == controller
}

class Discussions(private val domain: Domain) {
    private val db = domain.db
    private val select = "SELECT q.*,t.title AS task_title,t.hall_id FROM questions q JOIN tasks t ON t.id=q.task_id"
    private val queueOrder = compareByDescending<Question> { it.blocking }
        .thenByDescending { it.urgency }.thenByDescending { it.id }

    private fun question(id: Long): Question =
        db.one("$select WHERE q.id=?", id)?.let(::read) ?: fail(404, "Вопрос не найден.")

    private fun read(row: Data) = Question(
        id = row.requiredLong("id"),
        taskId = row.requiredLong("task_id"),
        title = row.string("task_title"),
        hallId = row.longOrNull("hall_id"),
        asker = row.requiredLong("asked_by"),
        controller = row.requiredLong("controller_id"),
        source = QuestionSource.entries.first { it.code == row.string("source") },
        forwarded = row.enabled("forwarded"),
        tagIds = row.jsonList("tag_ids").map { it.exactLongOrNull() ?: error("Invalid question tag") }.toSet(),
        blocking = row.enabled("blocking"),
        urgency = Urgency.entries.first { it.code == row.string("urgency") },
        state = QuestionState.entries.first { it.code == row.string("state") },
        createdAt = row.string("created_at"),
        updatedAt = row.string("updated_at"),
    )

    private class Audience(members: List<Member>) {
        val byId = members.associateBy(Member::id)
        private val active = members.filter { it.profile.active }.sortedBy(Member::id)

        fun recipients(question: Question): List<Long> = when {
            !question.shared -> listOf(question.controller)
            question.tagIds.isEmpty() -> emptyList()
            else -> active.filter { member -> member.profile.tagIds.any { it in question.tagIds } }.map(Member::id)
        }
    }

    private fun audience() = Audience(domain.members.roster())

    private fun addressedTo(user: Member, question: Question): Boolean =
        question.shared && user.profile.tagIds.any { it in question.tagIds }

    private fun visible(user: Member, question: Question): Boolean =
        user.isAdmin || question.includes(user.id) || addressedTo(user, question) ||
            (user.profile.hasWebAccess && question.shared && question.tagIds.isEmpty())

    private fun responses(questions: List<Question>, audience: Audience): List<Data> =
        questions.chunked(400).flatMap { batch ->
            val ids = batch.map(Question::id).toTypedArray()
            val placeholders = ids.joinToString(",") { "?" }
            val messages = db.all(
                """SELECT question_id,id,author_id AS authorId,body,created_at AS createdAt FROM question_messages
                    WHERE question_id IN ($placeholders) ORDER BY id""",
                *ids,
            ).groupBy({ it.requiredLong("question_id") }) { it - "question_id" }
            batch.map { q ->
                mapOf(
                    "id" to q.id, "taskId" to q.taskId, "askedBy" to q.asker, "controllerId" to q.controller,
                    "source" to q.source.code, "forwarded" to q.forwarded, "tagIds" to q.tagIds,
                    "blocking" to q.blocking, "urgency" to q.urgency.code, "state" to q.state.code,
                    "createdAt" to q.createdAt, "updatedAt" to q.updatedAt, "recipientIds" to audience.recipients(q),
                    "expectedAction" to q.state.expectedAction, "messages" to messages[q.id].orEmpty(),
                    "taskTitle" to q.title, "hallId" to q.hallId,
                )
            }
        }

    private fun response(question: Question, audience: Audience): Data = responses(listOf(question), audience).single()

    fun forTask(user: Member, task: Long): List<Data> = db.access {
        val questions = db.all("$select WHERE q.task_id=? ORDER BY q.id", task).map(::read).filter { visible(user, it) }
        if (questions.isEmpty()) emptyList() else responses(questions, audience())
    }

    fun list(actor: Long, box: String): List<Data> = db.access {
        val user = domain.actor(actor)
        val queue = QuestionBox.entries.firstOrNull { it.code == box } ?: fail(400, "Неизвестная очередь вопросов.")
        if (!user.profile.hasWebAccess && queue != QuestionBox.INCOMING) fail(403, "Эта очередь доступна организаторам.")
        val rows = when (queue) {
            QuestionBox.INCOMING, QuestionBox.UNADDRESSED ->
                db.all("$select WHERE q.state!='closed' AND (q.source='web' OR q.forwarded=1)")
            QuestionBox.OUTGOING -> db.all("$select WHERE q.controller_id=? OR q.asked_by=?", actor, actor)
            QuestionBox.VOLUNTEER -> db.all("$select WHERE q.source='volunteer' AND q.controller_id=?", actor)
        }
        val questions = rows.map(::read).filter { question ->
            when (queue) {
                QuestionBox.INCOMING -> addressedTo(user, question)
                QuestionBox.UNADDRESSED -> question.tagIds.isEmpty()
                QuestionBox.OUTGOING, QuestionBox.VOLUNTEER -> true
            }
        }.sortedWith(queueOrder)
        if (questions.isEmpty()) emptyList() else responses(questions, audience())
    }

    fun telegramThreads(actor: Long): List<Data> = db.access {
        val user = domain.actor(actor)
        val questions = db.all(
            """$select WHERE q.state!='closed' AND (q.asked_by=? OR q.source='web' OR q.forwarded=1)
                ORDER BY q.id DESC""", actor,
        ).asSequence().map(::read).filter { it.asker == actor || addressedTo(user, it) }.take(50).toList()
        if (questions.isEmpty()) emptyList() else responses(questions, audience())
    }

    private fun notify(question: Question, audience: Audience, users: List<Long>, event: String, summary: String) {
        val now = stamp()
        val telegramText by lazy {
            val latest = db.one("SELECT body FROM question_messages WHERE question_id=? ORDER BY id DESC LIMIT 1", question.id)
                ?.string("body").orEmpty()
            val preview = latest.substring(0, telegramTextEnd(latest, 2800))
            "$summary\nВопрос #${question.id}\n$preview\nОтветить: /reply ${question.id} текст ответа"
        }
        for (recipient in users.distinct()) {
            val count = db.execute(
                "INSERT OR IGNORE INTO notifications(user_id,question_id,event_key,text,created_at) VALUES (?,?,?,?,?)",
                recipient, question.id, event, summary, now,
            )
            if (count == 0 || audience.byId[recipient]?.isVolunteer != true) continue
            domain.enqueue(
                "message", recipient, question.taskId, mapOf("text" to telegramText, "questionId" to question.id),
                "notification:$recipient:$event",
            )
        }
    }

    private fun message(question: Long, actor: Long, body: String, now: String = stamp()): Long =
        db.insert("INSERT INTO question_messages(question_id,author_id,body,created_at) VALUES (?,?,?,?)", question, actor, body, now)

    internal fun create(actor: Long, taskId: Long, input: QuestionInput, generation: Long? = null): Data = db.transaction {
        val user = domain.actor(actor)
        val task = domain.rawTask(taskId)
        domain.read(user, taskId)
        domain.active(task, generation)
        val volunteer = user.isVolunteer && domain.assigned(taskId, actor) && actor != task.claimedBy &&
            (generation != null || !user.profile.hasWebAccess)
        if (!volunteer && !domain.canModify(user, task)) fail(403, "Вопрос создаёт автор или участник задачи.")
        val controller = if (volunteer) volunteerManager(user) else actor
        val tags = if (volunteer) emptyList() else domain.validateTags(input.tagIds)
        val blocking = !volunteer && input.blocking
        val now = stamp()
        val id = db.insert(
            """INSERT INTO questions(task_id,asked_by,controller_id,source,tag_ids,blocking,urgency,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?)""",
            taskId, actor, controller, if (volunteer) QuestionSource.VOLUNTEER.code else QuestionSource.WEB.code,
            json(tags), if (blocking) 1 else 0, input.urgency.code, now, now,
        )
        message(id, actor, input.body, now)
        val question = question(id)
        val audience = audience()
        val label = if (blocking) "Блокирующий вопрос" else "Новый вопрос"
        notify(question, audience, audience.recipients(question), "question:$id:created", "$label по задаче «${task.title}»")
        domain.record(taskId, actor, "Задан вопрос", mapOf("questionId" to id, "blocking" to blocking, "tagIds" to tags))
        domain.refresh(taskId)
        response(question, audience)
    }

    private fun volunteerManager(user: Member): Long {
        val manager = user.profile.managerId?.let(domain.members::find)
        if (manager == null || !manager.profile.active || !manager.isManager) {
            fail(409, "У вас не назначен активный менеджер. Обратитесь к администратору.")
        }
        return manager.id
    }

    internal fun reply(actor: Long, id: Long, body: String): Data = db.transaction {
        val question = question(id)
        if (!visible(domain.actor(actor), question)) fail(403, "Обсуждение недоступно.")
        requireOpen(question)
        val now = stamp()
        val messageId = message(id, actor, body, now)
        val state = if (actor == question.asker) QuestionState.OPEN else QuestionState.ANSWERED
        db.execute("UPDATE questions SET state=?,updated_at=? WHERE id=?", state.code, now, id)

        val audience = audience()
        val managerReply = question.source == QuestionSource.VOLUNTEER && actor == question.controller
        val recipients = (listOf(question.controller) + audience.recipients(question))
            .filter { it != actor && !(managerReply && it == question.asker) }
        notify(question, audience, recipients, "question:$id:message:$messageId", "Новый ответ по задаче «${question.title}»")
        if (managerReply) {
            domain.enqueue("message", question.asker, question.taskId, mapOf(
                "text" to "Ответ менеджера · Вопрос #$id\nЗадача «${question.title}»\n$body",
                "questionId" to id, "forceReply" to true,
            ))
        }
        domain.record(question.taskId, actor, "Добавлен ответ на вопрос", mapOf("questionId" to id))
        domain.refresh(question.taskId)
        response(question.copy(state = state, updatedAt = now), audience)
    }

    internal fun forward(actor: Long, id: Long, input: QuestionInput): Data = db.transaction {
        domain.organizer(actor)
        val question = question(id)
        if (question.source != QuestionSource.VOLUNTEER || question.controller != actor) {
            fail(403, "Передать вопрос может менеджер, получивший его от волонтёра.")
        }
        requireOpen(question)
        val tags = domain.validateTags(input.tagIds)
        val now = stamp()
        if (input.body.isNotEmpty()) message(id, actor, input.body, now)
        db.execute(
            "UPDATE questions SET forwarded=1,tag_ids=?,blocking=?,urgency=?,state='open',updated_at=? WHERE id=?",
            json(tags), if (input.blocking) 1 else 0, input.urgency.code, now, id,
        )
        val updated = question.copy(forwarded = true, tagIds = tags.toSet(), blocking = input.blocking,
            urgency = input.urgency, state = QuestionState.OPEN, updatedAt = now)
        val audience = audience()
        val label = if (input.blocking) "Блокирующий вопрос" else "Вопрос волонтёра"
        notify(updated, audience, audience.recipients(updated), key(), "$label по задаче «${question.title}»")
        domain.record(question.taskId, actor, "Вопрос направлен получателям", mapOf("questionId" to id, "tagIds" to tags, "blocking" to input.blocking))
        domain.refresh(question.taskId)
        response(updated, audience)
    }

    internal fun close(actor: Long, id: Long, body: String): Data = db.transaction {
        val user = domain.organizer(actor)
        val question = question(id)
        if (!user.isAdmin && question.controller != actor) {
            fail(403, "Подтвердить решение может автор вопроса или его менеджер.")
        }
        val audience = audience()
        if (question.closed) return@transaction response(question, audience)
        val now = stamp()
        if (body.isNotEmpty()) message(id, actor, body, now)
        db.execute("UPDATE questions SET state='closed',updated_at=? WHERE id=?", now, id)

        val volunteer = question.source == QuestionSource.VOLUNTEER
        val summary = "Вопрос по задаче «${question.title}» решён"
        notify(question, audience, audience.recipients(question).filter { !volunteer || it != question.asker },
            "question:$id:closed", summary)
        if (volunteer) {
            val note = if (body.isEmpty()) "$summary." else "$summary.\n$body"
            domain.enqueue("message", question.asker, question.taskId, mapOf("text" to note, "questionId" to id))
        }
        domain.record(question.taskId, actor, "Решение вопроса подтверждено", mapOf("questionId" to id))
        domain.refresh(question.taskId)
        response(question.copy(state = QuestionState.CLOSED, updatedAt = now), audience)
    }

    private fun requireOpen(question: Question) {
        if (question.closed) fail(409, "Обсуждение уже закрыто.")
    }
}
