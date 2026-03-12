-- Add ownership columns to isolate properties per owner account.
-- Safe to run multiple times.

ALTER TABLE TOWER
  ADD COLUMN IF NOT EXISTS owner_employee_id INT NULL;

ALTER TABLE UNIT
  ADD COLUMN IF NOT EXISTS owner_employee_id INT NULL;

-- Optional indexes (run once; may error if they already exist)
CREATE INDEX idx_tower_owner_employee_id ON TOWER (owner_employee_id);
CREATE INDEX idx_unit_owner_employee_id ON UNIT (owner_employee_id);

