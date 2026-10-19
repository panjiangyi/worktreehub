import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

type TableInfoRow = {
  name: string
  notnull: number
}

function getColumnInfo(db: Database.Database, table: string): TableInfoRow[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as TableInfoRow[]
}

function getColumnNames(db: Database.Database, table: string): Set<string> {
  return new Set(getColumnInfo(db, table).map((c) => c.name))
}

function ensureIndexes(db: Database.Database): void {
  db.exec('CREATE INDEX IF NOT EXISTS idx_worktrees_project_id ON worktrees(project_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_terminal_sessions_worktree_id ON terminal_sessions(worktree_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_terminal_sessions_scope_id ON terminal_sessions(scope_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_terminal_sessions_status ON terminal_sessions(status)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_coding_tasks_status ON coding_tasks(status)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_coding_tasks_session ON coding_tasks(session_id, created_at)')
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_coding_tasks_source_message
    ON coding_tasks(session_id, source_message_seq) WHERE source_message_seq IS NOT NULL`)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_weixin_task_interactions_pending
    ON weixin_task_interactions(task_id) WHERE status='pending'`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_weixin_task_interactions_binding ON weixin_task_interactions(binding_id, status, created_at)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_weixin_outbox_pending ON weixin_outbox(status, next_attempt_at)')
}

function migrateTerminalSessionsToScopedModel(db: Database.Database): void {
  const terminalCols = getColumnInfo(db, 'terminal_sessions')
  if (terminalCols.length === 0) return

  const terminalColNames = new Set(terminalCols.map((c) => c.name))
  const projectIdCol = terminalCols.find((col) => col.name === 'project_id')
  const worktreeIdCol = terminalCols.find((col) => col.name === 'worktree_id')
  const needsRebuild =
    !terminalColNames.has('scope_type') ||
    !terminalColNames.has('scope_id') ||
    !terminalColNames.has('scope_label') ||
    projectIdCol?.notnull === 1 ||
    worktreeIdCol?.notnull === 1

  if (!needsRebuild) return

  db.exec('BEGIN')
  try {
    db.exec(`
      CREATE TABLE terminal_sessions_v2 (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        worktree_id TEXT,
        scope_type TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        scope_label TEXT NOT NULL,
        title TEXT NOT NULL,
        shell TEXT NOT NULL,
        cwd TEXT NOT NULL,
        status TEXT NOT NULL,
        pid INTEGER,
        cols INTEGER NOT NULL DEFAULT 120,
        rows INTEGER NOT NULL DEFAULT 30,
        exit_code INTEGER,
        last_active_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE
      )
    `)

    db.exec(`
      INSERT INTO terminal_sessions_v2 (
        id,
        project_id,
        worktree_id,
        scope_type,
        scope_id,
        scope_label,
        title,
        shell,
        cwd,
        status,
        pid,
        cols,
        rows,
        exit_code,
        last_active_at,
        created_at,
        updated_at
      )
      SELECT
        id,
        project_id,
        worktree_id,
        'worktree',
        worktree_id,
        title,
        title,
        shell,
        cwd,
        status,
        pid,
        cols,
        rows,
        exit_code,
        last_active_at,
        created_at,
        updated_at
      FROM terminal_sessions
    `)

    db.exec('DROP TABLE terminal_sessions')
    db.exec('ALTER TABLE terminal_sessions_v2 RENAME TO terminal_sessions')
    db.exec('CREATE INDEX idx_terminal_sessions_worktree_id ON terminal_sessions(worktree_id)')
    db.exec('CREATE INDEX idx_terminal_sessions_scope_id ON terminal_sessions(scope_id)')
    db.exec('CREATE INDEX idx_terminal_sessions_status ON terminal_sessions(status)')
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function migrateDefaultWorktreeBasePaths(db: Database.Database): void {
  const projects = db
    .prepare('SELECT id, name, worktree_base_path FROM projects')
    .all() as Array<{ id: string; name: string; worktree_base_path: string }>

  const oldBaseDir = path.join(os.homedir(), '.worktree')
  const newBaseDir = path.join(os.homedir(), '.worktrees')
  const updateStmt = db.prepare(
    'UPDATE projects SET worktree_base_path = ?, updated_at = ? WHERE id = ?'
  )
  const now = new Date().toISOString()

  db.exec('BEGIN')
  try {
    for (const project of projects) {
      const legacyBasePath = path.join(oldBaseDir, project.name)
      if (project.worktree_base_path !== legacyBasePath) continue

      updateStmt.run(path.join(newBaseDir, project.name), now, project.id)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function runMigrations(db: Database.Database): void {
  const projectCols = getColumnNames(db, 'projects')
  if (!projectCols.has('main_branch')) {
    db.exec("ALTER TABLE projects ADD COLUMN main_branch TEXT NOT NULL DEFAULT 'main'")
  }
  if (!projectCols.has('setup_script')) {
    db.exec('ALTER TABLE projects ADD COLUMN setup_script TEXT')
  }
  if (!projectCols.has('dev_server_script')) {
    db.exec('ALTER TABLE projects ADD COLUMN dev_server_script TEXT')
  }

  const worktreeCols = getColumnNames(db, 'worktrees')
  if (!worktreeCols.has('display_name')) {
    db.exec('ALTER TABLE worktrees ADD COLUMN display_name TEXT')
  }
  if (!worktreeCols.has('is_archived')) {
    db.exec('ALTER TABLE worktrees ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0')
  }

  const codingTaskCols = getColumnNames(db, 'coding_tasks')
  if (!codingTaskCols.has('image_paths_json')) {
    db.exec("ALTER TABLE coding_tasks ADD COLUMN image_paths_json TEXT NOT NULL DEFAULT '[]'")
  }

  migrateTerminalSessionsToScopedModel(db)
  migrateDefaultWorktreeBasePaths(db)
}

export function createDatabase(databasePath: string): Database.Database {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true })

  const db = new Database(databasePath)
  db.pragma('foreign_keys = ON')

  const schema = fs.readFileSync(
    new URL('./schema.sql', import.meta.url),
    'utf8'
  )

  db.exec(schema)
  runMigrations(db)
  ensureIndexes(db)

  return db
}
