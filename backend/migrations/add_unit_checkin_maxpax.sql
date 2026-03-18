-- Owner-editable booking hints (applied automatically on server startup if missing)
ALTER TABLE UNIT ADD COLUMN check_in_time VARCHAR(16) NULL;
ALTER TABLE UNIT ADD COLUMN check_out_time VARCHAR(16) NULL;
ALTER TABLE UNIT ADD COLUMN max_pax INT NULL;
