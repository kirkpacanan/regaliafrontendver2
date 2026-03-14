# ERD vs Current Database – Notes

## What’s implemented (aligned with your ERD)

### 1. Unit + owner + price
- **UNIT**: `price` column added (nullable decimal). Set when **adding** or **editing** a unit in Admin → Properties. Matches ERD “unit_price”.
- **Owner**: We use **EMPLOYEE** (role OWNER) + `owner_employee_id` on **TOWER** and **UNIT**, not a separate OWNER table. When an owner adds a unit, that unit is linked to them via `owner_employee_id`. No OWNER_UNIT table; one owner can have many units via TOWER/UNIT ownership.

### 2. Additional charges at checkout
- **ADDITIONAL_CHARGE**: `booking_id`, `description`, `quantity`, `unit_price`, `added_by`, `created_at`. Staff add charges in **Staff → Bookings** (“Additional Charges”: select booking, description, quantity, price, “+ Add Charge”).
- **Receipt**: “See the receipt here” = the **itemized list + total** shown in:
  - Staff **Bookings** page (Additional Charges section and in booking detail),
  - **QR scan** flow: after scanning a checked-in guest, “Check out” shows the **REGALIA Additional Charges** modal (item, qty × unit price, **TOTAL DUE**). So charges are added in one place and the receipt view is there and in booking detail.

### 3. Checkout flow
- Guest checks out → staff can add additional charges → guest sees receipt (modal / booking detail) and settles (e.g. “Please settle before check-out”). There is no separate “payment record” table yet (see below).

---

## Optional: PAYMENT table (ERD-style receipt record)

Your ERD has a **PAYMENT** table (e.g. `payment_id`, `unit_id`, `total_amount_paid`, `payment_date`, `payer_description`). Right now we only store **charges** (ADDITIONAL_CHARGE); we do **not** yet store a row like “Guest X paid ₱1,400 on 2026-03-13” for that checkout.

- **Current behavior**: Receipt = display of ADDITIONAL_CHARGE rows (itemized + total). No row that says “payment completed at this time”.
- **If you want a formal payment record** (for history, reporting, “paid at checkout”):
  - Add a **PAYMENT** (or **CHECKOUT_PAYMENT**) table: e.g. `payment_id`, `booking_id`, `total_amount_paid`, `payment_date`, `payer_description`, optional `recorded_by` (employee_id).
  - When staff (or guest) “settles” the charges at checkout, insert one PAYMENT row and optionally link ADDITIONAL_CHARGEs to it (e.g. `payment_id` on ADDITIONAL_CHARGE or a PAYMENT_CHARGE junction). Then “see the receipt here” can also mean “see the PAYMENT record” (amount, date, payer).

If you want this PAYMENT table and APIs (create payment at checkout, list payments), say so and we can add the migration and endpoints.

---

## Summary

| ERD concept           | Current implementation                                      |
|----------------------|-------------------------------------------------------------|
| Unit price           | UNIT.price (add/edit unit; migration adds column)           |
| Owner for unit       | EMPLOYEE (OWNER) + UNIT.owner_employee_id                   |
| Additional charges   | ADDITIONAL_CHARGE; add in Staff → Bookings                  |
| Receipt (itemized)   | Same ADDITIONAL_CHARGE data in modal + booking detail       |
| Payment record       | Not yet – optional PAYMENT table for “paid at checkout”     |
