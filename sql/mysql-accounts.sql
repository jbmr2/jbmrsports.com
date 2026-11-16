CREATE TABLE IF NOT EXISTS app_accounts (
  uid VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin PRIMARY KEY,
  phone CHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  disabled BOOLEAN NOT NULL DEFAULT FALSE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS app_sessions (
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  uid VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  expires_at BIGINT NOT NULL,
  KEY sessions_expiry (expires_at),
  CONSTRAINT app_sessions_account FOREIGN KEY (uid) REFERENCES app_accounts (uid) ON DELETE CASCADE
) ENGINE=InnoDB;
