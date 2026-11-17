package coordination

internal class DeliveryQueue(private val domain: Domain) {
    private val db = domain.db

    fun list(actor: Long): Data {
        val user = domain.manager(actor)
        return mapOf("deliveries" to db.all("""SELECT o.id,o.user_id AS userId,u.name AS userName,o.task_id AS taskId,
            o.kind,o.status,o.attempts,o.last_error AS error,o.created_at AS createdAt FROM outbox o JOIN users u ON u.id=o.user_id
            WHERE o.status!='sent' AND (?=1 OR u.manager_id=?) ORDER BY o.id DESC LIMIT 200""",
            if (user.isAdmin) 1 else 0, actor))
    }

    fun retry(actor: Long, id: Long): Data = db.transaction {
        val user = domain.manager(actor)
        val row = db.one("SELECT * FROM outbox WHERE id=?", id) ?: fail(404, "Отправка не найдена.")
        if (!user.isAdmin && row.longOrNull("user_id")?.let { domain.user(it).profile.managerId } != actor) fail(403, "Отправка чужому пулу недоступна.")
        if (row.string("status") == "sent") fail(409, "Сообщение уже доставлено.")
        db.execute("UPDATE outbox SET status='pending',next_attempt=0,last_error=NULL WHERE id=?", id)
        mapOf("ok" to true)
    }
}
