package coordination

enum class Role(val code: String) {
    ADMIN("admin"), ORGANIZER("organizer"), MANAGER("manager"), VOLUNTEER("volunteer");

    companion object {
        fun fromCode(value: Any?): Role? = entries.firstOrNull { it.code == value }
    }
}

data class MemberProfile(
    val name: String,
    val login: String?,
    val roles: Set<Role>,
    val tagIds: List<Long>,
    val homeHallId: Long?,
    val managerId: Long?,
    val active: Boolean,
) {
    val hasWebAccess: Boolean get() = roles.any { it != Role.VOLUNTEER }
}

data class Member(
    val id: Long,
    val profile: MemberProfile,
    val available: Boolean,
    val telegramId: Long?,
    val chatId: Long?,
    val createdAt: String,
) {
    val isAdmin: Boolean get() = Role.ADMIN in profile.roles
    val isManager: Boolean get() = Role.MANAGER in profile.roles
    val isVolunteer: Boolean get() = Role.VOLUNTEER in profile.roles

    fun response(privateFields: Boolean = true): Data {
        val fields = mapOf(
            "id" to id, "name" to profile.name, "roles" to profile.roles.map(Role::code),
            "tagIds" to profile.tagIds, "homeHallId" to profile.homeHallId, "managerId" to profile.managerId,
            "active" to profile.active, "available" to available, "createdAt" to createdAt,
        )
        return if (privateFields) fields + mapOf(
            "login" to profile.login, "telegramId" to telegramId, "chatId" to chatId,
        ) else fields
    }
}

internal class Members(private val db: Database) {
    private val columns = """
        id,name,login,roles,tag_ids,home_hall_id,manager_id,active,available,telegram_id,chat_id,created_at
    """.trim()

    fun require(id: Long): Member = find(id) ?: fail(404, "Пользователь не найден.")

    fun find(id: Long): Member? = db.one("SELECT $columns FROM users WHERE id=?", id)?.let(::member)

    fun roster(): List<Member> = db.all("SELECT $columns FROM users ORDER BY name").map(::member)

    fun activeVolunteers(managerId: Long?): List<Member> {
        val rows = if (managerId == null) {
            db.all("SELECT $columns FROM users WHERE active=1 ORDER BY name")
        } else {
            db.all("SELECT $columns FROM users WHERE active=1 AND manager_id=? ORDER BY name", managerId)
        }
        return rows.map(::member).filter(Member::isVolunteer)
    }

    fun passwordHash(id: Long): String? = db.one("SELECT password_hash FROM users WHERE id=?", id)?.get("password_hash") as? String

    fun loginInUse(login: String, excluding: Long?): Boolean =
        db.one("SELECT 1 FROM users WHERE login=? AND id!=?", login, excluding ?: 0) != null

    fun insert(profile: MemberProfile, hash: String?): Long = db.insert(
        """INSERT INTO users(name,login,roles,tag_ids,home_hall_id,manager_id,active,password_hash)
            VALUES (?,?,?,?,?,?,?,?)""",
        *profile.values(), hash,
    )

    fun update(id: Long, profile: MemberProfile, hash: String?) {
        db.execute(
            """UPDATE users SET name=?,login=?,roles=?,tag_ids=?,home_hall_id=?,manager_id=?,active=?,password_hash=?
                WHERE id=?""",
            *profile.values(), hash, id,
        )
    }

    private fun MemberProfile.values(): Array<Any?> = arrayOf(
        name, login, json(roles.map(Role::code)), json(tagIds), homeHallId, managerId, if (active) 1 else 0,
    )

    private fun member(row: Data): Member = Member(
        id = row.requiredLong("id"),
        profile = MemberProfile(
            name = row.string("name"),
            login = row["login"] as? String,
            roles = row.jsonList("roles").mapNotNull(Role::fromCode).toSet(),
            tagIds = row.jsonList("tag_ids").mapNotNull { it.exactLongOrNull() },
            homeHallId = row.longOrNull("home_hall_id"),
            managerId = row.longOrNull("manager_id"),
            active = row.enabled("active"),
        ),
        available = row.enabled("available"),
        telegramId = row.longOrNull("telegram_id"),
        chatId = row.longOrNull("chat_id"),
        createdAt = row.string("created_at"),
    )
}
