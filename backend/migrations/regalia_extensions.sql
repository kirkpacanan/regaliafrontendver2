-- =============================================================================
-- Regalia: single migration for guest registration, authorization, and owner-scoped properties.
-- Safe to re-run. Works on MySQL 5.7 and 8.x (uses a helper procedure, no IF NOT EXISTS on columns).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. BOOKING_GUEST: authorized/registered guests per booking (guest registration & walk-in)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS BOOKING_GUEST (
  id INT AUTO_INCREMENT PRIMARY KEY,
  booking_id INT NOT NULL,
  full_name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NULL,
  contact_number VARCHAR(64) NULL,
  added_via ENUM('booker', 'walkin') NOT NULL DEFAULT 'booker',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (booking_id) REFERENCES BOOKING(booking_id) ON DELETE CASCADE,
  INDEX idx_booking (booking_id)
);

-- Helper: add a column only if it does not exist (avoids "Duplicate column" on re-run)
DROP PROCEDURE IF EXISTS add_col_if_missing;
DELIMITER //
CREATE PROCEDURE add_col_if_missing(
  IN p_table VARCHAR(64),
  IN p_column VARCHAR(64),
  IN p_def TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = p_table AND COLUMN_NAME = p_column
  ) THEN
    SET @q = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN `', p_column, '` ', p_def);
    PREPARE st FROM @q;
    EXECUTE st;
    DEALLOCATE PREPARE st;
  END IF;
END//
DELIMITER ;

-- BOOKING_GUEST: guest authorization fields
CALL add_col_if_missing('BOOKING_GUEST', 'purpose', 'VARCHAR(255) NULL COMMENT ''Purpose of visit/stay''');
CALL add_col_if_missing('BOOKING_GUEST', 'relationship', 'VARCHAR(128) NULL COMMENT ''Relationship to primary booker''');
CALL add_col_if_missing('BOOKING_GUEST', 'valid_from', 'DATE NULL COMMENT ''Authorization valid from''');
CALL add_col_if_missing('BOOKING_GUEST', 'valid_to', 'DATE NULL COMMENT ''Authorization valid to''');
CALL add_col_if_missing('BOOKING_GUEST', 'status', 'VARCHAR(32) NOT NULL DEFAULT ''active'' COMMENT ''active, expired, revoked''');

-- TOWER & UNIT: ownership so each owner account sees only their properties
CALL add_col_if_missing('TOWER', 'owner_employee_id', 'INT NULL');
CALL add_col_if_missing('UNIT', 'owner_employee_id', 'INT NULL');

-- BOOKING: check-in/check-out timestamps (for QR check-in and dashboard)
CALL add_col_if_missing('BOOKING', 'checked_in_at', 'DATETIME NULL');
CALL add_col_if_missing('BOOKING', 'checked_out_at', 'DATETIME NULL');

-- EMPLOYEE: theme color preference (persisted per user)
CALL add_col_if_missing('EMPLOYEE', 'theme_color', 'VARCHAR(32) NULL DEFAULT ''default'' COMMENT ''UI color theme''');

-- ADDITIONAL_CHARGE: extra charges added by staff per booking
CREATE TABLE IF NOT EXISTS ADDITIONAL_CHARGE (
  charge_id INT AUTO_INCREMENT PRIMARY KEY,
  booking_id INT NOT NULL,
  description VARCHAR(255) NOT NULL,
  quantity INT NOT NULL DEFAULT 1,
  unit_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  added_by INT NULL COMMENT 'employee_id of staff who added it',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (booking_id) REFERENCES BOOKING(booking_id) ON DELETE CASCADE,
  INDEX idx_charge_booking (booking_id)
);

DROP PROCEDURE IF EXISTS add_col_if_missing;

-- Optional indexes (ignore error 1061 "Duplicate key name" if index already exists)
-- CREATE INDEX idx_tower_owner_employee_id ON TOWER (owner_employee_id);
-- CREATE INDEX idx_unit_owner_employee_id ON UNIT (owner_employee_id);