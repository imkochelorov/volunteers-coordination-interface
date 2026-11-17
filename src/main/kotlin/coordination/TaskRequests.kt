package coordination

internal data class TaskDraft(
    val title: String,
    val description: String,
    val tagIds: List<Long>,
    val hallIds: List<Long>,
    val allHalls: Boolean,
    val options: TaskOptions,
) {
    companion object {
        fun parse(input: Data): TaskDraft {
            val suppliedTitle = input["title"]
            val description = text(input["description"] ?: "", "Описание", 15000, required = suppliedTitle == null)
            val title = if (suppliedTitle == null) titleFrom(description) else text(suppliedTitle, "Название", 250)
            return TaskDraft(title, description, ids(input["tagIds"]), ids(input["hallIds"]),
                input.booleanOrDefault("allHalls", false), TaskOptions.parse(input))
        }

        private fun titleFrom(description: String): String {
            val firstLine = description.lineSequence().first().trim()
            val length = firstLine.codePointCount(0, firstLine.length).coerceAtMost(120)
            return firstLine.substring(0, firstLine.offsetByCodePoints(0, length))
        }
    }
}

internal data class TaskOptions(
    val priority: TaskPriority?,
    val needsStrongVolunteers: Boolean?,
    val volunteerTarget: String?,
) {
    companion object {
        private val targetPattern = Regex("""([0-9]{1,4})(?:\s*[-–—]\s*([0-9]{1,4}))?""")

        fun parse(input: Data) = TaskOptions(
            priority = input["priority"]?.let(TaskPriority::fromInput),
            needsStrongVolunteers = if ("needsStrongVolunteers" in input) {
                input["needsStrongVolunteers"] as? Boolean ?: fail(400, "Укажите, нужны ли сильные волонтёры.")
            } else null,
            volunteerTarget = if ("volunteerTarget" in input) target(input["volunteerTarget"]) else null,
        )

        private fun target(value: Any?): String {
            if (value == null || value is String && value.isBlank()) return ""
            val raw = (value as? String)?.trim() ?: value.exactLongOrNull()?.toString().orEmpty()
            val match = targetPattern.matchEntire(raw) ?: fail(400, "Укажите число волонтёров или диапазон, например 2–3.")
            val min = match.groupValues[1].toInt()
            val max = match.groups[2]?.value?.toInt() ?: min
            if (min !in 1..2000 || max !in min..2000) fail(400, "Укажите от 1 до 2000 волонтёров по возрастанию.")
            return if (min == max) min.toString() else "$min–$max"
        }
    }
}

internal enum class TaskScope(val code: String) {
    ALL("all"), HALL("hall"), HOME("home"), CREATED("created"), ASSIGNED("assigned"), MINE("mine"),
}
internal enum class AssignmentFilter(val code: String) {
    ANY(""), FREE("free"), ASSIGNED("assigned"), WAITING("waiting"),
}

internal data class TaskFilter(
    val scope: TaskScope,
    val hallId: Long?,
    val explicitHall: Boolean,
    val tagId: Long?,
    val explicitTag: Boolean,
    val search: String,
    val status: String,
    val assignment: AssignmentFilter,
    val blockedOnly: Boolean,
    val questionsOnly: Boolean,
) {
    companion object {
        fun parse(query: Data) = TaskFilter(
            TaskScope.entries.firstOrNull { it.code == query.string("scope") } ?: TaskScope.ALL,
            query.longOrNull("hallId"),
            query.string("scope") == "hall" || query.string("hallId").isNotEmpty(),
            query.longOrNull("tagId"),
            query.string("tagId").isNotEmpty(),
            query.string("q").trim().lowercase(),
            query.string("status"),
            AssignmentFilter.entries.firstOrNull { it.code == query.string("assignment") } ?: AssignmentFilter.ANY,
            query.enabled("blocked") || query.string("blocked") == "true",
            query.enabled("openQuestions") || query.string("openQuestions") == "true",
        )
    }
}
