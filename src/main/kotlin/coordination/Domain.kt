package coordination

import java.util.UUID

fun key(): String = UUID.randomUUID().toString()

class Domain(val db: Database) {
    internal val members = Members(db)
    internal val pool = VolunteerPool(this)

    fun user(id: Long): Member = members.require(id)

    fun actor(id: Long): Member = user(id).also {
        if (!it.profile.active) fail(403, "Учётная запись отключена.")
    }

    fun organizer(id: Long): Member = actor(id).also {
        if (!it.profile.hasWebAccess) fail(403, "Действие доступно организаторам.")
    }

    fun administrator(id: Long): Member = organizer(id).also {
        if (!it.isAdmin) fail(403, "Действие доступно администратору.")
    }

    fun manager(id: Long): Member = organizer(id).also {
        if (!it.isAdmin && !it.isManager) fail(403, "Действие доступно менеджеру.")
    }

    fun tags() = db.all("SELECT id,name,kind,color FROM tags ORDER BY id")
    internal fun crossHallEnabled(): Boolean = db.one("SELECT value FROM settings WHERE key='crossHall'")?.string("value") == "true"
    fun settings() = mapOf("crossHall" to crossHallEnabled())
    fun validateTags(value: Any?): List<Long> {
        val selected = ids(value)
        if (!tags().map { it.requiredLong("id") }.containsAll(selected)) fail(400, "Неизвестный общий тег.")
        return selected
    }
    fun rawTask(id: Long): Task = db.one("SELECT * FROM tasks WHERE id=?", id)
        ?.let(Task::fromRow) ?: fail(404, "Задача не найдена.")
    fun assigned(task: Long, user: Long) = db.one("SELECT 1 FROM assignments WHERE task_id=? AND volunteer_id=?", task, user) != null
    fun canWork(user: Member, task: Task, crossHall: Boolean = crossHallEnabled()): Boolean {
        val hall = task.hallId
        return user.profile.hasWebAccess && (hall == null || user.isAdmin || crossHall ||
            (user.profile.homeHallId?.let { it == hall } ?: (hall in user.profile.tagIds)))
    }
    internal fun requireWorkAccess(user: Member, task: Task) {
        if (!canWork(user, task)) fail(403, "Работа с задачами других холлов отключена администратором.")
    }
    fun active(task: Task, generation: Long? = null) {
        if (generation != null && generation != task.generation) fail(409, "Назначения изменились. Откройте /tasks.")
        if (task.status.isTerminal) fail(409, "Задача уже завершена или отменена.")
    }
    fun read(user: Member, taskId: Long) {
        if (!user.profile.hasWebAccess && !assigned(taskId, user.id)) fail(403, "Задача недоступна.")
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
    internal fun assignees(task: Long) = db.all("SELECT volunteer_id AS id FROM assignments WHERE task_id=?", task).map { it.requiredLong("id") }
    fun refresh(task: Long, previous: List<Long> = emptyList()) {
        val chats = db.all("SELECT DISTINCT user_id AS id FROM telegram_messages WHERE task_id=?", task).map { it.requiredLong("id") }
        for (recipient in (previous + assignees(task) + chats).distinct()) enqueue("task", recipient, task)
    }
    private val taskQueries = TaskQueries(this)
    internal val taskWorkflow = TaskWorkflow(this)

    internal fun taskSummaries(tasks: List<Task>): List<TaskSummary> = taskQueries.summaries(tasks)
    fun taskSummary(task: Task): TaskSummary = taskSummaries(listOf(task)).single()
    internal fun listTasks(actor: Long, filter: TaskFilter): List<Data> = taskQueries.list(actor, filter)
    fun task(actor: Long, id: Long, discussions: Discussions = Discussions(this)): Data =
        taskQueries.detail(actor, id, discussions)

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
        val users = members.roster().map { member ->
            member.response(privateFields = user.isAdmin || member.profile.managerId == actor || member.id == actor)
        }
        return mapOf("user" to user.response(), "users" to users, "tags" to tags(), "settings" to settings(), "boardTagSets" to boardTagSets(actor),
            "personalTags" to db.all("SELECT id,name,manager_id AS managerId FROM personal_tags WHERE manager_id=? ORDER BY name", actor),
            "notifications" to db.all("""SELECT n.id,n.question_id AS questionId,q.task_id AS taskId,n.text,n.created_at AS createdAt
                FROM notifications n LEFT JOIN questions q ON q.id=n.question_id WHERE n.user_id=? ORDER BY n.id DESC LIMIT 100""", actor))
    }

    fun canModify(user: Member, task: Task) = user.isAdmin ||
        user.id in listOf(task.authorId, task.claimedBy, task.assignedBy)

}
