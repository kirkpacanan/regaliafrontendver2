-- Unit owner profile (ERD: OWNER). Login remains EMPLOYEE + EMPLOYEE_ROLE (OWNER).
CREATE TABLE IF NOT EXISTS OWNER (
  owner_id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL UNIQUE COMMENT 'FK to EMPLOYEE (login account)',
  unit_id INT NULL COMMENT 'Same as EMPLOYEE.resident_unit_id; denormalized for reporting',
  full_name VARCHAR(255) NOT NULL,
  contact_number VARCHAR(128) NULL,
  email VARCHAR(255) NOT NULL,
  valid_id LONGBLOB NULL COMMENT 'Scanned valid ID image/PDF',
  is_verified TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_owner_unit (unit_id)
);
