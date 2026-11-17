package coordination

internal class EventSettings(private val domain: Domain) {
    private val db = domain.db

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
}
