-- Links unit-resident accounts (role OWNER) to their unit for dues visibility
ALTER TABLE EMPLOYEE ADD COLUMN resident_unit_id INT NULL;
