package coordination

private val taskRoute = Regex("/api/tasks/(\\d+)(?:/(claim|assign|complete|cancel|reset|questions|options))?")
private val volunteerRoute = Regex("/api/volunteers/(\\d+)/(tags|link)")
private val questionRoute = Regex("/api/questions/(\\d+)/(reply|forward|close)")
private val deliveryRoute = Regex("/api/deliveries/(\\d+)/retry")

private val ok = mapOf("ok" to true)

internal class Api(private val domain: Domain, private val discussions: Discussions, private val bot: Telegram) {
    private val accounts = Accounts(domain)
    private val eventSettings = EventSettings(domain)
    private val deliveries = DeliveryQueue(domain)
    private val sessions = Sessions(domain)
    private val requestKeys = RequestKeys(domain.db)

    fun login(address: String, input: Data): SignIn {
        sessions.cleanup()
        return sessions.login(address, input)
    }

    fun handle(
        path: String, method: String, token: String?, csrf: String?, requestKey: String?,
        query: Data, body: Data,
    ): Data = domain.db.access {
        sessions.cleanup()
        val post = method == "POST"
        val session = sessions.authenticate(token, post, csrf)
        val actor = session.userId
        if (!post) return@access read(path, session, query)
        if (path == "/api/logout") {
            sessions.logout(session)
            return@access ok
        }
        val key = requestKeys.parse(requestKey)
        if (path == "/api/volunteers/preview") {
            return@access mapOf("volunteers" to domain.pool.preview(actor, AssignmentSelection.parse(body)))
        }
        // Invitation URLs are single-use secrets and never enter the response cache.
        val cacheKey = key?.takeUnless { volunteerRoute.matchEntire(path)?.groupValues?.get(2) == "link" }
        requestKeys.apply(actor, cacheKey, path, body) { mutate(path, actor, body, session) }
    }

    private fun read(path: String, session: Session, query: Data): Data {
        val actor = session.userId
        return when (path) {
            "/api/bootstrap" -> domain.bootstrap(actor) + mapOf("csrf" to session.csrf, "telegram" to bot.status())
            "/api/tasks" -> mapOf("tasks" to domain.listTasks(actor, TaskFilter.parse(query)))
            "/api/volunteers" -> mapOf("volunteers" to domain.pool.list(actor))
            "/api/questions" -> mapOf("questions" to discussions.list(actor, query.string("box").ifEmpty { "incoming" }))
            "/api/deliveries" -> deliveries.list(actor)
            else -> {
                val match = taskRoute.matchEntire(path)
                if (match == null || match.groupValues[2].isNotEmpty()) fail(404, "Запрос не найден.")
                domain.task(actor, id(match.groupValues[1]), discussions)
            }
        }
    }

    private fun mutate(path: String, actor: Long, body: Data, session: Session): Data {
        when (path) {
            "/api/tasks" -> return mapOf("tasks" to domain.taskWorkflow.createTask(actor, TaskDraft.parse(body)))
            "/api/board/tag-sets" -> return domain.saveBoardTagSets(actor, body)
            "/api/admin/settings" -> return eventSettings.settings(actor, body)
            "/api/admin/tags" -> return eventSettings.tag(actor, body)
            "/api/admin/users" -> return accounts.save(actor, body, session.tokenHash).response()
            "/api/change-password" -> {
                sessions.changePassword(session, body["currentPassword"], body["password"])
                return ok
            }
        }
        taskRoute.matchEntire(path)?.let { match ->
            val task = id(match.groupValues[1])
            return when (match.groupValues[2]) {
                "options" -> domain.taskWorkflow.updateTaskOptions(actor, task, TaskOptions.parse(body))
                "claim" -> domain.taskWorkflow.claim(actor, task)
                "assign" -> domain.taskWorkflow.assign(actor, task, AssignmentSelection.parse(body))
                "complete" -> domain.taskWorkflow.complete(actor, task)
                "cancel" -> domain.taskWorkflow.cancel(actor, task, text(body["reason"], "Причина", 2000))
                "reset" -> domain.taskWorkflow.reset(actor, task, text(body["reason"], "Причина", 2000))
                "questions" -> discussions.create(actor, task, QuestionInput.parse(body))
                else -> fail(404, "Действие не найдено.")
            }
        }
        volunteerRoute.matchEntire(path)?.let { match ->
            val target = id(match.groupValues[1])
            return if (match.groupValues[2] == "tags") domain.pool.savePersonalTags(actor, target, body) else bot.createLink(actor, target)
        }
        questionRoute.matchEntire(path)?.let { match ->
            val question = id(match.groupValues[1])
            return when (match.groupValues[2]) {
                "reply" -> discussions.reply(actor, question, text(body["body"], "Ответ", 10000))
                "forward" -> discussions.forward(actor, question, QuestionInput.parse(body, forwarding = true))
                else -> discussions.close(actor, question, text(body["body"] ?: "", "Итоговое пояснение", 10000, false))
            }
        }
        deliveryRoute.matchEntire(path)?.let { return deliveries.retry(actor, id(it.groupValues[1])) }
        fail(404, "Действие не найдено.")
    }
}
