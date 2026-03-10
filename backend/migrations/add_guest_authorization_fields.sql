-- Add Guest Authorization fields to BOOKING_GUEST (aligns with ERD GUEST_AUTHORIZATION).
-- Each row = one guest authorized for one booking, with purpose and validity period.
-- Run after add_booking_guest.sql. If a column already exists, skip that line.

ALTER TABLE BOOKING_GUEST ADD COLUMN purpose VARCHAR(255) NULL COMMENT 'Purpose of visit/stay';
ALTER TABLE BOOKING_GUEST ADD COLUMN relationship VARCHAR(128) NULL COMMENT 'Relationship to primary booker';
ALTER TABLE BOOKING_GUEST ADD COLUMN valid_from DATE NULL COMMENT 'Authorization valid from (default: booking check-in)';
ALTER TABLE BOOKING_GUEST ADD COLUMN valid_to DATE NULL COMMENT 'Authorization valid to (default: booking check-out)';
ALTER TABLE BOOKING_GUEST ADD COLUMN status VARCHAR(32) NOT NULL DEFAULT 'active' COMMENT 'active, expired, revoked';
