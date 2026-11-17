package coordination

class Discussions(private val domain: Domain) {
    private val db = domain.db
    private fun question(id: Long): Data = db.one("SELECT * FROM questions WHERE id=?", id) ?: fail(404, "Вопрос не найден.")
    private fun shared(q: Data) = q.string("source") != "volunteer" || q.enabled("forwarded")

    private fun recipients(q: Data): List<Long> {
        if (!shared(q)) return listOf(q.requiredLong("controller_id"))
        val tags = q.jsonList("tag_ids").toSet()
        if (tags.isEmpty()) return emptyList()
        return db.all("SELECT id,tag_ids FROM users WHERE active=1").filter { row ->
            row.jsonList("tag_ids").any { it in tags }
        }.map { it.requiredLong("id") }
    }
    private fun visible(u: Data, q: Data): Boolean = u.hasRole("admin") ||
        u.longOrNull("id") in listOf(q.longOrNull("asked_by"), q.longOrNull("controller_id")) || u.longOrNull("id") in recipients(q) ||
        (u.web() && shared(q) && q.jsonList("tag_ids").isEmpty())

    private fun view(q: Data): Data {
        val task = domain.rawTask(q.requiredLong("task_id"))
        return mapOf("id" to q["id"], "taskId" to q["task_id"], "askedBy" to q["asked_by"],
            "controllerId" to q["controller_id"], "source" to q["source"], "forwarded" to q.enabled("forwarded"),
            "tagIds" to q.jsonList("tag_ids"), "blocking" to q.enabled("blocking"), "urgency" to q["urgency"],
            "state" to q["state"], "createdAt" to q["created_at"], "updatedAt" to q["updated_at"],
            "recipientIds" to recipients(q), "expectedAction" to when (q.string("state")) {
                "closed" -> "Вопрос решён"
                "answered" -> "Ожидается подтверждение решения"
                else -> "Ожидается ответ"
            }, "messages" to db.all(
                "SELECT id,author_id AS authorId,body,created_at AS createdAt FROM question_messages WHERE question_id=? ORDER BY id",
                q["id"]), "taskTitle" to task.title, "hallId" to task.hallId)
    }

    fun forTask(user: Data, task: Long) = db.all("SELECT * FROM questions WHERE task_id=? ORDER BY id", task)
        .filter { visible(user, it) }.map(::view)

    fun list(actor: Long, box: String): List<Data> {
        val user = domain.actor(actor)
        if (!user.web() && box != "incoming") fail(403, "Эта очередь доступна организаторам.")
        if (box !in listOf("incoming", "outgoing", "volunteer", "unaddressed")) fail(400, "Неизвестная очередь вопросов.")
        return db.all("SELECT * FROM questions ORDER BY id DESC").filter { visible(user, it) }.filter { q ->
            val open = q.string("state") != "closed"
            when (box) {
                "incoming" -> open && shared(q) && actor in recipients(q)
                "outgoing" -> actor in listOf(q.longOrNull("controller_id"), q.longOrNull("asked_by"))
                "volunteer" -> q.string("source") == "volunteer" && actor == q.longOrNull("controller_id")
                else -> open && shared(q) && q.jsonList("tag_ids").isEmpty()
            }
        }.map(::view).sortedWith(compareByDescending<Data> { it.enabled("blocking") }
            .thenByDescending { it.string("urgency") == "urgent" }.thenByDescending { it.requiredLong("id") })
    }

    fun telegramThreads(actor: Long): List<Data> {
        val incoming = list(actor, "incoming")
        val own = db.all("SELECT * FROM questions WHERE asked_by=? AND state!='closed' ORDER BY id DESC LIMIT 50", actor)
            .map(::view)
        return (incoming + own).distinctBy { it.requiredLong("id") }
            .sortedByDescending { it.requiredLong("id") }.take(50)
    }

    private fun notify(users: List<Long>, id: Long, event: String, message: String) {
        for (recipient in users.distinct()) {
            val count = db.execute("INSERT OR IGNORE INTO notifications(user_id,question_id,event_key,text,created_at) VALUES (?,?,?,?,?)",
                recipient, id, event, message, stamp())
            if (count == 0 || !domain.user(recipient).hasRole("volunteer")) continue
            val latest = db.one("SELECT body FROM question_messages WHERE question_id=? ORDER BY id DESC LIMIT 1", id)
                ?.string("body").orEmpty()
            val body = "$message\nВопрос #$id\n${latest.take(2800)}\nОтветить: /reply $id текст ответа"
            domain.enqueue("message", recipient, question(id).requiredLong("task_id"), mapOf("text" to body, "questionId" to id),
                "notification:$recipient:$event")
        }
    }
    private fun message(id: Long, actor: Long, body: String, now: String = stamp()) =
        db.insert("INSERT INTO question_messages(question_id,author_id,body,created_at) VALUES (?,?,?,?)", id, actor, body, now)

    private fun urgency(input: Data) = if (input.string("urgency") == "urgent") "urgent" else "normal"
    private fun title(q: Data) = domain.rawTask(q.requiredLong("task_id")).title

    fun create(actor: Long, taskId: Long, input: Data, generation: Long? = null): Data = db.transaction {
        val user = domain.actor(actor)
        val task = domain.rawTask(taskId)
        domain.read(user, taskId)
        domain.active(task, generation)
        val volunteer = domain.assigned(taskId, actor) && actor != task.claimedBy && (generation != null || !user.web())
        if (!volunteer && !domain.canModify(user, task)) fail(403, "Вопрос создаёт автор или участник задачи.")
        val controller = if (volunteer) user.longOrNull("managerId")?.takeIf { domain.user(it).enabled("active") }
            ?: fail(409, "У вас не назначен активный менеджер. Обратитесь к администратору.") else actor
        val body = text(input["body"], "Вопрос", 10000)
        val tags = if (volunteer) emptyList() else domain.validateTags(input["tagIds"])
        val blocking = !volunteer && input.enabled("blocking")
        val now = stamp()
        val id = db.insert("""INSERT INTO questions(task_id,asked_by,controller_id,source,tag_ids,blocking,urgency,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?)""", taskId, actor, controller, if (volunteer) "volunteer" else "web",
            json(tags), if (blocking) 1 else 0, urgency(input), now, now)
        message(id, actor, body, now)
        val q = question(id)
        val label = if (blocking) "Блокирующий вопрос" else "Новый вопрос"
        notify(recipients(q), id, "question:$id:created", "$label по задаче «${task.title}»")
        domain.record(taskId, actor, "Задан вопрос", mapOf("questionId" to id, "blocking" to blocking, "tagIds" to tags))
        domain.refresh(taskId)
        view(q)
    }

    fun reply(actor: Long, id: Long, input: Data): Data = db.transaction {
        val q = question(id)
        if (!visible(domain.actor(actor), q)) fail(403, "Обсуждение недоступно.")
        if (q.string("state") == "closed") fail(409, "Обсуждение уже закрыто.")
        val body = text(input["body"], "Ответ", 10000)
        val now = stamp()
        val message = message(id, actor, body, now)
        val asker = q.requiredLong("asked_by")
        val controller = q.requiredLong("controller_id")
        val task = q.requiredLong("task_id")
        val title = title(q)
        val managerReply = q.string("source") == "volunteer" && actor == controller
        db.execute("UPDATE questions SET state=?,updated_at=? WHERE id=?", if (actor == asker) "open" else "answered", now, id)
        notify((listOf(controller) + recipients(q)).filter { it != actor && !(managerReply && it == asker) },
            id, "question:$id:message:$message", "Новый ответ по задаче «$title»")
        if (managerReply) domain.enqueue("message", asker, task, mapOf(
            "text" to "Ответ менеджера · Вопрос #$id\nЗадача «$title»\n$body",
            "questionId" to id, "forceReply" to true,
        ))
        domain.record(task, actor, "Добавлен ответ на вопрос", mapOf("questionId" to id))
        domain.refresh(task)
        view(question(id))
    }

    fun forward(actor: Long, id: Long, input: Data): Data = db.transaction {
        domain.organizer(actor)
        val q = question(id)
        if (q.string("source") != "volunteer" || q.longOrNull("controller_id") != actor) {
            fail(403, "Передать вопрос может менеджер, получивший его от волонтёра.")
        }
        if (q.string("state") == "closed") fail(409, "Обсуждение уже закрыто.")
        val tags = domain.validateTags(input["tagIds"])
        val blocking = input.enabled("blocking")
        val body = text(input["body"] ?: "", "Пояснение", 10000, false)
        if (body.isNotEmpty()) message(id, actor, body)
        db.execute("UPDATE questions SET forwarded=1,tag_ids=?,blocking=?,urgency=?,state='open',updated_at=? WHERE id=?",
            json(tags), if (blocking) 1 else 0, urgency(input), stamp(), id)
        val updated = question(id)
        val task = q.requiredLong("task_id")
        val label = if (blocking) "Блокирующий вопрос" else "Вопрос волонтёра"
        notify(recipients(updated), id, key(), "$label по задаче «${title(q)}»")
        domain.record(task, actor, "Вопрос направлен получателям", mapOf("questionId" to id, "tagIds" to tags, "blocking" to blocking))
        domain.refresh(task)
        view(updated)
    }

    fun close(actor: Long, id: Long, input: Data): Data = db.transaction {
        val user = domain.organizer(actor)
        val q = question(id)
        if (!user.hasRole("admin") && q.longOrNull("controller_id") != actor) fail(403, "Подтвердить решение может автор вопроса или его менеджер.")
        if (q.string("state") == "closed") return@transaction view(q)
        val task = q.requiredLong("task_id")
        val asker = q.requiredLong("asked_by")
        val volunteer = q.string("source") == "volunteer"
        val body = text(input["body"] ?: "", "Итоговое пояснение", 10000, false)
        if (body.isNotEmpty()) message(id, actor, body)
        db.execute("UPDATE questions SET state='closed',updated_at=? WHERE id=?", stamp(), id)
        val message = "Вопрос по задаче «${title(q)}» решён"
        notify(recipients(q).filter { !volunteer || it != asker }, id, "question:$id:closed", message)
        if (volunteer) domain.enqueue("message", asker, task,
            mapOf("text" to "$message." + if (body.isEmpty()) "" else "\n$body", "questionId" to id))
        domain.record(task, actor, "Решение вопроса подтверждено", mapOf("questionId" to id))
        domain.refresh(task)
        view(question(id))
    }
}
