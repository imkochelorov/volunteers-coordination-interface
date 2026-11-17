package coordination

/** Commits status, assignments, history, and outgoing updates together. */
internal class TaskWorkflow(private val domain: Domain) {
    private val db get() = domain.db
    private val taskQueries = TaskQueries(domain)

    fun createTask(actor: Long, draft: TaskDraft): List<Data> = db.transaction {
        val user = domain.organizer(actor)
        val priority = draft.options.priority ?: TaskPriority.NORMAL
        val strong = draft.options.needsStrongVolunteers ?: false
        val target = draft.options.volunteerTarget.orEmpty()
        val (title, description) = draft
        val tags = domain.tags().associateBy { it.requiredLong("id") }
        val selected = draft.tagIds
        if (!tags.keys.containsAll(selected)) fail(400, "Неизвестный общий тег.")
        val taggedHalls = selected.filter { tags[it]?.string("kind") == "hall" }
        val allHalls = if (draft.allHalls) {
            tags.values.filter { it.string("kind") == "hall" }.map { it.requiredLong("id") }
        } else emptyList()
        val halls = (draft.hallIds + taggedHalls + allHalls).distinct()
        if (halls.any { tags[it]?.string("kind") != "hall" }) fail(400, "Выберите существующие холлы.")
        val directions = selected.filterNot { tags[it]?.string("kind") == "hall" }
        val now = stamp()
        val group = db.insert("INSERT INTO task_groups(title,description,author_id,created_at) VALUES (?,?,?,?)", title, description, actor, now)
        val destinations: List<Long?> = if (halls.isEmpty()) listOf(null) else halls
        val tasks = destinations.map { hall ->
            val task = db.insert("""INSERT INTO tasks(group_id,title,description,author_id,hall_id,tag_ids,status,created_at,updated_at,priority,needs_strong_volunteers,volunteer_target)
                VALUES (?,?,?,?,?,?,'queued',?,?,?,?,?)""", group, title, description, actor, hall,
                json(directions + listOfNotNull(hall)), now, now, priority.code, if (strong) 1 else 0, target)
            domain.record(task, actor, "Задача опубликована", mapOf("groupId" to group, "hallId" to hall))
            domain.rawTask(task)
        }
        val crossHall = domain.settings().enabled("crossHall")
        taskQueries.summaries(tasks).map { taskQueries.response(it, user, crossHall) }
    }

    fun updateTaskOptions(actor: Long, id: Long, options: TaskOptions): Data = db.transaction {
        val user = domain.organizer(actor)
        val current = domain.rawTask(id)
        domain.requireWorkAccess(user, current)
        domain.active(current)
        if (!domain.canModify(user, current)) fail(403, "Изменить задачу может автор, участник или администратор.")
        val priority = options.priority ?: current.priority
        val strong = options.needsStrongVolunteers ?: current.needsStrongVolunteers
        val target = options.volunteerTarget ?: current.volunteerTarget
        if (priority != current.priority || strong != current.needsStrongVolunteers || target != current.volunteerTarget) {
            db.execute("UPDATE tasks SET priority=?,needs_strong_volunteers=?,volunteer_target=? WHERE id=?",
                priority.code, if (strong) 1 else 0, target, id)
            domain.record(id, actor, "Изменены приоритет и требования",
                mapOf("priority" to priority.code, "needsStrongVolunteers" to strong, "volunteerTarget" to target))
            domain.refresh(id)
        }
        domain.task(actor, id)
    }

    private fun requireUnassigned(task: Task) {
        if (!task.isUnassigned(domain.assignees(task.id).isNotEmpty())) {
            fail(409, "Задача уже взята или назначена. Для смены исполнителей верните её в очередь.")
        }
    }
    fun claim(actor: Long, id: Long): Data = db.transaction {
        val task = domain.rawTask(id)
        domain.requireWorkAccess(domain.organizer(actor), task)
        domain.active(task)
        requireUnassigned(task)
        db.execute("UPDATE tasks SET claimed_by=?,status='in_progress' WHERE id=?", actor, id)
        domain.record(id, actor, "Задача взята в работу")
        domain.refresh(id)
        domain.task(actor, id)
    }
    fun assign(actor: Long, id: Long, selection: AssignmentSelection): Data = db.transaction {
        val task = domain.rawTask(id)
        domain.requireWorkAccess(domain.manager(actor), task)
        domain.active(task)
        requireUnassigned(task)
        val volunteers = domain.pool.recipients(actor, selection)
        if (volunteers.isEmpty()) fail(400, "Не выбраны волонтёры.")
        db.execute("UPDATE tasks SET assigned_by=? WHERE id=?", actor, id)
        for (volunteer in volunteers) db.execute("INSERT INTO assignments(task_id,volunteer_id) VALUES (?,?)", id, volunteer)
        domain.record(id, actor, "Волонтёры назначены", mapOf("volunteerIds" to volunteers))
        domain.refresh(id)
        domain.task(actor, id)
    }
    fun accept(actor: Long, id: Long, generation: Long): Data = db.transaction {
        val volunteer = domain.actor(actor)
        if (!volunteer.isVolunteer) fail(403, "Назначение доступно волонтёру.")
        domain.active(domain.rawTask(id), generation)
        val row = db.one("SELECT accepted_at FROM assignments WHERE task_id=? AND volunteer_id=?", id, actor)
            ?: fail(403, "Вы не назначены на эту задачу.")
        if (row["accepted_at"] == null) {
            db.execute("UPDATE assignments SET accepted_at=? WHERE task_id=? AND volunteer_id=?", stamp(), id, actor)
            db.execute("UPDATE tasks SET status='in_progress' WHERE id=?", id)
            domain.record(id, actor, "Волонтёр начал выполнение")
            domain.refresh(id)
        }
        domain.task(actor, id)
    }
    fun complete(actor: Long, id: Long, generation: Long? = null): Data = db.transaction {
        val user = domain.actor(actor)
        val task = domain.rawTask(id)
        domain.active(task, generation)
        if (actor != task.claimedBy && (!user.isVolunteer || !domain.assigned(id, actor))) {
            fail(403, "Завершить задачу может её исполнитель.")
        }
        if (generation == null && user.profile.hasWebAccess) domain.requireWorkAccess(user, task)
        if (task.status != TaskStatus.IN_PROGRESS) fail(409, "Сначала возьмите задачу в работу.")
        db.execute("UPDATE tasks SET status='done' WHERE id=?", id)
        db.execute("DELETE FROM telegram_state WHERE task_id=?", id)
        domain.record(id, actor, "Задача выполнена")
        domain.refresh(id)
        domain.task(actor, id)
    }
    fun reset(actor: Long, id: Long, reason: String): Data =
        leaveWorkflow(actor, id, reason, TaskStatus.QUEUED)

    fun cancel(actor: Long, id: Long, reason: String): Data =
        leaveWorkflow(actor, id, reason, TaskStatus.CANCELLED)

    private fun leaveWorkflow(actor: Long, id: Long, reason: String, destination: TaskStatus): Data = db.transaction {
        val reset = destination == TaskStatus.QUEUED
        val user = domain.organizer(actor)
        val task = domain.rawTask(id)
        domain.requireWorkAccess(user, task)
        domain.active(task)
        if (!domain.canModify(user, task)) fail(403, "Изменить задачу может автор, участник или администратор.")
        val previous = domain.assignees(id)
        db.execute("DELETE FROM telegram_state WHERE task_id=?", id)
        if (reset) db.execute("DELETE FROM assignments WHERE task_id=?", id)
        db.execute("UPDATE tasks SET status=?,claimed_by=?,assigned_by=?,generation=generation+1 WHERE id=?",
            destination.code, task.claimedBy.takeUnless { reset }, task.assignedBy.takeUnless { reset }, id)
        domain.record(id, actor, if (reset) "Задача возвращена в очередь" else "Задача отменена",
            mapOf("reason" to reason, "previousVolunteerIds" to previous))
        domain.refresh(id, previous)
        domain.task(actor, id)
    }
}
