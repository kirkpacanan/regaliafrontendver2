-- Owners can be created before any unit is assigned. resident_unit_id must allow NULL.
-- Run this if POST /api/owners returns 500 when creating an owner without units.
ALTER TABLE EMPLOYEE MODIFY COLUMN resident_unit_id INT NULL;
