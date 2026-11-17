package coordination

import com.google.gson.GsonBuilder
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonPrimitive
import com.google.gson.Strictness
import java.math.BigDecimal

typealias Data = Map<String, Any?>

private val gson = GsonBuilder()
    .serializeNulls()
    .disableHtmlEscaping()
    .setStrictness(Strictness.STRICT)
    .create()

fun json(value: Any?): String = gson.toJson(value)

fun decode(value: String): Any? =
    gson.fromJson(value, JsonElement::class.java)?.toValue()

private fun JsonElement.toValue(): Any? = when (this) {
    is JsonNull -> null
    is JsonObject -> entrySet().associate { (key, value) -> key to value.toValue() }
    is JsonArray -> map { it.toValue() }
    is JsonPrimitive -> when {
        isBoolean -> asBoolean
        isNumber -> asString.toLongOrNull() ?: asBigDecimal
        else -> asString
    }
    else -> error("Unsupported JSON element")
}

fun Any?.objectOrEmpty(): Data {
    val value = this as? Map<*, *> ?: return emptyMap()
    return value.entries.associate { (key, field) ->
        check(key is String) { "JSON object keys must be strings" }
        key to field
    }
}

fun Any?.listOrEmpty(): List<*> = this as? List<*> ?: emptyList<Any?>()
fun Any?.objects(): List<Data> = listOrEmpty().map { it.objectOrEmpty() }
fun Data.string(key: String): String = this[key] as? String ?: ""
fun Data.longOrNull(key: String): Long? = this[key].exactLongOrNull()
fun Data.requiredLong(key: String): Long = longOrNull(key) ?: error("Missing numeric field: $key")
fun Data.enabled(key: String): Boolean = this[key] == true || longOrNull(key) == 1L
fun Data.jsonList(key: String): List<*> = (this[key] as? String)?.let(::decode).listOrEmpty()
fun Data.list(key: String): List<*> = this[key].listOrEmpty()

internal fun Any?.exactLongOrNull(): Long? = when (this) {
    is Long -> this
    is Int -> toLong()
    is Short -> toLong()
    is Byte -> toLong()
    is BigDecimal -> toExactLongOrNull()
    is String -> toLongOrNull() ?: toBigDecimalOrNull()?.toExactLongOrNull()
    else -> null
}

private fun BigDecimal.toExactLongOrNull(): Long? = try {
    longValueExact()
} catch (_: ArithmeticException) {
    null
}
