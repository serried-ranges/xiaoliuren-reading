-- Run once against the remote D1 database before deploying the Pages Function.
-- The triggers make quota limits part of the database transaction, so concurrent
-- Pages Function requests cannot race past user, IP, or global caps.

CREATE TABLE IF NOT EXISTS quota_counters (
  day_key TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN (
    'user', 'ip', 'global', 'redeem_user', 'redeem_ip', 'failed_ip'
  )),
  subject_key TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
  bonus INTEGER NOT NULL DEFAULT 0 CHECK (bonus >= 0),
  base_limit INTEGER NOT NULL CHECK (base_limit >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day_key, scope, subject_key)
);

CREATE TRIGGER IF NOT EXISTS quota_user_limit_insert
BEFORE INSERT ON quota_counters
WHEN NEW.scope = 'user' AND NEW.used > NEW.base_limit + NEW.bonus
BEGIN SELECT RAISE(ABORT, 'quota_user_limit'); END;

CREATE TRIGGER IF NOT EXISTS quota_user_limit_update
BEFORE UPDATE ON quota_counters
WHEN NEW.scope = 'user' AND NEW.used > NEW.base_limit + NEW.bonus
BEGIN SELECT RAISE(ABORT, 'quota_user_limit'); END;

CREATE TRIGGER IF NOT EXISTS quota_ip_limit_insert
BEFORE INSERT ON quota_counters
WHEN NEW.scope = 'ip' AND NEW.used > NEW.base_limit + NEW.bonus
BEGIN SELECT RAISE(ABORT, 'quota_ip_limit'); END;

CREATE TRIGGER IF NOT EXISTS quota_ip_limit_update
BEFORE UPDATE ON quota_counters
WHEN NEW.scope = 'ip' AND NEW.used > NEW.base_limit + NEW.bonus
BEGIN SELECT RAISE(ABORT, 'quota_ip_limit'); END;

CREATE TRIGGER IF NOT EXISTS quota_global_limit_insert
BEFORE INSERT ON quota_counters
WHEN NEW.scope = 'global' AND NEW.used > NEW.base_limit
BEGIN SELECT RAISE(ABORT, 'quota_global_limit'); END;

CREATE TRIGGER IF NOT EXISTS quota_global_limit_update
BEFORE UPDATE ON quota_counters
WHEN NEW.scope = 'global' AND NEW.used > NEW.base_limit
BEGIN SELECT RAISE(ABORT, 'quota_global_limit'); END;

CREATE TRIGGER IF NOT EXISTS quota_test_redemption_limit_insert
BEFORE INSERT ON quota_counters
WHEN NEW.scope IN ('redeem_user', 'redeem_ip') AND NEW.used > NEW.base_limit
BEGIN SELECT RAISE(ABORT, 'test_quota_daily_limit'); END;

CREATE TRIGGER IF NOT EXISTS quota_test_redemption_limit_update
BEFORE UPDATE ON quota_counters
WHEN NEW.scope IN ('redeem_user', 'redeem_ip') AND NEW.used > NEW.base_limit
BEGIN SELECT RAISE(ABORT, 'test_quota_daily_limit'); END;

CREATE TRIGGER IF NOT EXISTS quota_test_code_lock_insert
BEFORE INSERT ON quota_counters
WHEN NEW.scope = 'failed_ip' AND NEW.used > NEW.base_limit
BEGIN SELECT RAISE(ABORT, 'test_code_locked'); END;

CREATE TRIGGER IF NOT EXISTS quota_test_code_lock_update
BEFORE UPDATE ON quota_counters
WHEN NEW.scope = 'failed_ip' AND NEW.used > NEW.base_limit
BEGIN SELECT RAISE(ABORT, 'test_code_locked'); END;

CREATE TABLE IF NOT EXISTS quota_reservations (
  reservation_id TEXT PRIMARY KEY,
  day_key TEXT NOT NULL,
  client_key TEXT NOT NULL,
  ip_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'committed', 'refunded')),
  settlement_token TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS quota_reservations_day_idx
ON quota_reservations (day_key);

CREATE TABLE IF NOT EXISTS quota_maintenance (
  maintenance_key TEXT PRIMARY KEY,
  last_cleanup_day TEXT NOT NULL
);
