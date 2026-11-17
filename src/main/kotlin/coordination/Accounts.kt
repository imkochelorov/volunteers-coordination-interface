package coordination

internal class Accounts(private val domain: Domain) {
    private val db = domain.db
    private val members = domain.members

    fun save(actor: Long, input: Data, currentSessionHash: String): Member = db.transaction {
        domain.administrator(actor)
        val previous = input["id"]?.let { members.require(id(it)) }
        val edit = AccountEdit.parse(input, previous?.profile)
        domain.validateTags(edit.profile.tagIds)
        validateProfile(actor, previous, edit.profile)

        val passwordHash = edit.newPassword?.let(::hashPassword)
        val storedHash = passwordHash ?: previous?.id?.let(members::passwordHash)
        if (edit.profile.hasWebAccess && storedHash.isNullOrEmpty()) {
            fail(400, "Для веб-доступа задайте пароль от 12 символов.")
        }

        if (previous == null) {
            return@transaction members.require(members.insert(edit.profile, storedHash))
        }
        members.update(previous.id, edit.profile, storedHash)
        updateRelatedRecords(previous, edit.profile, passwordHash != null, currentSessionHash)
        members.require(previous.id)
    }

    private fun validateProfile(actor: Long, previous: Member?, profile: MemberProfile) {
        if (profile.hasWebAccess && profile.login == null) fail(400, "Для веб-доступа нужен логин.")
        if (profile.login != null && members.loginInUse(profile.login, previous?.id)) fail(409, "Логин уже занят.")
        if (profile.homeHallId != null && db.one("SELECT 1 FROM tags WHERE id=? AND kind='hall'", profile.homeHallId) == null) {
            fail(400, "Домашний холл должен быть тегом холла.")
        }
        profile.managerId?.let { managerId ->
            if (Role.VOLUNTEER !in profile.roles) fail(400, "Пул назначается волонтёру.")
            val manager = members.find(managerId)
            if (managerId == previous?.id || manager == null || !manager.profile.active || !manager.isManager) {
                fail(400, "Выберите активного менеджера пула.")
            }
        }
        if (previous?.id == actor && (!profile.active || Role.ADMIN !in profile.roles)) {
            fail(409, "Нельзя отключить собственный административный доступ.")
        }
        if (previous?.isManager == true && previous.profile.active && (!profile.active || Role.MANAGER !in profile.roles) &&
            members.activeVolunteers(previous.id).isNotEmpty()
        ) {
            fail(409, "Сначала переназначьте активных волонтёров этого менеджера.")
        }
    }

    private fun updateRelatedRecords(previous: Member, profile: MemberProfile, passwordChanged: Boolean, sessionHash: String) {
        val id = previous.id
        val poolChanged = previous.profile.managerId != profile.managerId
        val accessChanged = previous.profile.roles != profile.roles || previous.profile.active != profile.active
        if (poolChanged || accessChanged) {
            db.execute("DELETE FROM link_tokens WHERE user_id=? AND used_at IS NULL", id)
            db.execute("DELETE FROM telegram_state WHERE user_id=?", id)
        }
        if (poolChanged) db.execute("DELETE FROM volunteer_personal_tags WHERE volunteer_id=?", id)

        val webAccessRevoked = !profile.active || !profile.hasWebAccess
        val loginChanged = previous.profile.login != profile.login
        if (webAccessRevoked || passwordChanged || loginChanged) {
            db.execute("DELETE FROM sessions WHERE user_id=?", id)
        } else if (accessChanged) {
            db.execute("DELETE FROM sessions WHERE user_id=? AND token_hash!=?", id, sessionHash)
        }
        if (poolChanged || accessChanged || passwordChanged || loginChanged ||
            previous.profile.homeHallId != profile.homeHallId || previous.profile.tagIds != profile.tagIds
        ) {
            db.execute("DELETE FROM request_keys WHERE user_id=?", id)
        }
    }
}

private class AccountEdit(val profile: MemberProfile, val newPassword: String?) {
    companion object {
        fun parse(input: Data, previous: MemberProfile?): AccountEdit {
            val roles = if ("roles" in input) {
                val values = input["roles"] as? List<*> ?: fail(400, "Выберите корректные роли.")
                values.map { Role.fromCode(it) ?: fail(400, "Выберите корректные роли.") }.toSet()
            } else previous?.roles.orEmpty()
            if (roles.isEmpty()) fail(400, "Выберите корректные роли.")

            val password = when (val value = input["password"]) {
                null, "" -> null
                is String -> value
                else -> fail(400, "Укажите пароль текстом.")
            }
            return AccountEdit(
                MemberProfile(
                    name = text(input["name"] ?: previous?.name, "Имя", 200),
                    login = if ("login" in input) input["login"]?.takeUnless { it == "" }?.let { text(it, "Логин", 100) }
                        else previous?.login,
                    roles = roles,
                    tagIds = ids(input["tagIds"] ?: previous?.tagIds),
                    homeHallId = input.idOrPrevious("homeHallId", previous?.homeHallId),
                    managerId = input.idOrPrevious("managerId", previous?.managerId),
                    active = input.booleanOrDefault("active", previous?.active ?: true),
                ),
                password,
            )
        }
    }
}

private fun Data.idOrPrevious(key: String, previous: Long?): Long? =
    if (key in this) this[key]?.let(::id) else previous
