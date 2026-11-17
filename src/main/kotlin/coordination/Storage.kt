package coordination

import java.io.Closeable
import java.nio.file.Files
import java.nio.file.Path
import java.sql.Connection
import java.sql.DriverManager

class Database(path: String) : Closeable {
    private val connection: Connection = open(path)
    private var transactionDepth = 0

    init {
        try {
            val schema = checkNotNull(javaClass.getResource("/schema.sql")).readText()
            schema.split(';').map(String::trim).filter(String::isNotEmpty).forEach(::statement)
            initializeData()
        } catch (error: Throwable) {
            runCatching { connection.close() }.onFailure(error::addSuppressed)
            throw error
        }
    }

    private fun open(path: String): Connection {
        if (path != ":memory:") Files.createDirectories(Path.of(path).toAbsolutePath().parent)
        return DriverManager.getConnection("jdbc:sqlite:$path")
    }

    private fun initializeData() {
        transaction {
            if (one("SELECT 1 FROM pragma_table_info('tags') WHERE name='color'") == null) {
                execute("ALTER TABLE tags ADD COLUMN color TEXT NOT NULL DEFAULT ''")
            }
            if (one("SELECT 1 FROM pragma_table_info('tasks') WHERE name='priority'") == null) {
                execute("ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'")
            }
            if (one("SELECT 1 FROM pragma_table_info('tasks') WHERE name='needs_strong_volunteers'") == null) {
                execute("ALTER TABLE tasks ADD COLUMN needs_strong_volunteers INTEGER NOT NULL DEFAULT 0")
            }
            if (one("SELECT 1 FROM pragma_table_info('tasks') WHERE name='volunteer_target'") == null) {
                execute("ALTER TABLE tasks ADD COLUMN volunteer_target TEXT NOT NULL DEFAULT ''")
            }
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

    /**
     * The single connection is shared by HTTP and the bot. Nested writes use savepoints
     * so a handled failure cannot commit partial changes from the failed operation.
     */
    @Synchronized
    fun <T> transaction(block: () -> T): T {
        val outermost = transactionDepth == 0
        val savepoint = "nested_$transactionDepth"
        statement(if (outermost) "BEGIN IMMEDIATE" else "SAVEPOINT $savepoint")
        transactionDepth++
        try {
            val result = block()
            statement(if (outermost) "COMMIT" else "RELEASE SAVEPOINT $savepoint")
            return result
        } catch (failure: Throwable) {
            runCatching {
                if (outermost) statement("ROLLBACK") else {
                    statement("ROLLBACK TO SAVEPOINT $savepoint")
                    statement("RELEASE SAVEPOINT $savepoint")
                }
            }.onFailure(failure::addSuppressed)
            throw failure
        } finally {
            transactionDepth--
        }
    }

    private fun statement(sql: String) {
        connection.createStatement().use { it.execute(sql) }
    }

    @Synchronized
    fun all(sql: String, vararg args: Any?): List<Data> = connection.prepareStatement(sql).use { statement ->
        args.forEachIndexed { index, value -> statement.setObject(index + 1, value) }
        statement.executeQuery().use { rows ->
            val metadata = rows.metaData
            val fields = (1..metadata.columnCount).associateWith(metadata::getColumnLabel)
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
