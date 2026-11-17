package coordination

import java.util.UUID

fun Data.hasRole(role: String) = role in list("roles")
fun Data.web() = list("roles").any { it in listOf("admin", "organizer", "manager") }
fun key(): String = UUID.randomUUID().toString()

class Domain(val db: Database) {
    fun user(id: Long): Data {
        val row = db.one("SELECT * FROM users WHERE id=?", id) ?: fail(404, "Пользователь не найден.")
        return mapOf("id" to id, "name" to row["name"], "login" to row["login"], "roles" to row.jsonList("roles"),
            "tagIds" to row.jsonList("tag_ids"), "homeHallId" to row["home_hall_id"], "managerId" to row["manager_id"],
            "available" to row.enabled("available"), "telegramId" to row["telegram_id"], "chatId" to row["chat_id"],
            "active" to row.enabled("active"), "createdAt" to row["created_at"])
    }

    fun actor(id: Long): Data = user(id).also {
        if (!it.enabled("active")) fail(403, "Учётная запись отключена.")
    }
    fun organizer(id: Long): Data = actor(id).also {
        if (!it.web()) fail(403, "Действие доступно организаторам.")
    }
    fun administrator(id: Long): Data = organizer(id).also {
        if (!it.hasRole("admin")) fail(403, "Действие доступно администратору.")
    }
    fun manager(id: Long): Data = organizer(id).also {
        if (!it.hasRole("admin") && !it.hasRole("manager")) fail(403, "Действие доступно менеджеру.")
    }

    fun tags() = db.all("SELECT id,name,kind,color FROM tags ORDER BY id")
    fun settings() = mapOf("crossHall" to (db.one("SELECT value FROM settings WHERE key='crossHall'")?.string("value") == "true"))
    fun validateTags(value: Any?): List<Long> {
        val selected = ids(value)
        if (!tags().map { it.requiredLong("id") }.containsAll(selected)) fail(400, "Неизвестный общий тег.")
        return selected
    }
    fun rawTask(id: Long): Task = db.one("SELECT * FROM tasks WHERE id=?", id)
        ?.let(Task::fromRow) ?: fail(404, "Задача не найдена.")
    fun assigned(task: Long, user: Long) = db.one("SELECT 1 FROM assignments WHERE task_id=? AND volunteer_id=?", task, user) != null
    fun canWork(user: Data, task: Task): Boolean {
        val hall = task.hallId
        return user.web() && (hall == null || user.hasRole("admin") || settings().enabled("crossHall") ||
            (user.longOrNull("homeHallId")?.let { it == hall } ?: (hall in user.list("tagIds"))))
    }
    private fun work(user: Data, task: Task) {
        if (!canWork(user, task)) fail(403, "Работа с задачами других холлов отключена администратором.")
    }
    fun active(task: Task, generation: Long? = null) {
        if (generation != null && generation != task.generation) fail(409, "Назначения изменились. Откройте /tasks.")
        if (task.status.isTerminal) fail(409, "Задача уже завершена или отменена.")
    }
    fun read(user: Data, taskId: Long) {
        if (!user.web() && !assigned(taskId, user.requiredLong("id"))) fail(403, "Задача недоступна.")
    }
    fun record(task: Long, actor: Long, event: String, data: Data = emptyMap()) {
        val now = stamp()
        db.execute("INSERT INTO audit(task_id,actor_id,event,data,created_at) VALUES (?,?,?,?,?)", task, actor, event, json(data), now)
        db.execute("UPDATE tasks SET updated_at=? WHERE id=?", now, task)
    }
    fun enqueue(kind: String, recipient: Long?, task: Long?, payload: Data = emptyMap(), event: String = key()) {
        db.execute("INSERT OR IGNORE INTO outbox(event_key,kind,user_id,task_id,payload,created_at) VALUES (?,?,?,?,?,?)",
            event, kind, recipient, task, json(payload), stamp())
    }
    private fun assignees(task: Long) = db.all("SELECT volunteer_id AS id FROM assignments WHERE task_id=?", task).map { it.requiredLong("id") }
    fun refresh(task: Long, previous: List<Long> = emptyList()) {
        val chats = db.all("SELECT DISTINCT user_id AS id FROM telegram_messages WHERE task_id=?", task).map { it.requiredLong("id") }
        for (recipient in (previous + assignees(task) + chats).distinct()) enqueue("task", recipient, task)
    }
    fun taskSummary(task: Task): TaskSummary {
        val assignments = db.all(
            "SELECT volunteer_id,accepted_at FROM assignments WHERE task_id=? ORDER BY volunteer_id", task.id
        ).map { Assignment(it.requiredLong("volunteer_id"), it["accepted_at"] as? String) }
        val questions = db.all("SELECT blocking,state FROM questions WHERE task_id=? AND state!='closed'", task.id)
        return TaskSummary(
            task = task,
            assignments = assignments,
            blocked = questions.any { it.enabled("blocking") },
            openQuestions = questions.size,
            awaitingReply = questions.any { it.string("state") == "open" },
            awaitingConfirmation = questions.any { it.string("state") == "answered" },
        )
    }

    private fun boardTagSets(actor: Long): Data {
        val saved = db.one("SELECT value FROM settings WHERE key=?", "boardTagSets:$actor") ?: return emptyMap()
        return decode(saved.string("value")).objectOrEmpty()
    }

    fun saveBoardTagSets(actor: Long, input: Data): Data = db.transaction {
        organizer(actor)
        val sets = mapOf("assign" to validateTags(input["assign"]), "watch" to validateTags(input["watch"]))
        db.execute("INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            "boardTagSets:$actor", json(sets))
        sets
    }

    fun bootstrap(actor: Long): Data {
        val user = organizer(actor)
        val users = db.all("SELECT id FROM users ORDER BY name").map { user(it.requiredLong("id")) }.map {
            if (user.hasRole("admin") || it.longOrNull("managerId") == actor || it.longOrNull("id") == actor) it
            else it - listOf("telegramId", "chatId", "login")
        }
        return mapOf("user" to user, "users" to users, "tags" to tags(), "settings" to settings(), "boardTagSets" to boardTagSets(actor),
            "personalTags" to db.all("SELECT id,name,manager_id AS managerId FROM personal_tags WHERE manager_id=? ORDER BY name", actor),
            "notifications" to db.all("""SELECT n.id,n.question_id AS questionId,q.task_id AS taskId,n.text,n.created_at AS createdAt
                FROM notifications n LEFT JOIN questions q ON q.id=n.question_id WHERE n.user_id=? ORDER BY n.id DESC LIMIT 100""", actor))
    }

    fun listTasks(actor: Long, filter: Data): List<Data> {
        val user = actor(actor)
        val scope = filter.string("scope")
        val hallId = filter.longOrNull("hallId")
        val explicitHall = scope == "hall" || filter.string("hallId").isNotEmpty()
        val tagId = filter.longOrNull("tagId")
        val query = filter.string("q").lowercase()
        val status = filter.string("status")
        val blockedOnly = filter.enabled("blocked") || filter.string("blocked") == "true"
        val questionsOnly = filter.enabled("openQuestions") || filter.string("openQuestions") == "true"
        return db.all("SELECT * FROM tasks ORDER BY id DESC").asSequence()
            .map(Task::fromRow)
            .filter { task ->
                (user.web() || assigned(task.id, actor)) &&
                    (!explicitHall || (hallId != null && hallId == task.hallId)) &&
                    (scope != "home" || user.longOrNull("homeHallId")?.let { it == task.hallId } != false) &&
                    (status.isEmpty() || status == task.status.code) &&
                    (filter.string("tagId").isEmpty() || tagId in task.tagIds) &&
                    (query.isEmpty() || "${task.title} ${task.description} ${task.id}".lowercase().contains(query))
            }
            .map(::taskSummary)
            .filter { summary ->
                val task = summary.task
                val taken = task.claimedBy != null || summary.assignments.isNotEmpty()
                val matchesAssignment = when (filter.string("assignment")) {
                    "free" -> !taken && !task.status.isTerminal
                    "assigned" -> taken
                    "waiting" -> summary.awaitingAcceptance
                    else -> true
                }
                val assignedToActor = task.claimedBy == actor || summary.assignments.any { it.volunteerId == actor }
                val matchesScope = when (scope) {
                    "created" -> task.authorId == actor
                    "assigned" -> assignedToActor
                    "mine" -> assignedToActor || task.assignedBy == actor || task.authorId == actor
                    else -> true
                }
                matchesScope && matchesAssignment &&
                    (!blockedOnly || summary.blocked) && (!questionsOnly || summary.openQuestions > 0)
            }
            .sortedWith(compareByDescending<TaskSummary> { it.blocked }
                .thenByDescending { it.task.priority }.thenByDescending { it.task.id })
            .map(TaskSummary::toResponse)
            .toList()
    }

    fun task(actor: Long, id: Long, discussions: Discussions = Discussions(this)): Data {
        val user = actor(actor)
        val task = rawTask(id)
        read(user, id)
        val allowed = canWork(user, task)
        return taskSummary(task).toResponse() + mapOf("questions" to discussions.forTask(user, id),
            "history" to db.all("SELECT id,actor_id AS actorId,event,data,created_at AS createdAt FROM audit WHERE task_id=? ORDER BY id DESC", id)
                .map { it + ("data" to decode(it.string("data"))) },
            "siblings" to db.all("SELECT * FROM tasks WHERE group_id=? ORDER BY hall_id,id", task.groupId)
                .map(Task::fromRow).filter { user.web() || assigned(it.id, actor) }.map { taskSummary(it).toResponse() },
            "canWork" to allowed, "canReset" to (allowed && !task.status.isTerminal && canModify(user, task)),
            "canEditOptions" to (allowed && !task.status.isTerminal && canModify(user, task)))
    }

    fun createTask(actor: Long, input: Data): List<Data> = db.transaction {
        organizer(actor)
        val priority = input["priority"]?.let { TaskPriority.fromInput(it) } ?: TaskPriority.NORMAL
        val strong = strongRequirement(input, false)
        val target = volunteerTarget(input["volunteerTarget"])
        val suppliedTitle = input["title"]
        val description = text(input["description"] ?: "", "Описание", 15000, required = suppliedTitle == null)
        val title = if (suppliedTitle != null) {
            text(suppliedTitle, "Название", 250)
        } else {
            val firstLine = description.lineSequence().first().trim()
            val length = firstLine.codePointCount(0, firstLine.length).coerceAtMost(120)
            firstLine.substring(0, firstLine.offsetByCodePoints(0, length))
        }
        val tags = tags().associateBy { it.requiredLong("id") }
        val selected = validateTags(input["tagIds"])
        val halls = (ids(input["hallIds"]) + selected.filter { tags[it]?.string("kind") == "hall" } +
            if (input.enabled("allHalls")) tags.values.filter { it.string("kind") == "hall" }.map { it.requiredLong("id") } else emptyList()).distinct()
        if (halls.any { tags[it]?.string("kind") != "hall" }) fail(400, "Выберите существующие холлы.")
        val directions = selected.filterNot { tags[it]?.string("kind") == "hall" }
        val now = stamp()
        val group = db.insert("INSERT INTO task_groups(title,description,author_id,created_at) VALUES (?,?,?,?)", title, description, actor, now)
        val destinations: List<Long?> = if (halls.isEmpty()) listOf(null) else halls
        destinations.map { hall ->
            val task = db.insert("""INSERT INTO tasks(group_id,title,description,author_id,hall_id,tag_ids,status,created_at,updated_at,priority,needs_strong_volunteers,volunteer_target)
                VALUES (?,?,?,?,?,?,'queued',?,?,?,?,?)""", group, title, description, actor, hall,
                json(directions + listOfNotNull(hall)), now, now, priority.code, if (strong) 1 else 0, target)
            record(task, actor, "Задача опубликована", mapOf("groupId" to group, "hallId" to hall))
            taskSummary(rawTask(task)).toResponse()
        }
    }

    private fun strongRequirement(input: Data, default: Boolean): Boolean {
        if ("needsStrongVolunteers" !in input) return default
        return input["needsStrongVolunteers"] as? Boolean ?: fail(400, "Укажите, нужны ли сильные волонтёры.")
    }

    private fun volunteerTarget(value: Any?): String {
        if (value == null || value is String && value.isBlank()) return ""
        val raw = (value as? String)?.trim() ?: value.exactLongOrNull()?.toString().orEmpty()
        val match = Regex("([0-9]{1,4})(?:\\s*[-–—]\\s*([0-9]{1,4}))?").matchEntire(raw)
            ?: fail(400, "Укажите число волонтёров или диапазон, например 2–3.")
        val min = match.groupValues[1].toInt()
        val max = match.groups[2]?.value?.toInt() ?: min
        if (min !in 1..2000 || max !in min..2000) fail(400, "Укажите от 1 до 2000 волонтёров по возрастанию.")
        return if (min == max) min.toString() else "$min–$max"
    }

    fun updateTaskOptions(actor: Long, id: Long, input: Data): Data = db.transaction {
        val user = organizer(actor)
        val current = rawTask(id)
        work(user, current)
        active(current)
        if (!canModify(user, current)) fail(403, "Изменить задачу может автор, участник или администратор.")
        val priority = input["priority"]?.let { TaskPriority.fromInput(it) } ?: current.priority
        val strong = strongRequirement(input, current.needsStrongVolunteers)
        val target = if ("volunteerTarget" in input) volunteerTarget(input["volunteerTarget"]) else current.volunteerTarget
        if (priority != current.priority || strong != current.needsStrongVolunteers || target != current.volunteerTarget) {
            db.execute("UPDATE tasks SET priority=?,needs_strong_volunteers=?,volunteer_target=? WHERE id=?",
                priority.code, if (strong) 1 else 0, target, id)
            record(id, actor, "Изменены приоритет и требования",
                mapOf("priority" to priority.code, "needsStrongVolunteers" to strong, "volunteerTarget" to target))
            refresh(id)
        }
        task(actor, id)
    }

    private fun unassigned(task: Task) {
        if (task.status != TaskStatus.QUEUED || task.claimedBy != null || task.assignedBy != null ||
            assignees(task.id).isNotEmpty()) fail(409, "Задача уже взята или назначена. Для смены исполнителей верните её в очередь.")
    }
    fun claim(actor: Long, id: Long): Data = db.transaction {
        val task = rawTask(id)
        work(organizer(actor), task)
        active(task)
        unassigned(task)
        db.execute("UPDATE tasks SET claimed_by=?,status='in_progress' WHERE id=?", actor, id)
        record(id, actor, "Задача взята в работу")
        refresh(id)
        task(actor, id)
    }
    private fun volunteer(user: Data): Data {
        val tasks = db.all("""SELECT t.* FROM tasks t JOIN assignments a ON a.task_id=t.id
            WHERE a.volunteer_id=? AND t.status IN ('queued','in_progress') ORDER BY t.id DESC""", user["id"]).map { taskSummary(Task.fromRow(it)).toResponse() }
        val tags = db.all("SELECT personal_tag_id AS id FROM volunteer_personal_tags WHERE volunteer_id=?", user["id"]).map { it.requiredLong("id") }
        return user + mapOf("tasks" to tasks, "free" to (user.enabled("available") && tasks.isEmpty()), "personalTagIds" to tags)
    }
    fun volunteers(actor: Long): List<Data> {
        val manager = manager(actor)
        return db.all("SELECT id FROM users WHERE active=1 ORDER BY name").map { user(it.requiredLong("id")) }
            .filter { it.hasRole("volunteer") && (it.longOrNull("managerId") == actor || manager.hasRole("admin")) }.map(::volunteer)
    }
    fun preview(actor: Long, input: Data): List<Data> {
        val pool = volunteers(actor).filter { it.longOrNull("managerId") == actor }
        val mode = input.string("mode").ifEmpty { "manual" }
        if (mode !in listOf("manual", "free", "all")) fail(400, "Неизвестный способ выбора волонтёров.")
        val selected = ids(input["volunteerIds"])
        val personal = ids(input["personalTagIds"])
        if (selected.any { id -> pool.none { it.longOrNull("id") == id } }) fail(403, "Можно назначать только волонтёров своего пула.")
        val owned = db.all("SELECT id FROM personal_tags WHERE manager_id=?", actor).map { it.requiredLong("id") }
        if (!owned.containsAll(personal)) fail(403, "Личные теги другого менеджера недоступны.")
        return pool.filter { it.longOrNull("id") in selected || it.list("personalTagIds").any { tag -> tag in personal } ||
            mode == "all" || (mode == "free" && it.enabled("free")) }
    }
    fun assign(actor: Long, id: Long, input: Data): Data = db.transaction {
        val task = rawTask(id)
        work(manager(actor), task)
        active(task)
        unassigned(task)
        val volunteers = preview(actor, input).map { it.requiredLong("id") }
        if (volunteers.isEmpty()) fail(400, "Не выбраны волонтёры.")
        db.execute("UPDATE tasks SET assigned_by=? WHERE id=?", actor, id)
        for (volunteer in volunteers) db.execute("INSERT INTO assignments(task_id,volunteer_id) VALUES (?,?)", id, volunteer)
        record(id, actor, "Волонтёры назначены", mapOf("volunteerIds" to volunteers))
        refresh(id)
        task(actor, id)
    }
    fun accept(actor: Long, id: Long, generation: Long): Data = db.transaction {
        actor(actor)
        active(rawTask(id), generation)
        val row = db.one("SELECT accepted_at FROM assignments WHERE task_id=? AND volunteer_id=?", id, actor)
            ?: fail(403, "Вы не назначены на эту задачу.")
        if (row["accepted_at"] == null) {
            db.execute("UPDATE assignments SET accepted_at=? WHERE task_id=? AND volunteer_id=?", stamp(), id, actor)
            db.execute("UPDATE tasks SET status='in_progress' WHERE id=?", id)
            record(id, actor, "Волонтёр начал выполнение")
            refresh(id)
        }
        task(actor, id)
    }
    fun complete(actor: Long, id: Long, generation: Long? = null): Data = db.transaction {
        actor(actor)
        val task = rawTask(id)
        active(task, generation)
        if (actor != task.claimedBy && !assigned(id, actor)) fail(403, "Завершить задачу может её исполнитель.")
        if (task.status != TaskStatus.IN_PROGRESS) fail(409, "Сначала возьмите задачу в работу.")
        db.execute("UPDATE tasks SET status='done' WHERE id=?", id)
        record(id, actor, "Задача выполнена")
        refresh(id)
        task(actor, id)
    }
    fun canModify(user: Data, task: Task) = user.hasRole("admin") ||
        user.longOrNull("id") in listOf(task.authorId, task.claimedBy, task.assignedBy)

    fun modify(actor: Long, id: Long, reason: Any?, reset: Boolean): Data = db.transaction {
        val user = organizer(actor)
        val task = rawTask(id)
        work(user, task)
        active(task)
        if (!canModify(user, task)) fail(403, "Изменить задачу может автор, участник или администратор.")
        val explanation = text(reason, "Причина", 2000)
        val previous = assignees(id)
        if (reset) db.execute("DELETE FROM assignments WHERE task_id=?", id)
        db.execute("UPDATE tasks SET status=?,claimed_by=?,assigned_by=?,generation=generation+1 WHERE id=?",
            if (reset) "queued" else "cancelled", task.claimedBy.takeUnless { reset }, task.assignedBy.takeUnless { reset }, id)
        record(id, actor, if (reset) "Задача возвращена в очередь" else "Задача отменена",
            mapOf("reason" to explanation, "previousVolunteerIds" to previous))
        refresh(id, previous)
        task(actor, id)
    }
    fun availability(actor: Long, available: Boolean) {
        if (!actor(actor).hasRole("volunteer")) fail(403, "Доступность устанавливает волонтёр.")
        db.execute("UPDATE users SET available=? WHERE id=?", if (available) 1 else 0, actor)
    }
    fun personalTags(actor: Long, target: Long, input: Data): Data = db.transaction {
        manager(actor)
        if (user(target).longOrNull("managerId") != actor) fail(403, "Личные теги доступны только внутри своего пула.")
        val values = input["names"]
        if (values !is List<*> || values.size > 100) fail(400, "Укажите список личных тегов.")
        val names = values.map { text(it, "Название личного тега", 80) }.distinct()
        db.execute("""DELETE FROM volunteer_personal_tags WHERE volunteer_id=? AND personal_tag_id IN
            (SELECT id FROM personal_tags WHERE manager_id=?)""", target, actor)
        for (name in names) {
            db.execute("INSERT OR IGNORE INTO personal_tags(manager_id,name) VALUES (?,?)", actor, name)
            db.execute("""INSERT INTO volunteer_personal_tags(volunteer_id,personal_tag_id)
                SELECT ?,id FROM personal_tags WHERE manager_id=? AND name=?""", target, actor, name)
        }
        volunteer(user(target))
    }
}
