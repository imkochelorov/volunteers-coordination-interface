package coordination

import java.time.Instant
import java.time.temporal.ChronoUnit

private const val MAX_SAFE_JSON_INTEGER = 9_007_199_254_740_991L

fun stamp(): String = Instant.now().truncatedTo(ChronoUnit.MILLIS).toString()
fun milliseconds(): Long = System.currentTimeMillis()

class AppError(val status: Int, message: String) : RuntimeException(message)
fun fail(status: Int, message: String): Nothing = throw AppError(status, message)
fun id(value: Any?): Long {
    val number = value.exactLongOrNull()
    return number?.takeIf { it in 1..MAX_SAFE_JSON_INTEGER } ?: fail(400, "Некорректный идентификатор.")
}
fun ids(value: Any?): List<Long> {
    if (value == null) return emptyList()
    if (value !is List<*> || value.size > 2000) fail(400, "Ожидается список идентификаторов.")
    return value.map(::id).distinct()
}
fun text(value: Any?, label: String, limit: Int, required: Boolean = true): String {
    if (value !is String || value.length > limit || (required && value.isBlank())) {
        fail(400, "$label: укажите текст до $limit символов.")
    }
    return value.trim()
}
