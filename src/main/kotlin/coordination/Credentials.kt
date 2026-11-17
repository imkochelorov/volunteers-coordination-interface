package coordination

import org.bouncycastle.crypto.generators.SCrypt
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.HexFormat

private val secureRandom = SecureRandom()
private val hex = HexFormat.of()
fun randomBytes(length: Int): ByteArray = ByteArray(length).also(secureRandom::nextBytes)
fun randomHex(length: Int): String = hex.formatHex(randomBytes(length))
fun hashToken(value: String): String = hex.formatHex(MessageDigest.getInstance("SHA-256").digest(value.toByteArray()))
private fun scrypt(password: String, salt: String) =
    SCrypt.generate(password.toByteArray(), salt.toByteArray(), 16384, 8, 1, 64)

fun hashPassword(value: Any?): String {
    if (value !is String || value.length !in 12..256) fail(400, "Пароль должен содержать от 12 до 256 символов.")
    val salt = randomHex(16)
    return "$salt:${hex.formatHex(scrypt(value, salt))}"
}

fun verifyPassword(value: Any?, stored: String): Boolean {
    if (value !is String || value.length > 256) return false
    val salt = stored.substringBefore(':')
    val digest = stored.substringAfter(':', "")
    return salt.isNotEmpty() && digest.matches(Regex("[a-f0-9]{128}")) &&
        MessageDigest.isEqual(scrypt(value, salt), hex.parseHex(digest))
}
