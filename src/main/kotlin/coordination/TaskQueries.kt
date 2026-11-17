package coordination

/** Read model shared by the board, task details, and Telegram. */
internal class TaskQueries(private val domain: Domain) {
    private val db get() = domain.db

    fun summaries(tasks: List<Task>): List<TaskSummary> = tasks.chunked(400).flatMap { batch ->
        val args = batch.map(Task::id).toTypedArray()
        val placeholders = args.joinToString(",") { "?" }
        val assignments = db.all(
            """SELECT task_id,volunteer_id,accepted_at FROM assignments
                WHERE task_id IN ($placeholders) ORDER BY volunteer_id""",
            *args,
        ).groupBy({ it.requiredLong("task_id") }) {
            Assignment(it.requiredLong("volunteer_id"), it["accepted_at"] as? String)
        }
        val questions = db.all(
            """SELECT task_id, COUNT(*) AS count, MAX(blocking=1) AS blocked,
                MAX(state='open') AS awaiting_reply, MAX(state='answered') AS awaiting_confirmation
                FROM questions WHERE task_id IN ($placeholders) AND state!='closed' GROUP BY task_id""",
            *args,
        ).associateBy { it.requiredLong("task_id") }
        batch.map { task ->
            val aggregate = questions[task.id].orEmpty()
            TaskSummary(task, assignments[task.id].orEmpty(), aggregate.enabled("blocked"),
                aggregate.longOrNull("count")?.toInt() ?: 0,
                aggregate.enabled("awaiting_reply"), aggregate.enabled("awaiting_confirmation"))
        }
    }

    fun list(actor: Long, filter: TaskFilter): List<Data> = db.access {
        val user = domain.actor(actor)
        if (filter.explicitHall && filter.hallId == null) return@access emptyList()
        val tasks = matchingTasks(user, filter)
        val crossHall = domain.crossHallEnabled()
        summaries(tasks).asSequence()
            .filter { matches(it, filter) }
            .sortedWith(compareByDescending<TaskSummary> { it.blocked }
                .thenByDescending { it.task.priority }.thenByDescending { it.task.id })
            .map { response(it, user, crossHall) }
            .toList()
    }

    private fun matchingTasks(user: Member, filter: TaskFilter): List<Task> {
        val args = mutableListOf<Any>()
        val assigned = "EXISTS (SELECT 1 FROM assignments a WHERE a.task_id=t.id AND a.volunteer_id=?)"
        val clauses = buildList {
            fun where(sql: String, vararg values: Any) {
                add(sql)
                args.addAll(values)
            }
            if (!user.profile.hasWebAccess) where(assigned, user.id)
            filter.hallId?.let { where("t.hall_id=?", it) }
            if (filter.status.isNotEmpty()) where("t.status=?", filter.status)
            when (filter.scope) {
                TaskScope.HOME -> user.profile.homeHallId?.let { where("t.hall_id=?", it) }
                TaskScope.CREATED -> where("t.author_id=?", user.id)
                TaskScope.ASSIGNED -> where("(t.claimed_by=? OR $assigned)", user.id, user.id)
                TaskScope.MINE -> where("(t.claimed_by=? OR t.assigned_by=? OR t.author_id=? OR $assigned)",
                    user.id, user.id, user.id, user.id)
                TaskScope.ALL, TaskScope.HALL -> Unit
            }
        }
        val where = if (clauses.isEmpty()) "" else clauses.joinToString(" AND ", " WHERE ")
        return db.all("SELECT t.* FROM tasks t$where ORDER BY t.id DESC", *args.toTypedArray())
            .map(Task::fromRow).filter { task ->
                (!filter.explicitTag || filter.tagId in task.tagIds) &&
                    (filter.search.isEmpty() || "${task.title} ${task.description} ${task.id}".lowercase().contains(filter.search))
            }
    }

    private fun matches(summary: TaskSummary, filter: TaskFilter): Boolean {
        if (filter.blockedOnly && !summary.blocked || filter.questionsOnly && summary.openQuestions == 0) return false
        val task = summary.task
        return when (filter.assignment) {
            AssignmentFilter.ANY -> true
            AssignmentFilter.FREE -> task.isUnassigned(summary.assignments.isNotEmpty())
            AssignmentFilter.ASSIGNED -> task.claimedBy != null || task.assignedBy != null || summary.assignments.isNotEmpty()
            AssignmentFilter.WAITING -> summary.awaitingAcceptance
        }
    }

    fun detail(actor: Long, id: Long, discussions: Discussions): Data = db.access {
        val user = domain.actor(actor)
        val task = domain.rawTask(id)
        domain.read(user, id)
        val siblings = db.all("SELECT * FROM tasks WHERE group_id=? ORDER BY hall_id,id", task.groupId).map(Task::fromRow)
        val visible = summaries(siblings).filter { summary ->
            user.profile.hasWebAccess || summary.assignments.any { it.volunteerId == actor }
        }
        val crossHall = domain.crossHallEnabled()
        response(visible.first { it.task.id == id }, user, crossHall) + mapOf(
            "questions" to discussions.forTask(user, id),
            "history" to db.all(
                "SELECT id,actor_id AS actorId,event,data,created_at AS createdAt FROM audit WHERE task_id=? ORDER BY id DESC", id
            ).map { it + ("data" to decode(it.string("data"))) },
            "siblings" to visible.map { response(it, user, crossHall) },
        )
    }

    fun response(summary: TaskSummary, user: Member, crossHall: Boolean): Data {
        val task = summary.task
        val actor = user.id
        val allowed = domain.canWork(user, task, crossHall)
        val free = allowed && task.isUnassigned(summary.assignments.isNotEmpty())
        val canModify = allowed && !task.status.isTerminal && domain.canModify(user, task)
        return summary.toResponse() + mapOf(
            "canWork" to allowed,
            "canClaim" to free,
            "canAssign" to (free && (user.isAdmin || user.isManager)),
            "canComplete" to (allowed && task.status == TaskStatus.IN_PROGRESS &&
                (task.claimedBy == actor || (user.isVolunteer && summary.assignments.any { it.volunteerId == actor }))),
            "canReset" to canModify,
            "canEditOptions" to canModify,
        )
    }
}
