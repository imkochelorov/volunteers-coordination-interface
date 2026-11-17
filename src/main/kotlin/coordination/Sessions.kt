package coordination

internal const val SESSION_DURATION_SECONDS = 43_200
private const val ATTEMPT_WINDOW_MS = 15 * 60 * 1000L
private const val MAX_ATTEMPTS = 5
private val dummyPasswordHash = "0".repeat(32) + ":" + "0".repeat(128)

internal data class Session(val userId: Long, val tokenHash: String, val csrf: String)
internal data class SignIn(val user: Member, val token: String, val csrf: String)

internal class Sessions(private val domain: Domain) {
    private val db = domain.db
    private var nextCleanup = 0L

    // Serialize attempts without holding SQLite's monitor during scrypt.
    @Synchronized
    fun login(address: String, input: Data): SignIn {
        val login = input.string("login").trim()
        val key = hashToken("$address:$login")
        val snapshot = db.access {
            checkAttempts(key, milliseconds())
            credentials(login)
        }
        val valid = verifyPassword(input["password"], snapshot?.hash ?: dummyPasswordHash)
        val opened = db.transaction {
            val now = milliseconds()
            checkAttempts(key, now)
            val current = credentials(login)
            val user = current?.let { domain.members.find(it.userId) }
            if (!valid || snapshot == null || snapshot != current || user == null ||
                !user.profile.active || !user.profile.hasWebAccess
            ) {
                recordFailedAttempt(key, now)
                return@transaction null
            }
            val token = randomHex(32)
            val csrf = randomHex(24)
            db.execute("DELETE FROM login_attempts WHERE key=?", key)
            db.execute(
                "INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(?,?,?,?)",
                hashToken(token), user.id, csrf, now + 1000L * SESSION_DURATION_SECONDS,
            )
            SignIn(user, token, csrf)
        }
        return opened ?: fail(401, "Неверный логин или пароль.")
    }

    private data class Credentials(val userId: Long, val hash: String)

    private fun credentials(login: String): Credentials? {
        if (login.length !in 1..100) return null
        return db.one("SELECT id,password_hash FROM users WHERE login=?", login)?.let { row ->
            val hash = row.string("password_hash")
            hash.takeIf(String::isNotEmpty)?.let { Credentials(row.requiredLong("id"), it) }
        }
    }

    private fun checkAttempts(key: String, now: Long) {
        val attempt = db.one("SELECT count,reset_at FROM login_attempts WHERE key=?", key) ?: return
        if (attempt.requiredLong("reset_at") > now && attempt.requiredLong("count") >= MAX_ATTEMPTS) {
            fail(429, "Слишком много попыток. Повторите через 15 минут.")
        }
    }

    private fun recordFailedAttempt(key: String, now: Long) {
        db.execute(
            """INSERT INTO login_attempts(key,count,reset_at) VALUES(?,1,?)
                ON CONFLICT(key) DO UPDATE SET
                    count=CASE WHEN reset_at<=? THEN 1 ELSE count+1 END,
                    reset_at=CASE WHEN reset_at<=? THEN excluded.reset_at ELSE reset_at END""",
            key, now + ATTEMPT_WINDOW_MS, now, now,
        )
    }

    fun authenticate(token: String?, verifyCsrf: Boolean, csrf: String?): Session {
        val tokenHash = token?.let(::hashToken) ?: signInRequired()
        val row = db.one("SELECT user_id,csrf FROM sessions WHERE token_hash=? AND expires_at>?", tokenHash, milliseconds())
            ?: signInRequired()
        val user = domain.members.find(row.requiredLong("user_id")) ?: signInRequired()
        if (!user.profile.active || !user.profile.hasWebAccess) signInRequired()
        val session = Session(user.id, tokenHash, row.string("csrf"))
        if (verifyCsrf && csrf != session.csrf) fail(403, "Обновите страницу: проверка безопасности не пройдена.")
        return session
    }

    private fun signInRequired(): Nothing = fail(401, "Войдите в приложение.")

    fun logout(session: Session) {
        db.execute("DELETE FROM sessions WHERE token_hash=?", session.tokenHash)
    }

    fun changePassword(session: Session, current: Any?, replacement: Any?) {
        val stored = domain.members.passwordHash(session.userId).orEmpty()
        if (!verifyPassword(current, stored)) fail(403, "Текущий пароль не подходит.")
        val hash = hashPassword(replacement)
        db.execute("UPDATE users SET password_hash=? WHERE id=?", hash, session.userId)
        db.execute("DELETE FROM sessions WHERE user_id=? AND token_hash!=?", session.userId, session.tokenHash)
    }

    fun cleanup() = db.access {
        val now = milliseconds()
        if (now < nextCleanup) return@access
        db.transaction {
            db.execute("DELETE FROM sessions WHERE expires_at<=?", now)
            db.execute("DELETE FROM login_attempts WHERE reset_at<=?", now)
            db.execute("DELETE FROM request_keys WHERE created_at<?", now - 7L * 86400000)
        }
        nextCleanup = now + 3600000
    }
}
