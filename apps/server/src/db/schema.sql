PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo_path TEXT NOT NULL UNIQUE,
  worktree_base_path TEXT NOT NULL,
  main_branch TEXT NOT NULL DEFAULT 'main',
  setup_script TEXT,
  dev_server_script TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS worktrees (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  display_name TEXT,
  path TEXT NOT NULL UNIQUE,
  branch TEXT,
  head TEXT,
  is_main INTEGER NOT NULL DEFAULT 0,
  is_dirty INTEGER NOT NULL DEFAULT 0,
  is_archived INTEGER NOT NULL DEFAULT 0,
  created_by_app INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS terminal_sessions (
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
);

