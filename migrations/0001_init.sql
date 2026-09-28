-- DGA Cloudflare fork — initial schema (0001).
-- Every tracker table is scoped by user_id; auth tables (users, sessions,
-- invites) are new for the multi-user fork. No seed data.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  coach_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  coach_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);

CREATE TABLE entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE training_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  session_date TEXT NOT NULL,
  session_type TEXT NOT NULL,
  custom_activity TEXT NOT NULL DEFAULT '',
  arrows INTEGER NOT NULL DEFAULT 0,
  duration_minutes INTEGER NOT NULL DEFAULT 0,
  focus TEXT NOT NULL DEFAULT '',
  score TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE program_state (
  user_id TEXT PRIMARY KEY,
  current_poundage INTEGER NOT NULL,
  current_cycle INTEGER NOT NULL,
  current_week INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE cycle_week_plans (
  user_id TEXT NOT NULL,
  week_number INTEGER NOT NULL,
  primary_focus TEXT NOT NULL,
  background_focus_one TEXT NOT NULL DEFAULT '',
  background_focus_two TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, week_number)
);

CREATE TABLE planned_session_overrides (
  user_id TEXT NOT NULL,
  day_key TEXT NOT NULL,
  session_type TEXT NOT NULL,
  detail TEXT NOT NULL,
  prescription TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, day_key)
);

CREATE TABLE planned_session_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  day_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  blob_key TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE milestone_checks (
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  checked INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE maintenance_checks (
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  checked INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE maintenance_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  section TEXT NOT NULL,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE inspiration_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  thought_text TEXT NOT NULL,
  video_title TEXT NOT NULL,
  video_url TEXT NOT NULL,
  recipe_name TEXT NOT NULL,
  recipe_summary TEXT NOT NULL,
  recipe_ingredients TEXT NOT NULL,
  recipe_instructions TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

CREATE TABLE weekly_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  week_start TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, week_start)
);

CREATE TABLE practice_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  score_date TEXT NOT NULL,
  total INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE practice_score_ends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  score_id INTEGER NOT NULL REFERENCES practice_scores(id) ON DELETE CASCADE,
  end_number INTEGER NOT NULL,
  arrow_1 INTEGER NOT NULL,
  arrow_2 INTEGER NOT NULL,
  arrow_3 INTEGER NOT NULL,
  end_total INTEGER NOT NULL
);

CREATE TABLE bow_setups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  poundage INTEGER NOT NULL,
  name TEXT NOT NULL,
  limb_riser TEXT NOT NULL DEFAULT '',
  tiller_bolts TEXT NOT NULL DEFAULT '',
  brace_height TEXT NOT NULL DEFAULT '',
  string_twists TEXT NOT NULL DEFAULT '',
  nocking_point TEXT NOT NULL DEFAULT '',
  center_shot TEXT NOT NULL DEFAULT '',
  plunger TEXT NOT NULL DEFAULT '',
  grip_notes TEXT NOT NULL DEFAULT '',
  stabilizer TEXT NOT NULL DEFAULT '',
  clicker_position TEXT NOT NULL DEFAULT '',
  bare_shaft TEXT NOT NULL DEFAULT '',
  walk_back TEXT NOT NULL DEFAULT '',
  arrows_in_use TEXT NOT NULL DEFAULT '',
  sight_marks_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);

-- Indexes on the per-user lookup columns used by every query.
-- The case-insensitive username index matches the app's case-insensitive
-- login/registration lookups, so "Alice" and "alice" can never both exist.
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_invites_coach ON invites(coach_id);
CREATE INDEX idx_entries_user ON entries(user_id);
CREATE INDEX idx_training_sessions_user ON training_sessions(user_id);
CREATE INDEX idx_cycle_week_plans_user ON cycle_week_plans(user_id);
CREATE INDEX idx_planned_session_overrides_user ON planned_session_overrides(user_id);
CREATE INDEX idx_planned_session_attachments_user ON planned_session_attachments(user_id);
CREATE INDEX idx_milestone_checks_user ON milestone_checks(user_id);
CREATE INDEX idx_maintenance_checks_user ON maintenance_checks(user_id);
CREATE INDEX idx_maintenance_items_user ON maintenance_items(user_id);
CREATE INDEX idx_inspiration_entries_user ON inspiration_entries(user_id);
CREATE INDEX idx_weekly_notes_user ON weekly_notes(user_id);
CREATE INDEX idx_practice_scores_user ON practice_scores(user_id);
CREATE INDEX idx_practice_score_ends_user ON practice_score_ends(user_id);
CREATE INDEX idx_practice_score_ends_score ON practice_score_ends(score_id);
CREATE INDEX idx_bow_setups_user ON bow_setups(user_id);
CREATE UNIQUE INDEX users_username_ci_unique ON users(lower(username));
