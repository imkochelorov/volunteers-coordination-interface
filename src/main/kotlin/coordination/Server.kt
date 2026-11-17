package coordination

import com.google.gson.JsonParseException
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.io.Closeable
import java.net.InetSocketAddress
import java.net.URLDecoder
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.StandardCharsets.UTF_8
import java.nio.file.Files
import java.nio.file.Path
import java.sql.DriverManager
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

data class Config(
    val host: String = "127.0.0.1",
    val port: Int = 4319,
    val database: String = "data/app.sqlite",
    val login: String = "admin",
    val password: String? = null,
    val telegramToken: String = "",
    val telegramUsername: String = "",
    val secure: Boolean = false,
    val publicOrigin: String = "",
) {
    companion object {
        fun load(): Config {
            val path = Path.of(".env")
            val file = if (Files.isRegularFile(path)) Files.readAllLines(path).mapNotNull { raw ->
                val line = raw.trim().removePrefix("export ")
                if (line.startsWith("#") || '=' !in line) null else {
                    val value = line.substringAfter('=').trim()
                    val quoted = value.firstOrNull()?.takeIf { it in listOf('"', '\'') }
                    line.substringBefore('=').trim() to if (quoted == null) value.substringBefore('#').trimEnd()
                    else value.substring(1).substringBefore(quoted)
                }
            }.toMap() else emptyMap()
            fun get(name: String, fallback: String = "") = (System.getenv(name) ?: file[name]).orEmpty().ifEmpty { fallback }
            val token = get("TELEGRAM_BOT_TOKEN")
            val username = get("TELEGRAM_BOT_USERNAME").removePrefix("@")
            require(token.isEmpty() || username.matches(Regex("[A-Za-z0-9_]{5,32}"))) {
                "Для Telegram задайте корректный TELEGRAM_BOT_USERNAME."
            }
            return Config(get("HOST", "127.0.0.1"), get("PORT", "4319").toInt(),
                get("DATABASE_PATH", "data/app.sqlite"), get("ADMIN_LOGIN", "admin"), get("ADMIN_PASSWORD").ifEmpty { null },
                token, username, get("SECURE_COOKIES") == "1", get("PUBLIC_ORIGIN"))
        }
    }
}

private val sessionCookie = Regex("(?:^|;\\s*)coord_session=([a-f0-9]{64})(?=;|$)")
private val files = mapOf("/" to ("index.html" to "text/html"), "/index.html" to ("index.html" to "text/html"),
    "/app.js" to ("app.js" to "text/javascript"),
    "/ui.js" to ("ui.js" to "text/javascript"),
    "/login-screen.js" to ("login-screen.js" to "text/javascript"),
    "/style.css" to ("style.css" to "text/css"),
    "/assets/lidia-perovskaya.jpg" to ("assets/lidia-perovskaya.jpg" to "image/jpeg"),
    "/assets/neerc-balloon.png" to ("assets/neerc-balloon.png" to "image/png"),
    "/assets/nerc-contest.jpg" to ("assets/nerc-contest.jpg" to "image/jpeg"),
    "/assets/nerc-team.jpg" to ("assets/nerc-team.jpg" to "image/jpeg"),
    "/assets/nerc-logo.svg" to ("assets/nerc-logo.svg" to "image/svg+xml"),
    "/assets/manrope.ttf" to ("assets/manrope.ttf" to "font/ttf"),
    "/assets/OFL-Manrope.txt" to ("assets/OFL-Manrope.txt" to "text/plain"),
    "/assets/LUCIDE-LICENSE.txt" to ("assets/LUCIDE-LICENSE.txt" to "text/plain"),
)
class Application(private val config: Config, api: TelegramApi = TelegramHttp(config.telegramToken)) : Closeable {
    val db = Database(config.database)
    val domain = Domain(db)
    private val discussions = Discussions(domain)
    val bot = Telegram(domain, discussions, config.telegramToken.isNotEmpty(), config.telegramUsername, api)
    private val routes = Api(domain, discussions, bot)
    private val executor = ThreadPoolExecutor(8, 8, 0, TimeUnit.SECONDS,
        ArrayBlockingQueue(64), ThreadPoolExecutor.CallerRunsPolicy())
    private val server = try {
        db.transaction {
            if (db.one("SELECT id FROM users LIMIT 1") == null) {
                val password = config.password ?: error("При первом запуске задайте ADMIN_PASSWORD в .env (минимум 12 символов).")
                db.execute("""INSERT INTO users(name,login,password_hash,roles,tag_ids,created_at)
                    VALUES(?,?,?,?,'[]',?)""", "Администратор", config.login,
                    hashPassword(password), json(listOf("admin", "organizer")), stamp())
            }
        }
        HttpServer.create(InetSocketAddress(config.host, config.port), 32).also {
            it.executor = executor
            it.createContext("/", ::handle)
        }
    } catch (error: Throwable) {
        bot.close()
        db.close()
        throw error
    }

    fun start(): Int {
        server.start()
        bot.start()
        return server.address.port
    }

    private fun cookie(token: String, age: Int) =
        "coord_session=$token; Path=/; HttpOnly; SameSite=Strict; Max-Age=$age" + if (config.secure) "; Secure" else ""

    private fun respond(exchange: HttpExchange, status: Int, data: Any?) {
        exchange.responseHeaders.set("Content-Type", "application/json; charset=utf-8")
        exchange.responseHeaders.set("Cache-Control", "no-store")
        send(exchange, status, json(data).toByteArray())
    }

    private fun send(exchange: HttpExchange, status: Int, data: ByteArray) {
        exchange.sendResponseHeaders(status, data.size.toLong())
        exchange.responseBody.write(data)
    }

    private fun handle(exchange: HttpExchange) {
        exchange.use {
            val headers = exchange.responseHeaders
            headers.set("X-Content-Type-Options", "nosniff")
            headers.set("Referrer-Policy", "same-origin")
            headers.set("X-Frame-Options", "DENY")
            headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
            try {
                val path = exchange.requestURI.rawPath
                val method = exchange.requestMethod
                if (method == "GET" && path == "/health") {
                    respond(exchange, 200, mapOf("ok" to (db.one("SELECT 1") != null), "telegramConfigured" to config.telegramToken.isNotEmpty()))
                    return
                }
                if (method == "GET" && !path.startsWith("/api/")) {
                    val (file, type) = files[path] ?: fail(404, "Страница не найдена.")
                    val data = checkNotNull(javaClass.getResourceAsStream("/public/$file")).use { stream -> stream.readAllBytes() }
                    headers.set("Content-Type", if (type.startsWith("text/")) "$type; charset=utf-8" else type)
                    headers.set("Cache-Control", "no-cache")
                    send(exchange, 200, data)
                    return
                }
                if (method !in listOf("GET", "POST")) {
                    headers.set("Allow", "GET, POST")
                    fail(405, "Метод не поддерживается.")
                }
                val origin = exchange.requestHeaders.getFirst("Origin")
                val expected = config.publicOrigin.ifEmpty { "http://${exchange.requestHeaders.getFirst("Host")}" }
                if (method == "POST" && origin != null && origin != expected) fail(403, "Источник запроса не разрешён.")
                val body = if (method == "POST") readBody(exchange) else emptyMap()
                val result = if (method == "POST" && path == "/api/login") {
                    val login = routes.login(exchange.remoteAddress.address.hostAddress, body)
                    headers.set("Set-Cookie", cookie(login.token, SESSION_DURATION_SECONDS))
                    mapOf("user" to login.user.response(), "csrf" to login.csrf)
                } else {
                    val token = sessionCookie.find(exchange.requestHeaders.getFirst("Cookie").orEmpty())?.groupValues?.get(1)
                    val response = routes.handle(path, method, token, exchange.requestHeaders.getFirst("X-CSRF-Token"),
                        exchange.requestHeaders.getFirst("Idempotency-Key"), query(exchange), body)
                    if (method == "POST" && path == "/api/logout") headers.set("Set-Cookie", cookie("", 0))
                    response
                }
                respond(exchange, 200, result)
            } catch (error: AppError) {
                respond(exchange, error.status, mapOf("error" to error.message))
            } catch (error: Exception) {
                System.err.println("Ошибка HTTP: ${error.javaClass.simpleName}")
                if (exchange.responseCode == -1) respond(exchange, 500, mapOf("error" to "Не удалось выполнить действие. Повторите попытку."))
            }
        }
    }

    private fun readBody(exchange: HttpExchange): Data {
        if (exchange.requestHeaders.getFirst("Content-Type")?.substringBefore(';')?.trim()?.lowercase() != "application/json") {
            fail(415, "Отправьте данные в формате JSON.")
        }
        val bytes = exchange.requestBody.readNBytes(65537)
        if (bytes.size > 65536) fail(413, "Слишком большой запрос.")
        if (bytes.isEmpty()) return emptyMap()
        val value = try {
            decode(UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes)).toString())
        } catch (_: CharacterCodingException) {
            fail(400, "JSON должен быть в кодировке UTF-8.")
        } catch (_: JsonParseException) {
            fail(400, "Некорректный JSON.")
        } catch (_: NumberFormatException) {
            fail(400, "Некорректное число в JSON.")
        }
        if (value !is Map<*, *>) fail(400, "Некорректный JSON.")
        return value.objectOrEmpty()
    }

    private fun query(exchange: HttpExchange): Data = try {
        exchange.requestURI.rawQuery.orEmpty().split('&').filter(String::isNotEmpty).associate {
            URLDecoder.decode(it.substringBefore('='), UTF_8) to URLDecoder.decode(it.substringAfter('=', ""), UTF_8)
        }
    } catch (_: IllegalArgumentException) { fail(400, "Некорректные параметры запроса.") }

    override fun close() {
        server.stop(1)
        executor.shutdown()
        try {
            if (!executor.awaitTermination(5, TimeUnit.SECONDS)) executor.shutdownNow()
        } finally {
            try {
                bot.close()
            } finally {
                db.close()
            }
        }
    }
}

fun main(args: Array<String>) {
    try {
        val config = Config.load()
        if (args.firstOrNull() == "backup") {
            require(args.size == 2) { "Использование: volunteers-coordination-interface backup <файл.sqlite>" }
            val source = Path.of(config.database).toAbsolutePath().normalize()
            val destination = Path.of(args[1]).toAbsolutePath().normalize()
            require(Files.isRegularFile(source)) { "Рабочая база не найдена." }
            require(source != destination && !Files.exists(destination)) { "Укажите новый файл для резервной копии." }
            Files.createDirectories(destination.parent)
            DriverManager.getConnection("jdbc:sqlite:$source").use { connection ->
                connection.createStatement().use { it.execute("PRAGMA busy_timeout=5000") }
                connection.prepareStatement("VACUUM INTO ?").use {
                    it.setString(1, destination.toString())
                    it.executeUpdate()
                }
            }
            println("Копия SQLite сохранена в $destination")
            return
        }
        val app = Application(config)
        Runtime.getRuntime().addShutdownHook(Thread { app.close() })
        println("Координация мероприятия: http://${config.host}:${app.start()}")
    } catch (error: Exception) {
        System.err.println(error.message ?: error.javaClass.simpleName)
        kotlin.system.exitProcess(1)
    }
}
