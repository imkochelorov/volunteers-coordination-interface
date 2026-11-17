package coordination

class Accounts(private val domain: Domain) {
    private val db = domain.db

    fun save(actor: Long, input: Data, session: Data): Data = db.transaction {
        domain.administrator(actor)
        val old = input["id"]?.let { domain.user(id(it)) }
        val oldId = old?.longOrNull("id")
        val name = text(input["name"] ?: old?.get("name"), "Имя", 200)
        val login = if ("login" !in input) old?.get("login") else input["login"]?.takeUnless { it == "" }?.let { text(it, "Логин", 100) }
        val roles = (input["roles"] ?: old?.get("roles")).listOrEmpty().distinct()
        if (roles.isEmpty() || roles.any { it !in listOf("admin", "organizer", "manager", "volunteer") }) fail(400, "Выберите корректные роли.")
        val web = mapOf("roles" to roles).web()
        if (web && login == null) fail(400, "Для веб-доступа нужен логин.")
        val tags = domain.validateTags(input["tagIds"] ?: old?.get("tagIds"))
        val hall = if ("homeHallId" in input) input["homeHallId"]?.let(::id) else old?.longOrNull("homeHallId")
        val manager = if ("managerId" in input) input["managerId"]?.let(::id) else old?.longOrNull("managerId")
        val active = if ("active" in input) input.enabled("active") else old?.enabled("active") ?: true
        if (hall != null && domain.tags().none { it.longOrNull("id") == hall && it.string("kind") == "hall" }) {
            fail(400, "Домашний холл должен быть тегом холла.")
        }
        if (manager != null) {
            val pool = domain.user(manager)
            if (!pool.hasRole("manager") || !pool.enabled("active") || oldId == manager) fail(400, "Выберите активного менеджера пула.")
            if ("volunteer" !in roles) fail(400, "Пул назначается волонтёру.")
        }
        if (oldId == actor && (!active || "admin" !in roles)) fail(409, "Нельзя отключить собственный административный доступ.")
        if (login != null && db.one("SELECT id FROM users WHERE login=? AND id!=?", login, oldId ?: 0) != null) fail(409, "Логин уже занят.")
        val hash = input["password"]?.takeUnless { it == "" }?.let(::hashPassword)
        val existingHash = db.one("SELECT password_hash FROM users WHERE id=?", oldId)?.string("password_hash").orEmpty()
        if (web && hash == null && existingHash.isEmpty()) fail(400, "Для веб-доступа задайте пароль от 12 символов.")
        val fields = arrayOf(name, login, json(roles), json(tags), hall, manager, if (active) 1 else 0, hash ?: existingHash.ifEmpty { null })
        if (old == null || oldId == null) return@transaction domain.user(db.insert(
            "INSERT INTO users(name,login,roles,tag_ids,home_hall_id,manager_id,active,password_hash) VALUES (?,?,?,?,?,?,?,?)", *fields))
        if (old.longOrNull("managerId") != manager || old.enabled("active") != active || old.list("roles") != roles) {
            db.execute("DELETE FROM link_tokens WHERE user_id=? AND used_at IS NULL", oldId)
        }
        if (old.longOrNull("managerId") != manager) db.execute("DELETE FROM volunteer_personal_tags WHERE volunteer_id=?", oldId)
        db.execute("UPDATE users SET name=?,login=?,roles=?,tag_ids=?,home_hall_id=?,manager_id=?,active=?,password_hash=? WHERE id=?", *fields, oldId)
        if (!active || hash != null) db.execute("DELETE FROM sessions WHERE user_id=?", oldId)
        else db.execute("DELETE FROM sessions WHERE user_id=? AND token_hash!=?", oldId, session["token_hash"])
        domain.user(oldId)
    }

    fun tag(actor: Long, input: Data): Data = db.transaction {
        domain.administrator(actor)
        val name = text(input["name"], "Название тега", 80)
        val kind = input.string("kind")
        if (kind !in listOf("hall", "direction")) fail(400, "Выберите тип тега.")
        val old = input["id"]?.let { db.one("SELECT * FROM tags WHERE id=?", id(it)) ?: fail(404, "Тег не найден.") }
        if (old != null && old.string("kind") != kind) fail(409, "Тип существующего тега изменить нельзя. Создайте другой тег.")
        if (db.one("SELECT id FROM tags WHERE name=? AND id!=?", name, old?.longOrNull("id") ?: 0) != null) fail(409, "Такой тег уже существует.")
        val color = if ("color" in input) {
            val selected = input["color"] as? String ?: fail(400, "Укажите цвет тега.")
            if (selected.isNotEmpty() && !Regex("#[0-9a-fA-F]{6}").matches(selected)) fail(400, "Некорректный цвет тега.")
            selected.lowercase()
        } else old?.string("color").orEmpty()
        val tagId = old?.requiredLong("id") ?: db.insert("INSERT INTO tags(name,kind,color) VALUES (?,?,?)", name, kind, color)
        if (old != null) db.execute("UPDATE tags SET name=?,color=? WHERE id=?", name, color, tagId)
        checkNotNull(db.one("SELECT id,name,kind,color FROM tags WHERE id=?", tagId))
    }

    fun settings(actor: Long, input: Data): Data {
        domain.administrator(actor)
        val crossHall = input["crossHall"] as? Boolean ?: fail(400, "Укажите значение флага работы с другими холлами.")
        db.execute("UPDATE settings SET value=? WHERE key='crossHall'", json(crossHall))
        return domain.settings()
    }

    fun deliveries(actor: Long): Data {
        val user = domain.manager(actor)
        return mapOf("deliveries" to db.all("""SELECT o.id,o.user_id AS userId,u.name AS userName,o.task_id AS taskId,
            o.kind,o.status,o.attempts,o.last_error AS error,o.created_at AS createdAt FROM outbox o JOIN users u ON u.id=o.user_id
            WHERE o.status!='sent' AND (?=1 OR u.manager_id=?) ORDER BY o.id DESC LIMIT 200""",
            if (user.hasRole("admin")) 1 else 0, actor))
    }

    fun retry(actor: Long, id: Long): Data = db.transaction {
        val user = domain.manager(actor)
        val row = db.one("SELECT * FROM outbox WHERE id=?", id) ?: fail(404, "Отправка не найдена.")
        if (!user.hasRole("admin") && row.longOrNull("user_id")?.let { domain.user(it).longOrNull("managerId") } != actor) fail(403, "Отправка чужому пулу недоступна.")
        if (row.string("status") == "sent") fail(409, "Сообщение уже доставлено.")
        db.execute("UPDATE outbox SET status='pending',next_attempt=0,last_error=NULL WHERE id=?", id)
        mapOf("ok" to true)
    }
}
