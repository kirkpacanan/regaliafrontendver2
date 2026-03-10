-- Authorized/registered guests per booking (supports ERD concept: guests under one booking).
-- Run this on your DB to enable guest registration and walk-in features.

CREATE TABLE IF NOT EXISTS BOOKING_GUEST (
  id INT AUTO_INCREMENT PRIMARY KEY,
  booking_id INT NOT NULL,
  full_name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NULL,
  contact_number VARCHAR(64) NULL,
  added_via ENUM('booker', 'walkin') NOT NULL DEFAULT 'booker',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (booking_id) REFERENCES BOOKING(booking_id) ON DELETE CASCADE,
  INDEX idx_booking (booking_id)
);
