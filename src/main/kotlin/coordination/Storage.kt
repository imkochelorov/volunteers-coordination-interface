package coordination

import java.io.Closeable
import java.nio.file.Files
import java.nio.file.Path
import java.sql.Connection
import java.sql.DriverManager

class Database(path: String) : Closeable {
    private val connection: Connection
    private var inTransaction = false

    init {
        if (path != ":memory:") Files.createDirectories(Path.of(path).toAbsolutePath().parent)
        connection = DriverManager.getConnection("jdbc:sqlite:$path")
        val schema = checkNotNull(javaClass.getResource("/schema.sql")).readText()
        schema.split(';').map(String::trim).filter(String::isNotEmpty).forEach { sql ->
            connection.createStatement().use { it.execute(sql) }
        }
        transaction {
            if (one("SELECT id FROM tags LIMIT 1") == null) {
                val names = listOf("TC", "TC Assistant", "Press", "Ceremony", "Registration", "Baloons", "Live",
                    "Hall 1", "Hall 2", "Hall 3", "Hall 4", "Hall 5", "Space")
                for (name in names) execute("INSERT INTO tags(name,kind) VALUES (?,?)",
                    name, if (name.startsWith("Hall ")) "hall" else "direction")
            }
            execute("INSERT OR IGNORE INTO settings(key,value) VALUES ('crossHall','false')")
        }
    }

    @Synchronized
    fun <T> access(block: () -> T): T = block()

    @Synchronized
    fun <T> transaction(block: () -> T): T {
        if (inTransaction) return block()
        connection.createStatement().use { it.execute("BEGIN IMMEDIATE") }
        inTransaction = true
        try {
            val result = block()
            connection.createStatement().use { it.execute("COMMIT") }
            return result
        } catch (failure: Throwable) {
            runCatching { connection.createStatement().use { it.execute("ROLLBACK") } }
            throw failure
        } finally {
            inTransaction = false
        }
    }

    @Synchronized
    fun all(sql: String, vararg args: Any?): List<Data> = connection.prepareStatement(sql).use { statement ->
        args.forEachIndexed { index, value -> statement.setObject(index + 1, value) }
        statement.executeQuery().use { rows ->
            val fields = (1..rows.metaData.columnCount).associateWith { rows.metaData.getColumnLabel(it) }
            buildList {
                while (rows.next()) add(fields.entries.associate { (column, label) ->
                    val value = rows.getObject(column)
                    label to if (value is Int) value.toLong() else value
                })
            }
        }
    }

    fun one(sql: String, vararg args: Any?): Data? = all(sql, *args).firstOrNull()

    @Synchronized
    fun execute(sql: String, vararg args: Any?): Int = connection.prepareStatement(sql).use { statement ->
        args.forEachIndexed { index, value -> statement.setObject(index + 1, value) }
        statement.executeUpdate()
    }

    @Synchronized
    fun insert(sql: String, vararg args: Any?): Long {
        execute(sql, *args)
        return checkNotNull(one("SELECT last_insert_rowid() AS id")).requiredLong("id")
    }

    override fun close() = access { connection.close() }
}
