-- Adds description to monthly dues so admin + owner know what it's for.

ALTER TABLE MONTHLY_DUE
  ADD COLUMN description VARCHAR(255) NULL;

