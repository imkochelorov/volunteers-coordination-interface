package coordination

private val requestKeyPattern = Regex("[a-zA-Z0-9_-]{1,100}")

internal class RequestKeys(private val db: Database) {
    fun parse(raw: String?): String? {
        val key = raw?.takeIf(String::isNotEmpty) ?: return null
        if (!requestKeyPattern.matches(key)) fail(400, "Некорректный ключ запроса.")
        return key
    }

    fun apply(actor: Long, key: String?, path: String, input: Data, action: () -> Data): Data = db.transaction {
        if (key == null) return@transaction action()
        val fingerprint = hashToken("$path:${json(input)}")
        val row = db.one("SELECT fingerprint,response FROM request_keys WHERE user_id=? AND request_key=?", actor, key)
        if (row != null) {
            if (row.string("fingerprint") != fingerprint) fail(409, "Ключ запроса уже использован для другого действия.")
            return@transaction decode(row.string("response")).objectOrEmpty()
        }
        val response = action()
        db.execute(
            "INSERT INTO request_keys(user_id,request_key,fingerprint,response,created_at) VALUES(?,?,?,?,?)",
            actor, key, fingerprint, json(response), milliseconds(),
        )
        response
    }
}
