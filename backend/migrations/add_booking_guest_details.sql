-- Adds full guest-detail columns for Guest 2+ (BOOKING_GUEST).
-- This enables owner/frontdesk "Guest 1..N" stepper to display all guest info.

ALTER TABLE BOOKING_GUEST
  ADD COLUMN permanent_address VARCHAR(255) NULL,
  ADD COLUMN age VARCHAR(32) NULL,
  ADD COLUMN nationality VARCHAR(120) NULL,
  ADD COLUMN occupation VARCHAR(120) NULL,
  ADD COLUMN id_document LONGTEXT NULL;

