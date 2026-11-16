package coordination

import com.google.gson.JsonParseException
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.io.Closeable
import java.net.InetSocketAddress
import java.net.URLDecoder
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

private val taskRoute = Regex("/api/tasks/(\\d+)(?:/(claim|assign|complete|cancel|reset|questions))?")
private val volunteerRoute = Regex("/api/volunteers/(\\d+)/(tags|link)")
private val questionRoute = Regex("/api/questions/(\\d+)/(reply|forward|close)")
private val deliveryRoute = Regex("/api/deliveries/(\\d+)/retry")
private val requestKey = Regex("[a-zA-Z0-9_-]{1,100}")
private val sessionCookie = Regex("(?:^|;\\s*)coord_session=([a-f0-9]{64})(?=;|$)")
private val files = mapOf("/" to ("index.html" to "text/html"), "/index.html" to ("index.html" to "text/html"),
    "/app.js" to ("app.js" to "text/javascript"),
    "/ui.js" to ("ui.js" to "text/javascript"),
    "/landing-content.js" to ("landing-content.js" to "text/javascript"),
    "/landing.js" to ("landing.js" to "text/javascript"),
    "/style.css" to ("style.css" to "text/css"),
    "/assets/lidia-perovskaya.jpg" to ("assets/lidia-perovskaya.jpg" to "image/jpeg"),
    "/assets/neerc-balloon.png" to ("assets/neerc-balloon.png" to "image/png"),
    "/assets/nerc-contest.jpg" to ("assets/nerc-contest.jpg" to "image/jpeg"),
    "/assets/nerc-team.jpg" to ("assets/nerc-team.jpg" to "image/jpeg"),
    "/assets/nerc-logo.svg" to ("assets/nerc-logo.svg" to "image/svg+xml"),
    "/assets/manrope.ttf" to ("assets/manrope.ttf" to "font/ttf"),
    "/assets/OFL-Manrope.txt" to ("assets/OFL-Manrope.txt" to "text/plain"),
)
private val ok = mapOf("ok" to true)
private const val sessionDuration = 43_200_000L

class Application(private val config: Config, api: TelegramApi = TelegramHttp(config.telegramToken)) : Closeable {
    val db = Database(config.database)
    val domain = Domain(db)
    private val discussions = Discussions(domain)
    private val accounts = Accounts(domain)
    val bot = Telegram(domain, discussions, config.telegramToken.isNotEmpty(), config.telegramUsername, api)
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
    private var nextCleanup = 0L

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
                val result = db.access { route(exchange, path, method, body) }
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
        val value = try { decode(bytes.toString(UTF_8)) } catch (_: JsonParseException) { fail(400, "Некорректный JSON.") }
        if (value !is Map<*, *>) fail(400, "Некорректный JSON.")
        return value.objectOrEmpty()
    }

    private fun query(exchange: HttpExchange): Data = try {
        exchange.requestURI.rawQuery.orEmpty().split('&').filter(String::isNotEmpty).associate {
            URLDecoder.decode(it.substringBefore('='), UTF_8) to URLDecoder.decode(it.substringAfter('=', ""), UTF_8)
        }
    } catch (_: IllegalArgumentException) { fail(400, "Некорректные параметры запроса.") }

    private fun login(exchange: HttpExchange, body: Data): Data {
        val login = body.string("login").trim().take(100)
        val rateKey = hashToken("${exchange.remoteAddress.address.hostAddress}:$login")
        val now = milliseconds()
        val attempt = db.one("SELECT * FROM login_attempts WHERE key=?", rateKey)
        if (attempt != null && attempt.requiredLong("reset_at") > now && attempt.requiredLong("count") >= 5) {
            fail(429, "Слишком много попыток. Повторите через 15 минут.")
        }
        val row = db.one("SELECT id,password_hash FROM users WHERE login=?", login)
        val stored = row?.string("password_hash").orEmpty().ifEmpty { "0".repeat(32) + ":" + "0".repeat(128) }
        val valid = verifyPassword(body["password"], stored)
        val user = row?.let { domain.user(it.requiredLong("id")) }
        if (!valid || user == null || !user.enabled("active") || !user.web()) {
            db.execute("""INSERT INTO login_attempts(key,count,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET
                count=CASE WHEN reset_at<=? THEN 1 ELSE count+1 END,
                reset_at=CASE WHEN reset_at<=? THEN excluded.reset_at ELSE reset_at END""", rateKey, now + 900000, now, now)
            fail(401, "Неверный логин или пароль.")
        }
        val token = randomHex(32)
        val csrf = randomHex(24)
        db.transaction {
            db.execute("DELETE FROM login_attempts WHERE key=?", rateKey)
            db.execute("INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(?,?,?,?)",
                hashToken(token), user["id"], csrf, now + sessionDuration)
        }
        exchange.responseHeaders.set("Set-Cookie", cookie(token, (sessionDuration / 1000).toInt()))
        return mapOf("user" to user, "csrf" to csrf)
    }

    private fun route(exchange: HttpExchange, path: String, method: String, body: Data): Any? {
        val now = milliseconds()
        if (now >= nextCleanup) {
            db.execute("DELETE FROM sessions WHERE expires_at<?", now)
            db.execute("DELETE FROM login_attempts WHERE reset_at<?", now)
            db.execute("DELETE FROM request_keys WHERE created_at<?", now - 7L * 86400000)
            nextCleanup = now + 3600000
        }
        val post = method == "POST"
        if (post && path == "/api/login") return login(exchange, body)
        val token = sessionCookie.find(exchange.requestHeaders.getFirst("Cookie").orEmpty())?.groupValues?.get(1)
        val session = token?.let { db.one("SELECT * FROM sessions WHERE token_hash=? AND expires_at>?", hashToken(it), now) }
            ?: fail(401, "Войдите в приложение.")
        val user = domain.user(session.requiredLong("user_id"))
        if (!user.enabled("active") || !user.web()) fail(401, "Войдите в приложение.")
        val actor = user.requiredLong("id")
        if (post && exchange.requestHeaders.getFirst("X-CSRF-Token") != session.string("csrf")) {
            fail(403, "Обновите страницу: проверка безопасности не пройдена.")
        }
        if (post && path == "/api/logout") {
            db.execute("DELETE FROM sessions WHERE token_hash=?", session["token_hash"])
            exchange.responseHeaders.set("Set-Cookie", cookie("", 0))
            return ok
        }
        if (!post) return when (path) {
            "/api/bootstrap" -> domain.bootstrap(actor) + mapOf("csrf" to session["csrf"], "telegram" to bot.status())
            "/api/tasks" -> mapOf("tasks" to domain.listTasks(actor, query(exchange)))
            "/api/volunteers" -> mapOf("volunteers" to domain.volunteers(actor))
            "/api/questions" -> mapOf("questions" to discussions.list(actor, query(exchange).string("box").ifEmpty { "incoming" }))
            "/api/deliveries" -> accounts.deliveries(actor)
            else -> {
                val match = taskRoute.matchEntire(path)
                if (match == null || match.groupValues[2].isNotEmpty()) fail(404, "Запрос не найден.")
                domain.task(actor, id(match.groupValues[1]), discussions)
            }
        }
        val key = exchange.requestHeaders.getFirst("Idempotency-Key")?.takeIf(String::isNotEmpty)
        if (key != null && !requestKey.matches(key)) fail(400, "Некорректный ключ запроса.")
        val cache = key?.takeUnless { volunteerRoute.matchEntire(path)?.groupValues?.get(2) == "link" }
        val fingerprint = hashToken("$path:${json(body)}")
        return db.transaction {
            val previous = cache?.let { db.one("SELECT * FROM request_keys WHERE user_id=? AND request_key=?", actor, it) }
            if (previous != null) {
                if (previous.string("fingerprint") != fingerprint) fail(409, "Ключ запроса уже использован для другого действия.")
                return@transaction decode(previous.string("response"))
            }
            val result = mutate(path, actor, body, session)
            if (cache != null) db.execute("INSERT INTO request_keys VALUES(?,?,?,?,?)", actor, cache, fingerprint, json(result), now)
            result
        }
    }

    private fun mutate(path: String, actor: Long, body: Data, session: Data): Data {
        when (path) {
            "/api/tasks" -> return mapOf("tasks" to domain.createTask(actor, body))
            "/api/volunteers/preview" -> return mapOf("volunteers" to domain.preview(actor, body))
            "/api/admin/settings" -> return accounts.settings(actor, body)
            "/api/admin/tags" -> return accounts.tag(actor, body)
            "/api/admin/users" -> return accounts.save(actor, body, session)
            "/api/change-password" -> {
                val row = checkNotNull(db.one("SELECT password_hash FROM users WHERE id=?", actor))
                if (!verifyPassword(body["currentPassword"], row.string("password_hash"))) fail(403, "Текущий пароль не подходит.")
                db.execute("UPDATE users SET password_hash=? WHERE id=?", hashPassword(body["password"]), actor)
                db.execute("DELETE FROM sessions WHERE user_id=? AND token_hash!=?", actor, session["token_hash"])
                return ok
            }
        }
        taskRoute.matchEntire(path)?.let { match ->
            val task = id(match.groupValues[1])
            return when (match.groupValues[2]) {
                "claim" -> domain.claim(actor, task)
                "assign" -> domain.assign(actor, task, body)
                "complete" -> domain.complete(actor, task)
                "cancel" -> domain.modify(actor, task, body["reason"], reset = false)
                "reset" -> domain.modify(actor, task, body["reason"], reset = true)
                "questions" -> discussions.create(actor, task, body)
                else -> fail(404, "Действие не найдено.")
            }
        }
        volunteerRoute.matchEntire(path)?.let { match ->
            val target = id(match.groupValues[1])
            return if (match.groupValues[2] == "tags") domain.personalTags(actor, target, body) else bot.createLink(actor, target)
        }
        questionRoute.matchEntire(path)?.let { match ->
            val question = id(match.groupValues[1])
            return when (match.groupValues[2]) {
                "reply" -> discussions.reply(actor, question, body)
                "forward" -> discussions.forward(actor, question, body)
                else -> discussions.close(actor, question, body)
            }
        }
        deliveryRoute.matchEntire(path)?.let { return accounts.retry(actor, id(it.groupValues[1])) }
        fail(404, "Действие не найдено.")
    }

    override fun close() {
        server.stop(1)
        executor.shutdown()
        bot.close()
        db.close()
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
