package coordination

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Path
import java.util.concurrent.CompletableFuture

private const val fixturePassword = "fixture-password-2026"

class ApplicationTest {
    @TempDir lateinit var temporary: Path

    private data class Response(val status: Int, val body: Data, val cookie: String, val headers: java.net.http.HttpHeaders)
    private class Web(port: Int) {
        private val base = "http://127.0.0.1:$port"
        private val client = HttpClient.newHttpClient()
        private var cookie = ""
        private var csrf = ""

        fun get(path: String, status: Int = 200): Response = request(path, null, status)
        fun post(path: String, data: Data = emptyMap(), status: Int = 200, extra: Map<String, String> = emptyMap()): Data =
            request(path, data, status, extra).body

        fun login(login: String = "admin", expected: Int = 200) {
            val response = request("/api/login", mapOf("login" to login, "password" to fixturePassword), expected)
            if (expected == 200) {
                cookie = response.cookie
                csrf = response.body.string("csrf")
            }
        }

        private fun request(path: String, data: Data?, expected: Int, extra: Map<String, String> = emptyMap()): Response {
            val builder = HttpRequest.newBuilder(URI.create(base + path))
            if (cookie.isNotEmpty()) builder.header("Cookie", cookie)
            if (data != null) {
                builder.POST(HttpRequest.BodyPublishers.ofString(json(data))).header("Content-Type", "application/json")
                if ("X-CSRF-Token" !in extra && csrf.isNotEmpty()) builder.header("X-CSRF-Token", csrf)
            }
            extra.forEach(builder::header)
            val response = client.send(builder.build(), HttpResponse.BodyHandlers.ofString())
            assertEquals(expected, response.statusCode(), "$path: ${response.body()}")
            val cookie = response.headers().firstValue("set-cookie").orElse("").substringBefore(';')
            return Response(response.statusCode(), runCatching { decode(response.body()).objectOrEmpty() }.getOrDefault(emptyMap()), cookie, response.headers())
        }

        fun task(title: String, vararg halls: Long): List<Data> =
            post("/api/tasks", mapOf("title" to title, "hallIds" to halls.toList()))["tasks"].objects()

        fun user(name: String, role: String, hall: Long? = null, manager: Long? = null, tags: List<Long> = emptyList()): Long =
            post("/api/admin/users", mapOf("name" to name, "roles" to listOf(role), "login" to name,
                "homeHallId" to hall, "managerId" to manager, "tagIds" to tags,
                "password" to if (role == "volunteer") null else fixturePassword)).requiredLong("id")
    }

    private fun config() = Config(port = 0, database = temporary.resolve("event.sqlite").toString(), password = fixturePassword)

    @Test
    fun sessionAndIdempotency() {
        Application(config()).use { app ->
            val web = Web(app.start())
            assertTrue(web.get("/health").body.enabled("ok"))
            assertEquals("DENY", web.get("/").headers.firstValue("X-Frame-Options").get())
            web.get("/api/bootstrap", 401)
            assertEquals("text/javascript; charset=utf-8", web.get("/ui.js").headers.firstValue("Content-Type").get())
            assertEquals("image/jpeg", web.get("/assets/lidia-perovskaya.jpg").headers.firstValue("Content-Type").get())
            assertEquals("font/ttf", web.get("/assets/manrope.ttf").headers.firstValue("Content-Type").get())
            assertEquals("image/svg+xml", web.get("/assets/nerc-logo.svg").headers.firstValue("Content-Type").get())
            web.login()
            web.post("/api/tasks", mapOf("title" to "Открыть вход"), 403, mapOf("X-CSRF-Token" to "wrong"))
            web.post("/api/tasks", mapOf("title" to "Открыть вход"), 403, mapOf("Origin" to "https://other.test"))
            val header = mapOf("Idempotency-Key" to "task-create-1")
            val first = web.post("/api/tasks", mapOf("title" to "Открыть вход"), extra = header)
            assertEquals(first, web.post("/api/tasks", mapOf("title" to "Открыть вход"), extra = header))
            web.post("/api/tasks", mapOf("title" to "Другое действие"), 409, header)
            assertEquals(1, web.get("/api/tasks").body["tasks"].listOrEmpty().size)
            web.post("/api/tasks", mapOf("description" to "  "), 400)
            val description = "Подготовить аппаратуру\nМикрофоны на стойке"
            val created = web.post("/api/tasks", mapOf("description" to description))["tasks"].objects().single()
            assertEquals(description, created.string("description"))
            assertEquals("Подготовить аппаратуру", created.string("title"))
            web.post("/api/logout")
            web.get("/api/bootstrap", 401)
        }
    }

    @Test
    fun volunteerTargetAcceptsExactCountsAndRangesAndPersistsPerTask() {
        var taskId = 0L
        Application(config()).use { app ->
            val admin = Web(app.start()).also { it.login() }
            val halls = admin.get("/api/bootstrap").body["tags"].objects()
                .filter { it.string("kind") == "hall" }.take(2).map { it.requiredLong("id") }
            val tasks = admin.post("/api/tasks", mapOf("description" to "Расставить столы",
                "hallIds" to halls, "volunteerTarget" to "2 - 3"))["tasks"].objects()
            assertEquals(listOf("2–3", "2–3"), tasks.map { it.string("volunteerTarget") })
            taskId = tasks.first().requiredLong("id")
            val secondId = tasks.last().requiredLong("id")
            admin.post("/api/tasks/$taskId/options", mapOf("volunteerTarget" to "3–2"), 400)
            val updated = admin.post("/api/tasks/$taskId/options", mapOf("volunteerTarget" to 4))
            assertEquals("4", updated.string("volunteerTarget"))
            assertEquals("2–3", admin.get("/api/tasks/$secondId").body.string("volunteerTarget"))
            val previous = admin.task("Задача без количества").single()
            assertEquals("", previous.string("volunteerTarget"))
        }
        Application(config().copy(password = null)).use { app ->
            val admin = Web(app.start()).also { it.login() }
            assertEquals("4", admin.get("/api/tasks/$taskId").body.string("volunteerTarget"))
            val cleared = admin.post("/api/tasks/$taskId/options", mapOf("volunteerTarget" to ""))
            assertEquals("", cleared.string("volunteerTarget"))
        }
    }

    @Test
    fun hallPermissionsIndependentTasksAndPersistence() {
        var first = 0L
        Application(config()).use { app ->
            val port = app.start()
            val admin = Web(port).also { it.login() }
            val halls = admin.get("/api/bootstrap").body["tags"].objects().filter { it.string("kind") == "hall" }
            assertTrue(halls.any { it.string("name") == "Hall 5" })
            val a = halls[0].requiredLong("id")
            val b = halls[1].requiredLong("id")
            admin.user("hall-manager", "manager", hall = a)
            val manager = Web(port).also { it.login("hall-manager") }
            val pair = admin.task("Разложить материалы", a, b)
            assertEquals(1, pair.map { it.longOrNull("groupId") }.distinct().size)
            first = pair.first().requiredLong("id")
            val second = pair.last().requiredLong("id")
            assertEquals(1, manager.get("/api/tasks?scope=home").body["tasks"].listOrEmpty().size)
            assertEquals(2, manager.get("/api/tasks").body["tasks"].listOrEmpty().size)
            val specificHall = manager.get("/api/tasks?scope=hall&hallId=$b&status=queued&assignment=free")
                .body["tasks"].objects().single()
            assertEquals(second, specificHall.requiredLong("id"))
            assertFalse(manager.get("/api/tasks/$second").body.enabled("canWork"))
            manager.post("/api/tasks/$second/claim", status = 403)
            assertEquals("in_progress", manager.post("/api/tasks/$first/claim").string("status"))
            val mine = manager.get("/api/tasks?scope=mine&status=in_progress&assignment=assigned")
                .body["tasks"].objects().single()
            assertEquals(first, mine.requiredLong("id"))
            assertEquals("queued", manager.get("/api/tasks/$second").body.string("status"))
            admin.post("/api/admin/settings", mapOf("crossHall" to true))
            assertEquals("in_progress", manager.post("/api/tasks/$second/claim").string("status"))
            manager.post("/api/tasks/$first/complete")
        }
        Application(config().copy(password = null)).use { app ->
            val web = Web(app.start()).also { it.login() }
            val task = web.get("/api/tasks/$first").body
            assertEquals("done", task.string("status"))
            assertEquals(3, task["history"].listOrEmpty().size)
        }
    }

    @Test
    fun concurrentClaimHasOneWinner() {
        Application(config()).use { app ->
            val port = app.start()
            val admin = Web(port).also { it.login() }
            val id = admin.task("Дежурство").single().requiredLong("id")
            val people = listOf("one", "two").map { name ->
                admin.user(name, "organizer")
                Web(port).also { it.login(name) }
            }
            val claims = people.map { web ->
                CompletableFuture.supplyAsync { runCatching { web.post("/api/tasks/$id/claim") }.isSuccess }
            }
            assertEquals(1, claims.count { it.get() })
            assertEquals(2, admin.get("/api/tasks/$id").body["history"].listOrEmpty().size)
        }
    }

    @Test
    fun telegramGroupAndDiscussionRoundTrip() {
        val api = TestBot()
        val cfg = config().copy(telegramToken = "fixture", telegramUsername = "fixture_bot")
        Application(cfg, api).use { app ->
            val port = app.start()
            val admin = Web(port).also { it.login() }
            val direction = admin.get("/api/bootstrap").body["tags"].objects().first { it.string("kind") == "direction" }.requiredLong("id")
            val managerId = admin.user("manager", "manager")
            val one = admin.user("volunteer-one", "volunteer", manager = managerId)
            val two = admin.user("volunteer-two", "volunteer", manager = managerId)
            admin.user("outside", "volunteer", manager = admin.user("another", "manager"))
            val reader = admin.user("reader", "organizer", tags = listOf(direction))
            val receiver = Web(port).also { it.login("reader") }
            val manager = Web(port).also { it.login("manager") }
            Web(port).login("volunteer-one", 401)
            val task = manager.task("Доставка комплектов").single().requiredLong("id")
            manager.post("/api/tasks/$task/assign", mapOf("volunteerIds" to listOf(one, two)))
            assertTrue(manager.get("/api/tasks/$task").body.enabled("awaitingAcceptance"))
            assertTrue(manager.get("/api/volunteers").body["volunteers"].objects().none { it.enabled("free") })
            await { manager.get("/api/deliveries").body["deliveries"].objects().any { it.string("status") == "failed" } }

            for ((person, chat) in listOf(one to 601L, two to 602L)) {
                val invite = manager.post("/api/volunteers/$person/link").string("url").substringAfter("start=")
                api.message(app.bot, chat, "/start $invite")
                assertEquals(chat, app.domain.user(person).longOrNull("telegramId"))
                assertNotNull(app.db.one("SELECT used_at FROM link_tokens WHERE token_hash=?", hashToken(invite))?.longOrNull("used_at"))
            }
            await { api.calls.count { it.first == "sendMessage" && it.second.containsKey("reply_markup") } == 2 }
            api.callback(app.bot, 601, "accept:$task:1")
            assertEquals("in_progress", manager.get("/api/tasks/$task").body.string("status"))

            api.callback(app.bot, 601, "question:$task:1")
            val update = api.message(app.bot, 601, "Где взять коробки?")
            app.bot.handle(update)
            val question = manager.get("/api/questions?box=volunteer").body["questions"].objects().single()
            assertEquals(1, question["messages"].listOrEmpty().size)
            val qid = question.requiredLong("id")
            assertTrue(receiver.get("/api/questions").body["questions"].listOrEmpty().isEmpty())
            manager.post("/api/questions/$qid/forward", mapOf("tagIds" to listOf(direction), "blocking" to true, "urgency" to "urgent"))
            val addressed = receiver.get("/api/questions").body["questions"].objects().single()
            assertEquals(listOf(reader), addressed.list("recipientIds"))
            receiver.post("/api/questions/$qid/reply", mapOf("body" to "В комнате 3"))
            assertTrue(manager.get("/api/tasks/$task").body.enabled("blocked"))
            manager.post("/api/questions/$qid/reply", mapOf("body" to "Заберите у стойки"))
            await { app.db.one("SELECT 1 FROM outbox WHERE status='sent' AND payload LIKE ?", "%Заберите у стойки%") != null }
            val replyTo = api.sentMessages.single { it.second.string("text").contains("Заберите у стойки") }.first
            api.callback(app.bot, 601, "question:$task:1")
            val followUp = api.message(app.bot, 601, "А какая стойка?", replyTo)
            app.bot.handle(followUp)
            val continued = manager.get("/api/questions?box=volunteer").body["questions"].objects().single()
            assertEquals(qid, continued.requiredLong("id"))
            assertEquals("А какая стойка?", continued["messages"].objects().last().string("body"))
            assertEquals(1, continued["messages"].objects().count { it.string("body") == "А какая стойка?" })
            manager.post("/api/questions/$qid/close")
            assertFalse(manager.get("/api/tasks/$task").body.enabled("blocked"))
            api.callback(app.bot, 602, "complete:$task:1")
            assertEquals("done", manager.get("/api/tasks/$task").body.string("status"))
            await { api.calls.any { it.first == "editMessageText" && it.second.string("text").contains("Выполнена") } }
        }
    }

    @Test
    fun returnedAssignmentRejectsOldButtons() {
        val api = TestBot()
        Application(config().copy(telegramToken = "fixture", telegramUsername = "fixture_bot"), api).use { app ->
            val port = app.start()
            val admin = Web(port).also { it.login() }
            val managerId = admin.user("manager", "manager")
            val volunteer = admin.user("volunteer", "volunteer", manager = managerId)
            val manager = Web(port).also { it.login("manager") }
            val invite = manager.post("/api/volunteers/$volunteer/link").string("url").substringAfter("start=")
            api.message(app.bot, 601, "/start $invite")
            api.message(app.bot, 602, "/start $invite")
            assertEquals(601L, app.domain.user(volunteer).longOrNull("telegramId"))
            val task = manager.task("Разметить зал").single().requiredLong("id")
            manager.post("/api/tasks/$task/assign", mapOf("mode" to "all"))
            manager.post("/api/tasks/$task/reset", mapOf("reason" to "Изменили план"))
            manager.post("/api/tasks/$task/assign", mapOf("mode" to "all"))
            api.callback(app.bot, 601, "accept:$task:1")
            assertEquals("queued", manager.get("/api/tasks/$task").body.string("status"))
            assertTrue(api.calls.any { it.first == "answerCallbackQuery" && it.second.enabled("show_alert") })
            api.callback(app.bot, 601, "accept:$task:2")
            assertEquals("in_progress", manager.get("/api/tasks/$task").body.string("status"))
        }
    }

    private fun await(predicate: () -> Boolean) {
        repeat(90) {
            if (predicate()) return
            Thread.sleep(100)
        }
        fail<Unit>("Не дождались обработки очереди")
    }

    private class TestBot : TelegramApi {
        val calls = java.util.concurrent.CopyOnWriteArrayList<Pair<String, Data>>()
        val sentMessages = java.util.concurrent.CopyOnWriteArrayList<Pair<Long, Data>>()
        private val counter = java.util.concurrent.atomic.AtomicLong()
        override fun call(method: String, payload: Data): Any? {
            calls += method to payload
            return when (method) {
                "getUpdates" -> emptyList<Data>()
                "sendMessage" -> {
                    val messageId = counter.incrementAndGet()
                    sentMessages += messageId to payload
                    mapOf("message_id" to messageId)
                }
                else -> true
            }
        }
        fun message(bot: Telegram, chat: Long, text: String, replyTo: Long? = null): Data {
            val message = mapOf("from" to mapOf("id" to chat), "chat" to mapOf("id" to chat, "type" to "private"), "text" to text) +
                if (replyTo == null) emptyMap() else mapOf("reply_to_message" to mapOf("message_id" to replyTo))
            return mapOf("update_id" to counter.incrementAndGet(), "message" to message).also(bot::handle)
        }
        fun callback(bot: Telegram, chat: Long, data: String) {
            val id = counter.incrementAndGet()
            bot.handle(mapOf("update_id" to id, "callback_query" to mapOf("id" to id.toString(), "from" to mapOf("id" to chat),
                "data" to data, "message" to mapOf("chat" to mapOf("id" to chat, "type" to "private")))))
        }
    }
}
