-- Run if API errors: Unknown column 'owner_employee_id' in 'where clause' on OWNER_UNIT.
-- Older schemas may have named the FK column `employee_id` instead of `owner_employee_id`.
-- After this, restart the API (server also attempts this fix on startup).

-- If this fails with "Unknown column 'employee_id'", your table already matches — skip.
ALTER TABLE OWNER_UNIT CHANGE COLUMN employee_id owner_employee_id INT NOT NULL;
