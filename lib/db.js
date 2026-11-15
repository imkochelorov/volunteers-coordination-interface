import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(path = 'data/coordination.sqlite') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    const version=db.prepare('PRAGMA user_version').get().user_version;
    if(version>2)throw new Error('Версия базы данных новее поддерживаемой. Обновите приложение.');
    db.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK(kind IN ('hall','direction')));
      CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, login TEXT UNIQUE, password_hash TEXT, roles TEXT NOT NULL DEFAULT '[]', tag_ids TEXT NOT NULL DEFAULT '[]', home_hall_id INTEGER REFERENCES tags(id), manager_id INTEGER REFERENCES users(id), available INTEGER NOT NULL DEFAULT 1, telegram_id INTEGER UNIQUE, chat_id INTEGER, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_groups (id INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, author_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL REFERENCES task_groups(id), title TEXT NOT NULL, description TEXT NOT NULL, author_id INTEGER NOT NULL REFERENCES users(id), hall_id INTEGER REFERENCES tags(id), tag_ids TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL CHECK(status IN ('queued','in_progress','done','cancelled')), claimed_by INTEGER REFERENCES users(id), assigned_by INTEGER REFERENCES users(id), generation INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, CHECK(claimed_by IS NULL OR assigned_by IS NULL));
      CREATE TABLE IF NOT EXISTS assignments (task_id INTEGER NOT NULL REFERENCES tasks(id), volunteer_id INTEGER NOT NULL REFERENCES users(id), accepted_at TEXT, PRIMARY KEY(task_id,volunteer_id));
      CREATE TABLE IF NOT EXISTS personal_tags (id INTEGER PRIMARY KEY, manager_id INTEGER NOT NULL REFERENCES users(id), name TEXT NOT NULL, UNIQUE(manager_id,name));
      CREATE TABLE IF NOT EXISTS volunteer_personal_tags (volunteer_id INTEGER NOT NULL REFERENCES users(id), personal_tag_id INTEGER NOT NULL REFERENCES personal_tags(id), PRIMARY KEY(volunteer_id,personal_tag_id));
      CREATE TABLE IF NOT EXISTS questions (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id), asked_by INTEGER NOT NULL REFERENCES users(id), controller_id INTEGER NOT NULL REFERENCES users(id), source TEXT NOT NULL CHECK(source IN ('web','volunteer')), forwarded INTEGER NOT NULL DEFAULT 0, tag_ids TEXT NOT NULL DEFAULT '[]', blocking INTEGER NOT NULL DEFAULT 0, urgency TEXT NOT NULL DEFAULT 'normal' CHECK(urgency IN ('normal','urgent')), state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','answered','closed')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS question_messages (id INTEGER PRIMARY KEY, question_id INTEGER NOT NULL REFERENCES questions(id), author_id INTEGER NOT NULL REFERENCES users(id), body TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), question_id INTEGER REFERENCES questions(id), event_key TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(user_id,event_key));
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id), actor_id INTEGER NOT NULL REFERENCES users(id), event TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY, actor_id INTEGER REFERENCES users(id), entity_type TEXT NOT NULL, entity_id TEXT, event TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_updates (update_id INTEGER PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_callbacks (callback_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_state (user_id INTEGER PRIMARY KEY REFERENCES users(id), task_id INTEGER, generation INTEGER);
      CREATE TABLE IF NOT EXISTS link_tokens (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL, used_at INTEGER);
      CREATE TABLE IF NOT EXISTS telegram_messages (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id), user_id INTEGER NOT NULL REFERENCES users(id), generation INTEGER NOT NULL, message_id INTEGER NOT NULL, UNIQUE(task_id,user_id,generation));
      CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY, event_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, user_id INTEGER REFERENCES users(id), task_id INTEGER REFERENCES tasks(id), payload TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT);
      CREATE INDEX IF NOT EXISTS activity_entity ON activity(entity_type,entity_id,id);
      CREATE INDEX IF NOT EXISTS assignments_volunteer ON assignments(volunteer_id);
      CREATE INDEX IF NOT EXISTS tasks_hall_status ON tasks(hall_id,status);
      CREATE INDEX IF NOT EXISTS questions_task_state ON questions(task_id,state);
      CREATE INDEX IF NOT EXISTS outbox_due ON outbox(status,next_attempt);
      CREATE INDEX IF NOT EXISTS outbox_task_pending ON outbox(task_id,user_id,status) WHERE kind='task' AND status IN ('pending','failed');
      CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id,id);
      PRAGMA user_version = 2;
    `);
    const insertTag = db.prepare('INSERT OR IGNORE INTO tags(name,kind) VALUES (?,?)');
    if (db.prepare('SELECT COUNT(*) AS count FROM tags').get().count === 0) for (const name of ['TC','TC Assistant','Press','Ceremony','Registration','Baloons','Live','Hall 1','Hall 2','Hall 3','Hall 4','Hall 5','Space']) insertTag.run(name, name.startsWith('Hall ') ? 'hall' : 'direction');
    db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES ('crossHall','false')").run();
    db.exec('COMMIT');
    return db;
  } catch(error) {
    if(db.isTransaction)db.exec('ROLLBACK');
    db.close();
    throw error;
  }
}
