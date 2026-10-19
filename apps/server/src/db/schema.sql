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

CREATE TABLE IF NOT EXISTS weixin_bindings (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  display_name TEXT,
  active_project_id TEXT,
  active_worktree_id TEXT,
  active_agent_id TEXT NOT NULL DEFAULT 'codex',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account_id, user_id),
  FOREIGN KEY (active_project_id) REFERENCES projects(id) ON DELETE SET NULL,
  FOREIGN KEY (active_worktree_id) REFERENCES worktrees(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS weixin_state (
  account_id TEXT PRIMARY KEY,
  cursor INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  executable TEXT NOT NULL,
  config_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coding_sessions (
  id TEXT PRIMARY KEY,
  binding_id TEXT NOT NULL,
  worktree_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  provider_session_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(binding_id, worktree_id, agent_id),
  FOREIGN KEY (binding_id) REFERENCES weixin_bindings(id) ON DELETE CASCADE,
  FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS coding_tasks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  source_message_seq INTEGER,
  prompt TEXT NOT NULL,
  image_paths_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  summary TEXT,
  detail TEXT,
  error TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES coding_sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS weixin_task_interactions (
  id TEXT PRIMARY KEY,
  binding_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  worktree_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  agent_interaction_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  answer TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  FOREIGN KEY (binding_id) REFERENCES weixin_bindings(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES coding_tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS weixin_pending_interactions (
  binding_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (binding_id) REFERENCES weixin_bindings(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS weixin_processed_messages (
  account_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  processed_at TEXT NOT NULL,
  PRIMARY KEY (account_id, seq)
);

CREATE TABLE IF NOT EXISTS weixin_outbox (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
