CREATE TABLE IF NOT EXISTS phone_pins (
  phone CHAR(10) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  uid VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  pin_hash VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS auth_attempts (
  scope VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  started_at BIGINT NOT NULL,
  attempts INT NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS otp_sessions (
  session_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  phone CHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires_at BIGINT NOT NULL,
  used BOOLEAN NOT NULL DEFAULT FALSE,
  KEY otp_expiry (expires_at)
) ENGINE=InnoDB;
