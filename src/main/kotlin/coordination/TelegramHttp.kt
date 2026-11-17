package coordination

import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

fun interface TelegramApi {
    fun call(method: String, payload: Data): Any?
}

internal class DeliveryError(message: String, val retry: Long? = null, val missing: Boolean = false) : RuntimeException(message)

class TelegramHttp(private val token: String) : TelegramApi {
    private val client by lazy { HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build() }

    override fun call(method: String, payload: Data): Any? {
        val request = HttpRequest.newBuilder(URI.create("https://api.telegram.org/bot$token/$method"))
            .timeout(Duration.ofSeconds(if (method == "getUpdates") 35 else 15))
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(json(payload))).build()
        val response = try {
            client.send(request, HttpResponse.BodyHandlers.ofString())
        } catch (error: InterruptedException) {
            throw error
        } catch (_: Exception) {
            throw DeliveryError("Нет связи с Telegram. Повторная отправка запланирована.")
        }
        val body = try { decode(response.body()).objectOrEmpty() } catch (_: Exception) {
            throw DeliveryError("Telegram вернул некорректный ответ.")
        }
        if (response.statusCode() in 200..299 && body.enabled("ok")) return body["result"]
        val description = body.string("description")
        if (method == "editMessageText" && description.contains("message is not modified", ignoreCase = true)) return true
        val code = body.longOrNull("error_code") ?: response.statusCode().toLong()
        val message = when (code) {
            403L -> "Волонтёр должен разблокировать бота и нажать /start."
            429L -> "Telegram ограничил частоту отправки. Будет выполнен повтор."
            else -> "Ошибка Telegram ($code). Будет выполнен повтор."
        }
        throw DeliveryError(message, body["parameters"].objectOrEmpty().longOrNull("retry_after"),
            method == "editMessageText" && Regex("message to edit not found|message can.t be edited", RegexOption.IGNORE_CASE).containsMatchIn(description))
    }
}
