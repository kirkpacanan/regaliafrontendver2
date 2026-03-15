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

-- UNIT: price per night/rent (ERD: unit_price; stored as price for display)
CALL add_col_if_missing('UNIT', 'price', 'DECIMAL(10,2) NULL COMMENT ''Unit price (e.g. per night)''');

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

-- PAYMENT: record payments (system records, does not collect). ERD: PAYMENT
CREATE TABLE IF NOT EXISTS PAYMENT (
  payment_id INT AUTO_INCREMENT PRIMARY KEY,
  booking_id INT NULL,
  unit_id INT NULL,
  amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  payment_date DATE NOT NULL,
  payer_description VARCHAR(255) NULL COMMENT 'guest name or unit label',
  status VARCHAR(32) NOT NULL DEFAULT 'completed',
  method VARCHAR(64) NULL COMMENT 'cash, bank_transfer, etc',
  recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  recorded_by INT NULL COMMENT 'employee_id',
  owner_employee_id INT NULL,
  INDEX idx_payment_owner (owner_employee_id),
  INDEX idx_payment_date (payment_date),
  INDEX idx_payment_booking (booking_id)
);

-- MONTHLY_DUE: recurring dues per unit (maintenance, pool, guards, etc). ERD: UNIT_MONTHLY_DUES
CREATE TABLE IF NOT EXISTS MONTHLY_DUE (
  id INT AUTO_INCREMENT PRIMARY KEY,
  unit_id INT NULL COMMENT 'NULL = general/other',
  amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  due_date DATE NOT NULL COMMENT 'e.g. first day of month',
  effective_from_month VARCHAR(7) NULL COMMENT 'YYYY-MM: first month this due applies (stops April due showing in Feb)',
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  owner_employee_id INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_monthly_due_owner (owner_employee_id),
  INDEX idx_monthly_due_date (due_date)
);

-- Add effective_from_month if table existed without it (safe to run)
CALL add_col_if_missing('MONTHLY_DUE', 'effective_from_month', 'VARCHAR(7) NULL COMMENT ''YYYY-MM: first month this due applies''');
-- Backfill existing rows so filtering works
UPDATE MONTHLY_DUE SET effective_from_month = DATE_FORMAT(due_date, '%Y-%m') WHERE effective_from_month IS NULL;

DROP PROCEDURE IF EXISTS add_col_if_missing;

-- Optional indexes (ignore error 1061 "Duplicate key name" if index already exists)
-- CREATE INDEX idx_tower_owner_employee_id ON TOWER (owner_employee_id);
-- CREATE INDEX idx_unit_owner_employee_id ON UNIT (owner_employee_id);