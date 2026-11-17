package coordination

import java.io.Closeable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class Telegram(
    domain: Domain,
    discussions: Discussions,
    private val configured: Boolean,
    private val username: String,
    private val api: TelegramApi,
) : Closeable {
    private val db = domain.db
    private val handlers = TelegramUpdates(domain, discussions, configured, username)
    private val outbox = TelegramOutbox(domain, api)
    private val workers = Executors.newScheduledThreadPool(2)
    @Volatile private var running = false
    @Volatile private var lastPoll: String? = null
    @Volatile private var pollError: String? = null
    @Volatile private var deliveryError: String? = null
    private var initialized = false

    fun status(): Data = mapOf(
        "configured" to configured, "running" to running, "username" to username.ifEmpty { null },
        "lastPollAt" to lastPoll, "error" to (pollError ?: deliveryError),
    )

    fun createLink(actor: Long, target: Long): Data = handlers.createLink(actor, target)
    fun drain() = outbox.drain()

    fun handle(update: Data) = handleParsed(TelegramUpdate.parse(update), persistOffset = false)

    private fun handleParsed(update: TelegramUpdate, persistOffset: Boolean) {
        val answer = db.transaction {
            val inserted = db.execute(
                "INSERT OR IGNORE INTO telegram_updates(update_id,created_at) VALUES(?,?)", update.id, stamp(),
            )
            val result = if (inserted == 0) mapOf("text" to "Это действие уже обработано.") else {
                try {
                    val text = db.transaction { update.chatId?.let { handlers.process(update, it) } }
                    mapOf("text" to (text ?: "Готово."))
                } catch (error: AppError) {
                    if (update.chatId != null && update.callbackId == null) {
                        handlers.message("${update.eventKey}:error", null, error.message.orEmpty(), update.chatId)
                    }
                    mapOf("text" to error.message, "show_alert" to true)
                }
            }
            if (persistOffset) db.execute(
                """INSERT INTO meta(key,value) VALUES('telegram_offset',?)
                    ON CONFLICT(key) DO UPDATE SET value=MAX(CAST(value AS INTEGER),CAST(excluded.value AS INTEGER))""",
                (update.id + 1).toString(),
            )
            result
        }
        if (configured && update.callbackId != null) {
            try {
                api.call("answerCallbackQuery", answer + ("callback_query_id" to update.callbackId))
            } catch (_: DeliveryError) {
                // A callback acknowledgement can expire after the operation has committed.
            }
        }
    }

    private fun poll() {
        if (!running) return
        try {
            if (!initialized) {
                api.call("deleteWebhook", mapOf("drop_pending_updates" to false))
                api.call("setMyCommands", mapOf("commands" to telegramCommands.map { (name, label) -> mapOf("command" to name, "description" to label) }))
                initialized = true
            }
            val offset = db.one("SELECT value FROM meta WHERE key='telegram_offset'")?.longOrNull("value") ?: 0
            val updates = api.call("getUpdates", mapOf("offset" to offset, "timeout" to 25,
                "allowed_updates" to listOf("message", "callback_query"))).objects()
            for (update in updates.sortedBy { it.longOrNull("update_id") ?: -1 }) {
                if (!running) return
                handleParsed(TelegramUpdate.parse(update), persistOffset = true)
            }
            lastPoll = stamp()
            pollError = null
        } catch (error: InterruptedException) {
            Thread.currentThread().interrupt()
            return
        } catch (error: Exception) {
            pollError = if (error is DeliveryError) error.message else "Ошибка обработки Telegram. Повторное подключение запланировано."
        }
        synchronized(this) {
            if (running) workers.schedule(::poll, if (pollError == null) 100 else 4000, TimeUnit.MILLISECONDS)
        }
    }

    @Synchronized
    fun start() {
        if (running || !configured || workers.isShutdown) return
        running = true
        workers.execute(::poll)
        workers.scheduleWithFixedDelay({
            try {
                drain()
                deliveryError = null
            } catch (_: Exception) {
                deliveryError = "Ошибка очереди доставки. Повтор запланирован."
            }
        }, 0, 1, TimeUnit.SECONDS)
    }

    override fun close() {
        synchronized(this) {
            running = false
            workers.shutdownNow()
        }
        workers.awaitTermination(5, TimeUnit.SECONDS)
    }
}
