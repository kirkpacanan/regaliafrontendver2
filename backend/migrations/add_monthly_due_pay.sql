-- DB-backed "paid for month" tracking for monthly dues.
-- Admin marks due paid/unpaid per view month; Owner dashboard is read-only and reflects this table.

CREATE TABLE IF NOT EXISTS MONTHLY_DUE_PAY (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  due_id INT NOT NULL,
  paid_month VARCHAR(7) NOT NULL COMMENT 'YYYY-MM',
  paid_by_employee_id INT NULL,
  paid_at DATETIME NULL,
  UNIQUE KEY uniq_due_month (due_id, paid_month),
  INDEX idx_due (due_id),
  INDEX idx_paid_month (paid_month)
);

