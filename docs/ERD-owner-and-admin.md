# ERD: Owner vs Admin

## **OWNER** (unit resident)

Your **`OWNER`** table stores **profile + verification** for people who own/occupy a unit:

| Column           | Purpose                                      |
|-----------------|-----------------------------------------------|
| `owner_id`      | Primary key                                   |
| `full_name`     | Legal / display name                          |
| `contact_number`| Phone                                         |
| `email`         | Contact email                                 |
| `valid_id`      | Blob (uploaded ID document)                 |
| `is_verified`   | Admin has verified the ID (0/1)               |

**Login** still uses **`EMPLOYEE`** (username, password) + **`EMPLOYEE_ROLE`** (`OWNER`).  
Each **`OWNER`** row links to exactly one **`employee_id`** (the account they use to log in).

**Unit:** `unit_id` on `OWNER` matches the assigned unit (same idea as `EMPLOYEE.resident_unit_id`).

---

## **ADMIN** — do you need a new ERD table?

**Usually no.** Condominium admins are already modeled as:

- **`EMPLOYEE`** — name, username, password, email, etc.
- **`EMPLOYEE_ROLE.role_type = 'ADMIN'`** — created at **sign-up** (self-registration).

So **Admin** is not a duplicate “person” entity; it’s a **role** on **`EMPLOYEE`**.

Add a separate **`ADMIN`** table only if you need extra fields *only* for management (e.g. company name, license number). Otherwise, optional columns on **`EMPLOYEE`** (e.g. `organization_name`) are enough.

---

## Relationship summary

```
EMPLOYEE (1) ──< EMPLOYEE_ROLE (OWNER | ADMIN | Front Desk …)
EMPLOYEE (1) ──< OWNER (optional profile row; only for role OWNER)
UNIT (1) ── assigned via resident_unit_id / OWNER.unit_id
```
