-- Applied automatically on server startup; run manually if needed
ALTER TABLE UNIT ADD COLUMN early_checkin_rate_per_hour DECIMAL(10,2) NULL;
ALTER TABLE UNIT ADD COLUMN early_checkout_rate_per_hour DECIMAL(10,2) NULL;
ALTER TABLE UNIT ADD COLUMN extra_pax_rate_per_night DECIMAL(10,2) NULL;

CREATE TABLE IF NOT EXISTS BOOKING_INTENT (
  intent_id INT NOT NULL AUTO_INCREMENT,
  public_token VARCHAR(36) NOT NULL,
  unit_id INT NOT NULL,
  owner_employee_id INT NOT NULL,
  primary_guest_name VARCHAR(255) NOT NULL,
  num_pax INT NOT NULL,
  check_in_date DATE NOT NULL,
  check_out_date DATE NOT NULL,
  early_checkin_hours DECIMAL(8,2) NOT NULL DEFAULT 0,
  early_checkout_hours DECIMAL(8,2) NOT NULL DEFAULT 0,
  rate_early_in_per_hour DECIMAL(10,2) NULL,
  rate_early_out_per_hour DECIMAL(10,2) NULL,
  extra_pax INT NOT NULL DEFAULT 0,
  extra_pax_rate_per_night_snapshot DECIMAL(10,2) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  consumed_at DATETIME NULL,
  PRIMARY KEY (intent_id),
  UNIQUE KEY uk_booking_intent_token (public_token),
  KEY idx_booking_intent_unit (unit_id)
);

-- Optional manual ALTERs (also applied on server startup):
-- booking_platform, nightly_rate_snapshot, stay_nights_snapshot,
-- stay_subtotal_snapshot, additional_charges_total_snapshot, grand_total_snapshot
