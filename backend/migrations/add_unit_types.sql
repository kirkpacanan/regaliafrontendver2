-- Database-backed list of unit types (admin + global defaults).

CREATE TABLE IF NOT EXISTS UNIT_TYPE (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  owner_employee_id INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_owner_name (owner_employee_id, name),
  INDEX idx_owner (owner_employee_id),
  INDEX idx_name (name)
);

-- Global defaults (owner_employee_id = NULL). Safe to run multiple times.
INSERT IGNORE INTO UNIT_TYPE (owner_employee_id, name) VALUES
  (NULL, 'Studio Type'),
  (NULL, '1 Bedroom'),
  (NULL, '2 Bedroom'),
  (NULL, '3 Bedroom'),
  (NULL, 'Penthouse'),
  (NULL, 'Duplex');

