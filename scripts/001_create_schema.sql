-- LunarAuth Database Schema
-- Migration from db.json to Supabase

-- Users table (application users, not auth users)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  email TEXT NOT NULL,
  password TEXT NOT NULL,
  role TEXT DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  secret_id TEXT UNIQUE,
  secret_last_used_at TIMESTAMPTZ,
  key_prefix TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Apps table
CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT DEFAULT 'on' CHECK (status IN ('on', 'off')),
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Keys table
CREATE TABLE IF NOT EXISTS keys (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name TEXT,
  duration_input TEXT,
  duration_ms BIGINT DEFAULT 0,
  remaining_ms BIGINT DEFAULT 0,
  paused BOOLEAN DEFAULT FALSE,
  hwid TEXT,
  first_used_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  last_tick_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

-- Resellers table (many-to-many relationship)
CREATE TABLE IF NOT EXISTS resellers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reseller_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(reseller_user_id, app_id)
);

-- Create indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_keys_app_id ON keys(app_id);
CREATE INDEX IF NOT EXISTS idx_keys_key ON keys(key);
CREATE INDEX IF NOT EXISTS idx_apps_owner ON apps(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_resellers_user ON resellers(reseller_user_id);
CREATE INDEX IF NOT EXISTS idx_resellers_app ON resellers(app_id);
CREATE INDEX IF NOT EXISTS idx_users_secret_id ON users(secret_id);
