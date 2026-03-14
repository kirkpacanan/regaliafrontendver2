# How Data Should Be Reflected in the Payments Section

This document suggests how to surface payment-related data in the admin **Payments** page, using your existing APIs and data model.

---

## 1. Summary stat cards (top of page)

| Card | Source | How to compute |
|------|--------|----------------|
| **Total received** | `GET /api/payments` | Sum of all `amount` where `status === 'completed'` (or all, if you only record completed payments). Display as **₱ X,XXX.XX**. |
| **Pending** | Optional: `/api/charges/all` and/or `/api/monthly-dues` | **Option A:** Sum of **additional charges** not yet covered by a payment (e.g. total from `/api/charges/all` minus any “paid” tracking you add). **Option B:** Sum of **monthly dues** with `status === 'pending'` from `/api/monthly-dues`. **Option C:** Leave as "—" or "0" until you define “pending” (e.g. unpaid charges + unpaid dues). |
| **This month** | `GET /api/payments` | Sum of `amount` where `payment_date` is in the **current calendar month**. Display as **₱ X,XXX.XX**. |

All amounts in **Philippine Peso (₱)**.

---

## 2. Payment history table

- **Data source:** `GET /api/payments` (returns rows with `payment_id`, `booking_id`, `amount`, `payment_date`, `payer_description`, `status`, `method`, `guest_name`, `unit_number`, `tower_name`, etc.).
- **Columns to show:**

| Column | Map from API |
|--------|----------------|
| **Date** | `payment_date` (e.g. format as `MMM DD, YYYY` or `YYYY-MM-DD`). |
| **Guest / Booking** | `guest_name` or `payer_description`; optionally append unit/tower, e.g. `Guest Name · Unit 501, Tower A`. |
| **Amount** | `amount` formatted as **₱ X,XXX.00**. |
| **Status** | `status` (e.g. `completed`, `pending`) — show as “Completed” / “Pending” or a small badge. |
| **Method** | `method` (e.g. Cash, Card, Bank transfer) or “—” if empty. |

- **Order:** Already returned `ORDER BY payment_date DESC, recorded_at DESC`; keep that order in the UI.
- **Empty state:** If the list is empty, show a single row: “No recorded payments yet” (or similar).

---

## 3. Optional: separate “Pending” sources

If you want **Pending** to reflect real outstanding money:

- **Additional charges:** Use `GET /api/charges/all` to get per-booking charges. You can show a small “Outstanding charges” total (sum of charge totals) and/or a link to Bookings/charges. When a payment is recorded (e.g. via `POST /api/payments`), you can later link it to a booking so “pending” can be reduced (requires backend support if not already there).
- **Monthly dues:** Use `GET /api/monthly-dues` and sum `amount` where `status === 'pending'` (or equivalent). That total can be shown in the **Pending** card or in a separate “Pending dues” line.

---

## 4. Optional: filters and actions

- **Date range:** Add a “From” / “To” filter and either filter in the frontend (from full list) or add query params to `GET /api/payments` (e.g. `?from=YYYY-MM-DD&to=YYYY-MM-DD`) and use them in the backend.
- **Record payment:** Add a “Record payment” button that opens a small form (booking/unit, amount, date, payer description, method) and submits `POST /api/payments`, then refreshes the list and stat cards.
- **Export:** Add “Export to CSV” that uses the same payment list (and current filters) so owners can download for accounting.

---

## 5. Consistency with the rest of the app

- Use the same **auth headers** (e.g. `Authorization: Bearer <token>`) for all payment API calls.
- Use the same **date and number formatting** as elsewhere (e.g. Philippine locale for numbers, consistent date format).
- If the backend is owner-scoped, the Payments page will only show data for the logged-in owner; no extra filtering needed on the frontend beyond using the same token.

---

## 6. Backend APIs used

| Endpoint | Purpose |
|----------|---------|
| `GET /api/payments` | List recorded payments (for stats and table). |
| `POST /api/payments` | Record a new payment (for “Record payment” if you add it). |
| `GET /api/charges/all` | Optional: show outstanding additional charges. |
| `GET /api/monthly-dues` | Optional: show pending monthly dues. |

Implementing the stats and table from `GET /api/payments` (as in the next step) gives you a clear, consistent way for data to be reflected in the Payments section; you can add Pending from charges/dues and filters later.
