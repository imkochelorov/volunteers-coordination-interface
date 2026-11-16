package coordination

enum class TaskStatus(val code: String) {
    QUEUED("queued"),
    IN_PROGRESS("in_progress"),
    DONE("done"),
    CANCELLED("cancelled");

    val isTerminal: Boolean
        get() = this == DONE || this == CANCELLED

    companion object {
        fun fromCode(code: String): TaskStatus =
            entries.firstOrNull { it.code == code } ?: error("Unknown task status: $code")
    }
}

data class Task(
    val id: Long,
    val groupId: Long,
    val title: String,
    val description: String,
    val authorId: Long,
    val hallId: Long?,
    val tagIds: List<Long>,
    val status: TaskStatus,
    val claimedBy: Long?,
    val assignedBy: Long?,
    val generation: Long,
    val createdAt: String,
    val updatedAt: String,
) {
    companion object {
        fun fromRow(row: Data) = Task(
            id = row.requiredLong("id"),
            groupId = row.requiredLong("group_id"),
            title = row.string("title"),
            description = row.string("description"),
            authorId = row.requiredLong("author_id"),
            hallId = row.longOrNull("hall_id"),
            tagIds = row.jsonList("tag_ids").map {
                it.exactLongOrNull() ?: error("Invalid task tag identifier")
            },
            status = TaskStatus.fromCode(row.string("status")),
            claimedBy = row.longOrNull("claimed_by"),
            assignedBy = row.longOrNull("assigned_by"),
            generation = row.requiredLong("generation"),
            createdAt = row.string("created_at"),
            updatedAt = row.string("updated_at"),
        )
    }
}

data class Assignment(val volunteerId: Long, val acceptedAt: String?)

data class TaskSummary(
    val task: Task,
    val assignments: List<Assignment>,
    val blocked: Boolean,
    val openQuestions: Int,
    val awaitingReply: Boolean,
    val awaitingConfirmation: Boolean,
) {
    val awaitingAcceptance: Boolean
        get() = task.status == TaskStatus.QUEUED && assignments.isNotEmpty()

    fun toResponse(): Data = mapOf(
        "id" to task.id,
        "groupId" to task.groupId,
        "title" to task.title,
        "description" to task.description,
        "authorId" to task.authorId,
        "hallId" to task.hallId,
        "tagIds" to task.tagIds,
        "status" to task.status.code,
        "claimedBy" to task.claimedBy,
        "assignedBy" to task.assignedBy,
        "generation" to task.generation,
        "createdAt" to task.createdAt,
        "updatedAt" to task.updatedAt,
        "assignments" to assignments,
        "blocked" to blocked,
        "openQuestions" to openQuestions,
        "awaitingAcceptance" to awaitingAcceptance,
        "awaitingReply" to awaitingReply,
        "awaitingConfirmation" to awaitingConfirmation,
    )
}
