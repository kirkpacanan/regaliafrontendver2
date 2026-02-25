-- Run this in Aiven MySQL (Workbench or Query tab) to create TOWER and UNIT tables.
-- Use the same database where EMPLOYEE and EMPLOYEE_ROLE already exist.

-- 1) TOWER table (from ERD)
CREATE TABLE IF NOT EXISTS TOWER (
  tower_id INT AUTO_INCREMENT PRIMARY KEY,
  tower_name VARCHAR(255) NOT NULL,
  number_floors INT NOT NULL
);

-- 2) UNIT table (from ERD – links to TOWER)
CREATE TABLE IF NOT EXISTS UNIT (
  unit_id INT AUTO_INCREMENT PRIMARY KEY,
  tower_id INT NOT NULL,
  unit_number VARCHAR(50) NOT NULL,
  floor_number VARCHAR(20) NULL,
  unit_type VARCHAR(100) NULL,
  unit_size DECIMAL(10,2) NULL,
  description TEXT NULL,
  image_urls LONGTEXT NULL,
  FOREIGN KEY (tower_id) REFERENCES TOWER(tower_id) ON DELETE CASCADE
);

-- Optional: if you want to assign employees to towers (Assign Building in admin)
CREATE TABLE IF NOT EXISTS EMPLOYEE_TOWER (
  employee_id INT NOT NULL,
  tower_id INT NOT NULL,
  PRIMARY KEY (employee_id, tower_id),
  FOREIGN KEY (employee_id) REFERENCES EMPLOYEE(employee_id) ON DELETE CASCADE,
  FOREIGN KEY (tower_id) REFERENCES TOWER(tower_id) ON DELETE CASCADE
);
