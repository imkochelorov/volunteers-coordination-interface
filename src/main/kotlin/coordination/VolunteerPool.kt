package coordination

internal enum class SelectionMode(val code: String) {
    MANUAL("manual"), FREE("free"), ALL("all"),
}

internal data class AssignmentSelection(
    val mode: SelectionMode,
    val volunteerIds: Set<Long>,
    val personalTagIds: Set<Long>,
) {
    companion object {
        fun parse(input: Data): AssignmentSelection {
            val mode = when (val raw = input["mode"]) {
                null, "" -> SelectionMode.MANUAL
                else -> SelectionMode.entries.firstOrNull { it.code == raw }
                    ?: fail(400, "Неизвестный способ выбора волонтёров.")
            }
            return AssignmentSelection(mode, ids(input["volunteerIds"]).toSet(), ids(input["personalTagIds"]).toSet())
        }
    }
}

internal class VolunteerPool(private val domain: Domain) {
    private val db = domain.db

    fun list(actor: Long): List<Data> = db.access {
        val manager = domain.manager(actor)
        describe(domain.members.activeVolunteers(actor.takeUnless { manager.isAdmin }))
    }

    fun preview(actor: Long, selection: AssignmentSelection): List<Data> = db.access {
        describe(select(actor, selection))
    }

    fun recipients(actor: Long, selection: AssignmentSelection): List<Long> =
        select(actor, selection).map(Member::id)

    private fun select(actor: Long, selection: AssignmentSelection): List<Member> {
        domain.manager(actor)
        val pool = domain.members.activeVolunteers(actor)
        if (!pool.map(Member::id).toSet().containsAll(selection.volunteerIds)) {
            fail(403, "Можно назначать только волонтёров своего пула.")
        }
        val tagged = if (selection.personalTagIds.isEmpty()) emptySet()
        else taggedVolunteers(actor, selection.personalTagIds)
        val busy = if (selection.mode == SelectionMode.FREE) {
            db.all(
                """SELECT DISTINCT a.volunteer_id FROM assignments a JOIN tasks t ON t.id=a.task_id
                    JOIN users u ON u.id=a.volunteer_id
                    WHERE u.manager_id=? AND t.status IN ('queued','in_progress')""", actor,
            ).map { it.requiredLong("volunteer_id") }.toSet()
        } else emptySet()
        return pool.filter { member ->
            member.id in selection.volunteerIds || member.id in tagged || selection.mode == SelectionMode.ALL ||
                (selection.mode == SelectionMode.FREE && member.available && member.id !in busy)
        }
    }

    private fun taggedVolunteers(actor: Long, requested: Set<Long>): Set<Long> {
        val owned = db.all("SELECT id FROM personal_tags WHERE manager_id=?", actor).map { it.requiredLong("id") }
        if (!owned.containsAll(requested)) fail(403, "Личные теги другого менеджера недоступны.")
        return db.all(
            """SELECT v.volunteer_id,v.personal_tag_id FROM volunteer_personal_tags v
                JOIN personal_tags p ON p.id=v.personal_tag_id WHERE p.manager_id=?""", actor,
        ).filter { it.requiredLong("personal_tag_id") in requested }.map { it.requiredLong("volunteer_id") }.toSet()
    }

    private fun describe(members: List<Member>): List<Data> {
        val tasksByVolunteer = mutableMapOf<Long, List<Task>>()
        val tagsByVolunteer = mutableMapOf<Long, List<Long>>()
        for (batch in members.chunked(400)) {
            val args = batch.map(Member::id).toTypedArray()
            val placeholders = args.joinToString(",") { "?" }
            tasksByVolunteer += db.all(
                """SELECT a.volunteer_id,t.* FROM assignments a JOIN tasks t ON t.id=a.task_id
                    WHERE a.volunteer_id IN ($placeholders) AND t.status IN ('queued','in_progress') ORDER BY t.id DESC""",
                *args,
            ).groupBy({ it.requiredLong("volunteer_id") }, Task::fromRow)
            tagsByVolunteer += db.all(
                "SELECT volunteer_id,personal_tag_id FROM volunteer_personal_tags WHERE volunteer_id IN ($placeholders)",
                *args,
            ).groupBy({ it.requiredLong("volunteer_id") }) { it.requiredLong("personal_tag_id") }
        }
        val uniqueTasks = tasksByVolunteer.values.flatten().distinctBy(Task::id)
        val responses = domain.taskSummaries(uniqueTasks).associate { it.task.id to it.toResponse() }
        return members.map { member ->
            val tasks = tasksByVolunteer[member.id].orEmpty()
            member.response() + mapOf(
                "tasks" to tasks.map { responses.getValue(it.id) },
                "free" to (member.available && tasks.isEmpty()),
                "personalTagIds" to tagsByVolunteer[member.id].orEmpty(),
            )
        }
    }

    fun setAvailability(actor: Long, available: Boolean) = db.transaction {
        if (!domain.actor(actor).isVolunteer) fail(403, "Доступность устанавливает волонтёр.")
        db.execute("UPDATE users SET available=? WHERE id=?", if (available) 1 else 0, actor)
    }

    fun savePersonalTags(actor: Long, target: Long, input: Data): Data = db.transaction {
        domain.manager(actor)
        val member = domain.user(target)
        if (!member.isVolunteer || member.profile.managerId != actor) {
            fail(403, "Личные теги доступны только внутри своего пула.")
        }
        val values = input["names"]
        if (values !is List<*> || values.size > 100) fail(400, "Укажите список личных тегов.")
        val names = values.map { text(it, "Название личного тега", 80) }.distinct()
        db.execute(
            """DELETE FROM volunteer_personal_tags WHERE volunteer_id=? AND personal_tag_id IN
                (SELECT id FROM personal_tags WHERE manager_id=?)""", target, actor,
        )
        for (name in names) {
            db.execute("INSERT OR IGNORE INTO personal_tags(manager_id,name) VALUES (?,?)", actor, name)
            db.execute(
                """INSERT INTO volunteer_personal_tags(volunteer_id,personal_tag_id)
                    SELECT ?,id FROM personal_tags WHERE manager_id=? AND name=?""", target, actor, name,
            )
        }
        describe(listOf(member)).single()
    }
}
