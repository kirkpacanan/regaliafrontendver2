// ==================== server.js ====================
const express = require("express");
const cors = require("cors");
const mysql = require("mysql2");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const path = require("path");
const QRCode = require("qrcode");
require("dotenv").config();
require("dotenv").config({ path: path.join(__dirname, "aiven.env") });

const app = express();
const BREVO_API_KEY = process.env.BREVO_API_KEY || null;
if (!BREVO_API_KEY) console.warn("BREVO_API_KEY not set – confirmation emails will not be sent.");
else console.log("Brevo loaded – confirmation emails enabled.");

// ---------------- Middleware ----------------
app.use(cors());
app.use(express.json({ limit: "50mb" })); // Allow large payloads (e.g. 4 base64 unit images)

// Optional auth: set req.user = { employee_id, role } from Bearer token (no 401 if missing)
function optionalAuth(req, res, next) {
  req.user = null;
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return next();
  try {
    const decoded = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
    req.user = { employee_id: decoded.employee_id, role: decoded.role };
  } catch (e) { /* invalid or expired */ }
  next();
}

// ---------------- DB Connection ----------------
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false } // for Aiven MySQL
});

db.connect(err => {
  if (err) console.error("DB connection failed:", err);
  else console.log("✅ Connected to Aiven DB!");
});

// ---------------- Serve Frontend ----------------
// Serve static files from frontend folder
app.use(express.static(path.join(__dirname, "../frontend")));

// Serve index.html at root
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend", "index.html"));
});

// ---------------- SIGNUP ----------------
app.post("/signup", async (req, res) => {
  
  try {
    const { full_name, address, username, password, contact_number, email } = req.body;

    // Check if username or email exists
    const [existing] = await db.promise().query(
      "SELECT * FROM EMPLOYEE WHERE username = ? OR email = ?",
      [username, email]
    );
    if (existing.length > 0) 
      return res.status(400).json({ error: "Username or email already exists" });

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Insert into EMPLOYEE
    const [result] = await db.promise().query(
      "INSERT INTO EMPLOYEE (full_name, address, username, password, contact_number, email) VALUES (?, ?, ?, ?, ?, ?)",
      [full_name, address, username, hashedPassword, contact_number, email]
    );

    const employeeId = result.insertId;

    // Automatically assign OWNER role
    await db.promise().query(
      "INSERT INTO EMPLOYEE_ROLE (employee_id, role_type, status) VALUES (?, 'OWNER', 'active')",
      [employeeId]
    );

    res.json({ message: "Account created successfully!", employeeId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ---------------- LOGIN ----------------
app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    const [rows] = await db.promise().query(
      "SELECT * FROM EMPLOYEE WHERE username = ?",
      [username]
    );
    if (rows.length === 0) return res.status(400).json({ error: "User not found" });

    const employee = rows[0];
    const match = await bcrypt.compare(password, employee.password);
    if (!match) return res.status(400).json({ error: "Invalid password" });

    const [roles] = await db.promise().query(
      "SELECT role_type FROM EMPLOYEE_ROLE WHERE employee_id = ?",
      [employee.employee_id]
    );

    const token = jwt.sign(
      { employee_id: employee.employee_id, role: roles[0]?.role_type },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    res.json({ message: "Login successful", token, employee, role: roles[0]?.role_type });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ---------------- Towers (ERD: TOWER) ----------------
app.get("/api/towers", async (req, res) => {
  try {
    const [rows] = await db.promise().query(
      "SELECT tower_id, tower_name, number_floors FROM TOWER ORDER BY tower_name"
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch towers" });
  }
});

app.post("/api/towers", async (req, res) => {
  try {
    const { tower_name, number_floors } = req.body;
    if (!tower_name || number_floors == null)
      return res.status(400).json({ error: "tower_name and number_floors required" });
    const [result] = await db.promise().query(
      "INSERT INTO TOWER (tower_name, number_floors) VALUES (?, ?)",
      [String(tower_name).trim(), Number(number_floors)]
    );
    res.status(201).json({ tower_id: result.insertId, tower_name, number_floors });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to create tower" });
  }
});

// ---------------- Units (ERD: UNIT – linked to TOWER) ----------------
app.get("/api/units", async (req, res) => {
  try {
    const [rows] = await db.promise().query(
      `SELECT u.unit_id, u.tower_id, u.unit_number, u.floor_number, u.unit_type, u.unit_size, u.description,
        u.image_urls, t.tower_name
       FROM UNIT u
       LEFT JOIN TOWER t ON t.tower_id = u.tower_id
       ORDER BY t.tower_name, u.floor_number, u.unit_number`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch units" });
  }
});

// Single unit by id (for guest booking page – public, no auth)
app.get("/api/units/:id", async (req, res) => {
  try {
    const unitId = Number(req.params.id);
    const [rows] = await db.promise().query(
      `SELECT u.unit_id, u.tower_id, u.unit_number, u.floor_number, u.unit_type, u.unit_size, u.description,
        u.image_urls, u.price, t.tower_name, t.number_floors
       FROM UNIT u
       LEFT JOIN TOWER t ON t.tower_id = u.tower_id
       WHERE u.unit_id = ?`,
      [unitId]
    );
    if (!rows || rows.length === 0)
      return res.status(404).json({ error: "Unit not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch unit" });
  }
});

app.post("/api/units", async (req, res) => {
  try {
    const { tower_id, unit_number, floor_number, unit_type, unit_size, description, image_urls } = req.body;
    if (!tower_id || !unit_number)
      return res.status(400).json({ error: "tower_id and unit_number required" });
    const hasImages = image_urls != null && String(image_urls).trim() !== "";
    const [result] = hasImages
      ? await db.promise().query(
          `INSERT INTO UNIT (tower_id, unit_number, floor_number, unit_type, unit_size, description, image_urls)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            Number(tower_id),
            String(unit_number).trim(),
            floor_number != null ? String(floor_number).trim() : null,
            unit_type ? String(unit_type).trim() : null,
            unit_size != null ? Number(unit_size) : null,
            description ? String(description).trim() : null,
            String(image_urls).trim(),
          ]
        )
      : await db.promise().query(
          `INSERT INTO UNIT (tower_id, unit_number, floor_number, unit_type, unit_size, description)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            Number(tower_id),
            String(unit_number).trim(),
            floor_number != null ? String(floor_number).trim() : null,
            unit_type ? String(unit_type).trim() : null,
            unit_size != null ? Number(unit_size) : null,
            description ? String(description).trim() : null,
          ]
        );
    res.status(201).json({
      unit_id: result.insertId,
      tower_id: Number(tower_id),
      unit_number: String(unit_number).trim(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to create unit" });
  }
});

// ---------------- Properties = units with tower (for admin list) ----------------
const PROPERTIES_MINIMAL_SQL = `SELECT u.unit_id, u.tower_id, u.unit_number, u.floor_number, u.unit_type, u.unit_size, u.description,
  t.tower_name, t.number_floors
 FROM UNIT u
 LEFT JOIN TOWER t ON t.tower_id = u.tower_id
 ORDER BY t.tower_name, u.floor_number, u.unit_number`;

app.get("/api/properties", async (req, res) => {
  try {
    let rows;
    try {
      [rows] = await db.promise().query(
        `SELECT u.unit_id, u.tower_id, u.unit_number, u.floor_number, u.unit_type, u.unit_size, u.description,
          u.image_urls, u.price, t.tower_name, t.number_floors
         FROM UNIT u
         LEFT JOIN TOWER t ON t.tower_id = u.tower_id
         ORDER BY t.tower_name, u.floor_number, u.unit_number`
      );
    } catch (colErr) {
      if (colErr.code === "ER_BAD_FIELD_ERROR") {
        [rows] = await db.promise().query(PROPERTIES_MINIMAL_SQL);
        rows.forEach(r => {
          if (r.price === undefined) r.price = null;
          if (r.image_urls === undefined) r.image_urls = null;
        });
      } else throw colErr;
    }
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch properties" });
  }
});

// Update unit (price optional – add column with: ALTER TABLE UNIT ADD COLUMN price DECIMAL(10,2) NULL;)
app.put("/api/units/:id", async (req, res) => {
  try {
    const unitId = Number(req.params.id);
    const { unit_number, floor_number, unit_type, unit_size, description, image_urls, price } = req.body;
    if (!unit_number) return res.status(400).json({ error: "unit_number required" });

    const updates = [];
    const values = [];
    if (unit_number != null) { updates.push("unit_number = ?"); values.push(String(unit_number).trim()); }
    if (floor_number !== undefined) { updates.push("floor_number = ?"); values.push(floor_number === "" || floor_number == null ? null : String(floor_number).trim()); }
    if (unit_type !== undefined) { updates.push("unit_type = ?"); values.push(unit_type === "" || unit_type == null ? null : String(unit_type).trim()); }
    if (unit_size !== undefined) { updates.push("unit_size = ?"); values.push(unit_size === "" || unit_size == null ? null : Number(unit_size)); }
    if (description !== undefined) { updates.push("description = ?"); values.push(description === "" || description == null ? null : String(description).trim()); }
    if (image_urls !== undefined) { updates.push("image_urls = ?"); values.push(image_urls === "" || image_urls == null ? null : (typeof image_urls === "string" ? image_urls : JSON.stringify(image_urls))); }
    if (price !== undefined) { updates.push("price = ?"); values.push(price === "" || price == null ? null : Number(price)); }

    if (updates.length === 0) return res.status(400).json({ error: "No fields to update" });
    values.push(unitId);
    await db.promise().query(
      `UPDATE UNIT SET ${updates.join(", ")} WHERE unit_id = ?`,
      values
    );
    res.json({ message: "Unit updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to update unit" });
  }
});

// Delete unit
app.delete("/api/units/:id", async (req, res) => {
  try {
    const unitId = Number(req.params.id);
    const [result] = await db.promise().query("DELETE FROM UNIT WHERE unit_id = ?", [unitId]);
    if (result.affectedRows === 0) return res.status(404).json({ error: "Unit not found" });
    res.json({ message: "Unit deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to delete unit" });
  }
});

// ---------------- Employees (ERD: EMPLOYEE + EMPLOYEE_ROLE) ----------------
// optionalAuth: if Bearer token present, req.user = { employee_id, role }. Owner sees only employees they added (created_by_employee_id) and OWNER role is hidden.
app.get("/api/employees", optionalAuth, async (req, res) => {
  try {
    const baseSelect = `SELECT e.employee_id, e.full_name, e.username, e.contact_number, e.email, e.address,
      (SELECT r.role_type FROM EMPLOYEE_ROLE r WHERE r.employee_id = e.employee_id AND r.status = 'active' ORDER BY r.role_id DESC LIMIT 1) AS role_type,
      (SELECT t.tower_name FROM EMPLOYEE_TOWER et JOIN TOWER t ON t.tower_id = et.tower_id WHERE et.employee_id = e.employee_id LIMIT 1) AS assigned_tower
     FROM EMPLOYEE e`;
    let rows;
    if (req.user && req.user.role === "OWNER") {
      try {
        const [r] = await db.promise().query(
          baseSelect + ` WHERE e.created_by_employee_id = ? AND (SELECT r.role_type FROM EMPLOYEE_ROLE r WHERE r.employee_id = e.employee_id AND r.status = 'active' ORDER BY r.role_id DESC LIMIT 1) != 'OWNER' ORDER BY e.full_name`,
          [req.user.employee_id]
        );
        rows = r;
      } catch (colErr) {
        if (colErr.code === "ER_BAD_FIELD_ERROR" && /created_by_employee_id/.test(colErr.message)) {
          const [r] = await db.promise().query(baseSelect + ` ORDER BY e.full_name`);
          rows = (r || []).filter(e => e.role_type !== "OWNER");
        } else throw colErr;
      }
    } else {
      const [r] = await db.promise().query(baseSelect + ` ORDER BY e.full_name`);
      rows = (r || []).filter(e => e.role_type !== "OWNER");
    }
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch employees" });
  }
});

app.post("/api/employees", optionalAuth, async (req, res) => {
  try {
    const { full_name, address, username, password, contact_number, email, role_type } = req.body;
    if (!full_name || !username || !password || !email)
      return res.status(400).json({ error: "full_name, username, password, and email required" });

    const [existing] = await db.promise().query(
      "SELECT * FROM EMPLOYEE WHERE username = ? OR email = ?",
      [username, email]
    );
    if (existing.length > 0)
      return res.status(400).json({ error: "Username or email already exists" });

    const hashedPassword = await bcrypt.hash(password, 10);
    const creatorId = req.user && req.user.employee_id ? req.user.employee_id : null;
    let result;
    if (creatorId) {
      try {
        [result] = await db.promise().query(
          "INSERT INTO EMPLOYEE (full_name, address, username, password, contact_number, email, created_by_employee_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [full_name, address || null, username, hashedPassword, contact_number || null, email, creatorId]
        );
      } catch (colErr) {
        if (colErr.code === "ER_BAD_FIELD_ERROR" && /created_by_employee_id/.test(colErr.message)) {
          [result] = await db.promise().query(
            "INSERT INTO EMPLOYEE (full_name, address, username, password, contact_number, email) VALUES (?, ?, ?, ?, ?, ?)",
            [full_name, address || null, username, hashedPassword, contact_number || null, email]
          );
        } else throw colErr;
      }
    } else {
      [result] = await db.promise().query(
        "INSERT INTO EMPLOYEE (full_name, address, username, password, contact_number, email) VALUES (?, ?, ?, ?, ?, ?)",
        [full_name, address || null, username, hashedPassword, contact_number || null, email]
      );
    }
    const employeeId = result.insertId;
    const role = role_type || "Front Desk";
    await db.promise().query(
      "INSERT INTO EMPLOYEE_ROLE (employee_id, role_type, status) VALUES (?, ?, 'active')",
      [employeeId, role]
    );
    res.status(201).json({ message: "Employee created", employeeId, role_type: role });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create employee" });
  }
});

// Assign employee to tower (EMPLOYEE_TOWER)
app.put("/api/employees/:id/assign-tower", async (req, res) => {
  try {
    const employeeId = Number(req.params.id);
    const { tower_id } = req.body;
    if (!tower_id) return res.status(400).json({ error: "tower_id required" });

    await db.promise().query("DELETE FROM EMPLOYEE_TOWER WHERE employee_id = ?", [employeeId]);
    await db.promise().query("INSERT INTO EMPLOYEE_TOWER (employee_id, tower_id) VALUES (?, ?)", [employeeId, Number(tower_id)]);
    res.json({ message: "Assignment saved" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to assign tower" });
  }
});

// Update employee (full_name, contact_number, email, address, role_type)
app.put("/api/employees/:id", async (req, res) => {
  try {
    const employeeId = Number(req.params.id);
    const { full_name, contact_number, email, address, role_type } = req.body;

    if (full_name != null) await db.promise().query("UPDATE EMPLOYEE SET full_name = ? WHERE employee_id = ?", [String(full_name).trim(), employeeId]);
    if (contact_number !== undefined) await db.promise().query("UPDATE EMPLOYEE SET contact_number = ? WHERE employee_id = ?", [contact_number === "" || contact_number == null ? null : String(contact_number).trim(), employeeId]);
    if (email != null) await db.promise().query("UPDATE EMPLOYEE SET email = ? WHERE employee_id = ?", [String(email).trim(), employeeId]);
    if (address !== undefined) await db.promise().query("UPDATE EMPLOYEE SET address = ? WHERE employee_id = ?", [address === "" || address == null ? null : String(address).trim(), employeeId]);
    if (role_type != null) {
      await db.promise().query("UPDATE EMPLOYEE_ROLE SET status = 'inactive' WHERE employee_id = ?", [employeeId]);
      await db.promise().query("INSERT INTO EMPLOYEE_ROLE (employee_id, role_type, status) VALUES (?, ?, 'active')", [employeeId, String(role_type).trim()]);
    }
    res.json({ message: "Employee updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to update employee" });
  }
});

// Delete employee (removes EMPLOYEE_ROLE and EMPLOYEE_TOWER via FK, then EMPLOYEE)
app.delete("/api/employees/:id", async (req, res) => {
  try {
    const employeeId = Number(req.params.id);
    await db.promise().query("DELETE FROM EMPLOYEE_ROLE WHERE employee_id = ?", [employeeId]);
    await db.promise().query("DELETE FROM EMPLOYEE_TOWER WHERE employee_id = ?", [employeeId]);
    const [result] = await db.promise().query("DELETE FROM EMPLOYEE WHERE employee_id = ?", [employeeId]);
    if (result.affectedRows === 0) return res.status(404).json({ error: "Employee not found" });
    res.json({ message: "Employee deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to delete employee" });
  }
});

// ---------------- Bookings (guest submissions) ----------------
const BOOKINGS_BASE_SQL = `SELECT b.booking_id, b.unit_id, b.guest_name, b.email, b.contact_number, b.check_in_date, b.check_out_date,
  b.inclusive_dates, b.status, b.rejection_reason, b.created_at,
  u.unit_number, u.unit_type, t.tower_name
 FROM BOOKING b
 LEFT JOIN UNIT u ON u.unit_id = b.unit_id
 LEFT JOIN TOWER t ON t.tower_id = u.tower_id
 ORDER BY b.check_in_date ASC, b.created_at DESC`;

app.get("/api/bookings", async (req, res) => {
  try {
    let rows;
    try {
      [rows] = await db.promise().query(
        `SELECT b.booking_id, b.unit_id, b.guest_name, b.email, b.contact_number, b.check_in_date, b.check_out_date,
          b.inclusive_dates, b.status, b.rejection_reason, b.created_at,
          b.checked_in_at, b.checked_out_at,
          u.unit_number, u.unit_type, t.tower_name
         FROM BOOKING b
         LEFT JOIN UNIT u ON u.unit_id = b.unit_id
         LEFT JOIN TOWER t ON t.tower_id = u.tower_id
         ORDER BY b.check_in_date ASC, b.created_at DESC`
      );
    } catch (colErr) {
      if (colErr.code === "ER_BAD_FIELD_ERROR") {
        [rows] = await db.promise().query(BOOKINGS_BASE_SQL);
        rows.forEach((r) => { r.checked_in_at = null; r.checked_out_at = null; });
      } else throw colErr;
    }
    res.json(rows || []);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch bookings" });
  }
});

app.get("/api/bookings/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [rows] = await db.promise().query(
      `SELECT b.*, u.unit_number, u.unit_type, t.tower_name
       FROM BOOKING b
       LEFT JOIN UNIT u ON u.unit_id = b.unit_id
       LEFT JOIN TOWER t ON t.tower_id = u.tower_id
       WHERE b.booking_id = ?`,
      [id]
    );
    if (!rows || rows.length === 0) return res.status(404).json({ error: "Booking not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch booking" });
  }
});

app.post("/api/bookings", async (req, res) => {
  try {
    const {
      unit_id,
      guest_name,
      permanent_address,
      age,
      nationality,
      relation_to_owner,
      occupation,
      email,
      contact_number,
      owner_name,
      owner_contact,
      inclusive_dates,
      check_in_date,
      check_out_date,
      purpose_of_stay,
      paid_yes_no,
      amount_paid,
      booking_platform,
      payment_method,
      id_document,
      payment_proof,
      signature_data,
    } = req.body;
    if (!unit_id || !guest_name || !email)
      return res.status(400).json({ error: "unit_id, guest_name, and email required" });

    await db.promise().query(
      `INSERT INTO BOOKING (
        unit_id, guest_name, permanent_address, age, nationality, relation_to_owner, occupation,
        email, contact_number, owner_name, owner_contact, inclusive_dates, check_in_date, check_out_date,
        purpose_of_stay, paid_yes_no, amount_paid, booking_platform, payment_method,
        id_document, payment_proof, signature_data, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [
        Number(unit_id),
        String(guest_name || "").trim(),
        permanent_address ? String(permanent_address).trim() : null,
        age ? String(age).trim() : null,
        nationality ? String(nationality).trim() : null,
        relation_to_owner ? String(relation_to_owner).trim() : null,
        occupation ? String(occupation).trim() : null,
        String(email || "").trim(),
        contact_number ? String(contact_number).trim() : null,
        owner_name ? String(owner_name).trim() : null,
        owner_contact ? String(owner_contact).trim() : null,
        inclusive_dates ? String(inclusive_dates).trim() : null,
        check_in_date || null,
        check_out_date || null,
        purpose_of_stay ? String(purpose_of_stay).trim() : null,
        paid_yes_no ? String(paid_yes_no).trim() : null,
        amount_paid != null && amount_paid !== "" ? String(amount_paid).trim() : null,
        booking_platform ? String(booking_platform).trim() : null,
        payment_method ? String(payment_method).trim() : null,
        id_document || null,
        payment_proof || null,
        signature_data || null,
      ]
    );
    const [r] = await db.promise().query("SELECT LAST_INSERT_ID() AS id");
    res.status(201).json({ message: "Booking submitted", booking_id: r[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to submit booking" });
  }
});

// Serve QR code image for a booking (used in confirmation email so clients display it inline)
app.get("/api/bookings/:id/qr", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const payload = JSON.stringify({ booking_id: id, type: "check-in" });
    const dataUrl = await QRCode.toDataURL(payload, { type: "image/png", margin: 2, width: 260 });
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(base64, "base64");
    res.type("png").set("Cache-Control", "public, max-age=86400").send(buffer);
  } catch (err) {
    console.error(err);
    res.status(500).send("QR generation failed");
  }
});

app.put("/api/bookings/:id/confirm", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [result] = await db.promise().query("UPDATE BOOKING SET status = 'confirmed', rejection_reason = NULL WHERE booking_id = ?", [id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: "Booking not found" });

    // Fetch booking for email
    const [rows] = await db.promise().query(
      `SELECT b.booking_id, b.guest_name, b.email, b.check_in_date, b.check_out_date, u.unit_number, t.tower_name
       FROM BOOKING b
       LEFT JOIN UNIT u ON u.unit_id = b.unit_id
       LEFT JOIN TOWER t ON t.tower_id = u.tower_id
       WHERE b.booking_id = ?`,
      [id]
    );
    const booking = rows[0];
    let emailSent = false;
    let emailError = null;

    if (!booking || !booking.email) {
      emailError = "No guest email on this booking.";
      console.log("Confirm: no guest email for booking " + id + " – email not sent. Add guest email when creating the booking.");
    } else if (!BREVO_API_KEY) {
      emailError = "Brevo not configured (missing BREVO_API_KEY).";
      console.log("Confirm: BREVO_API_KEY missing – email not sent to " + booking.email);
    } else {
      try {
        const toEmail = booking.email.trim();
        console.log("Sending confirmation email to " + toEmail + " for booking " + id + "...");
        const senderEmail = process.env.BREVO_FROM_EMAIL || "regalia@example.com";
        const senderName = process.env.BREVO_FROM_NAME || "Regalia";
        const baseUrl = (process.env.APP_URL || "").replace(/\/$/, "") || "https://regalia-eon6.onrender.com";
        const qrImageUrl = baseUrl + "/api/bookings/" + id + "/qr";
        const bookingRef = "REG-" + String(id).padStart(5, "0");
        const checkInStr = formatDateForEmail(booking.check_in_date);
        const checkOutStr = formatDateForEmail(booking.check_out_date);
        const nights = getNights(booking.check_in_date, booking.check_out_date);
        const stayDatesText = nights > 0 ? checkInStr + " — " + checkOutStr + " (" + nights + " Night" + (nights !== 1 ? "s" : "") + ")" : checkInStr + " — " + checkOutStr;
        const html = buildConfirmationEmailHtml({
          guestName: escapeHtml(booking.guest_name || "Guest"),
          bookingRef,
          unitNumber: escapeHtml(booking.unit_number || "—"),
          towerName: escapeHtml(booking.tower_name || "—"),
          stayDatesText: escapeHtml(stayDatesText),
          qrImageUrl,
        });
        const brevoRes = await fetch("https://api.brevo.com/v3/smtp/email", {
          method: "POST",
          headers: {
            "accept": "application/json",
            "content-type": "application/json",
            "api-key": BREVO_API_KEY,
          },
          body: JSON.stringify({
            sender: { name: senderName, email: senderEmail },
            to: [{ email: toEmail }],
            subject: "Booking confirmed – Regalia",
            htmlContent: html,
          }),
        });
        const brevoData = await brevoRes.json().catch(() => ({}));
        if (!brevoRes.ok) {
          emailError = brevoData.message || "Brevo API error " + brevoRes.status;
          console.error("Brevo error:", brevoRes.status, JSON.stringify(brevoData));
        } else {
          emailSent = true;
          console.log("Confirmation email sent to " + toEmail + " (messageId: " + (brevoData.messageId || "ok") + ")");
        }
      } catch (emailErr) {
        emailError = emailErr.message || "Email send failed.";
        console.error("Confirm email send failed:", emailErr.message || emailErr);
      }
    }

    res.json({ message: "Booking confirmed", emailSent, emailError });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to confirm" });
  }
});

// Staff: resend confirmation email with QR (for already confirmed booking)
app.post("/api/bookings/:id/resend-qr", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [rows] = await db.promise().query(
      `SELECT b.booking_id, b.guest_name, b.email, b.check_in_date, b.check_out_date, u.unit_number, t.tower_name
       FROM BOOKING b
       LEFT JOIN UNIT u ON u.unit_id = b.unit_id
       LEFT JOIN TOWER t ON t.tower_id = u.tower_id
       WHERE b.booking_id = ? AND b.status = 'confirmed'`,
      [id]
    );
    const booking = rows[0];
    if (!booking) return res.status(404).json({ error: "Booking not found or not confirmed" });
    if (!booking.email || !BREVO_API_KEY) {
      return res.json({ sent: false, message: "No email or Brevo not configured" });
    }
    const baseUrl = (process.env.APP_URL || "").replace(/\/$/, "") || "https://regalia-eon6.onrender.com";
    const qrImageUrl = baseUrl + "/api/bookings/" + id + "/qr";
    const bookingRef = "REG-" + String(id).padStart(5, "0");
    const checkInStr = formatDateForEmail(booking.check_in_date);
    const checkOutStr = formatDateForEmail(booking.check_out_date);
    const nights = getNights(booking.check_in_date, booking.check_out_date);
    const stayDatesText = nights > 0 ? checkInStr + " — " + checkOutStr + " (" + nights + " Night" + (nights !== 1 ? "s" : "") + ")" : checkInStr + " — " + checkOutStr;
    const html = buildConfirmationEmailHtml({
      guestName: escapeHtml(booking.guest_name || "Guest"),
      bookingRef,
      unitNumber: escapeHtml(booking.unit_number || "—"),
      towerName: escapeHtml(booking.tower_name || "—"),
      stayDatesText: escapeHtml(stayDatesText),
      qrImageUrl,
    });
    const senderEmail = process.env.BREVO_FROM_EMAIL || "regalia@example.com";
    const senderName = process.env.BREVO_FROM_NAME || "Regalia";
    const brevoRes = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "accept": "application/json", "content-type": "application/json", "api-key": BREVO_API_KEY },
      body: JSON.stringify({
        sender: { name: senderName, email: senderEmail },
        to: [{ email: booking.email.trim() }],
        subject: "Your Regalia entry pass (resend)",
        htmlContent: html,
      }),
    });
    const brevoData = await brevoRes.json().catch(() => ({}));
    if (!brevoRes.ok) return res.status(500).json({ error: brevoData.message || "Email send failed" });
    res.json({ message: "QR email resent", sent: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to resend" });
  }
});

function formatDateForEmail(d) {
  if (!d) return "";
  const date = new Date(d);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return months[date.getMonth()] + " " + date.getDate() + ", " + date.getFullYear();
}

function getNights(checkIn, checkOut) {
  if (!checkIn || !checkOut) return 0;
  const a = new Date(checkIn);
  const b = new Date(checkOut);
  return Math.max(0, Math.round((b - a) / (24 * 60 * 60 * 1000)));
}

function buildConfirmationEmailHtml(data) {
  const { guestName, bookingRef, unitNumber, towerName, stayDatesText, qrImageUrl } = data;
  const primary = "#0098b2";
  const accent = "#7ed957";
  const bgLight = "#f5f8f8";
  const slate900 = "#0f172a";
  const slate500 = "#64748b";
  const slate400 = "#94a3b8";
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Booking Confirmed – Regalia</title>
</head>
<body style="margin:0;padding:0;background-color:${bgLight};font-family:Inter,Helvetica,Arial,sans-serif;color:${slate900};min-height:100vh;">
  <div style="max-width:800px;margin:0 auto;min-height:100vh;box-shadow:0 1px 3px rgba(0,0,0,0.08);background:#fff;">
    <header style="display:flex;align-items:center;justify-content:space-between;padding:24px 32px;border-bottom:1px solid rgba(0,152,178,0.15);flex-wrap:wrap;gap:12px;">
      <div style="display:flex;align-items:center;gap:12px;">
        <div style="width:40px;height:40px;background:rgba(0,152,178,0.12);display:flex;align-items:center;justify-content:center;border-radius:8px;font-size:24px;">🏢</div>
        <h1 style="margin:0;font-size:1.5rem;font-weight:700;letter-spacing:-0.025em;color:${slate900};">Regalia</h1>
      </div>
      <div style="font-size:14px;color:${slate500};">Booking Ref: #${bookingRef}</div>
    </header>
    <main style="padding:40px 24px 40px 48px;">
      <div style="text-align:center;margin-bottom:40px;">
        <div style="display:inline-flex;align-items:center;justify-content:center;width:64px;height:64px;background:rgba(126,217,87,0.2);border-radius:9999px;margin-bottom:16px;font-size:40px;">✓</div>
        <h2 style="margin:0 0 8px;font-size:2rem;font-weight:700;color:${slate900};">Booking Confirmed!</h2>
        <p style="margin:0;color:${slate500};font-size:1.125rem;">Your stay at Regalia is officially reserved. We look forward to hosting you.</p>
      </div>
      <div style="background:#fff;border:1px solid rgba(0,152,178,0.12);border-radius:12px;box-shadow:0 10px 15px -3px rgba(0,0,0,0.06);overflow:hidden;margin-bottom:40px;">
        <div style="padding:32px;display:flex;flex-direction:column;align-items:center;border-bottom:1px solid rgba(0,152,178,0.06);">
          <div style="width:192px;height:192px;background:#fff;padding:16px;border:2px solid #f1f5f9;border-radius:12px;margin-bottom:24px;">
            <img src="${qrImageUrl}" alt="Booking QR Code" width="160" height="160" style="display:block;width:100%;height:100%;object-fit:contain;"/>
          </div>
          <h3 style="margin:0 0 4px;font-size:1.25rem;font-weight:700;">Your Digital Entry Pass</h3>
          <p style="margin:0 0 20px;color:${slate500};text-align:center;font-size:14px;max-width:360px;">Scan this QR code at the tower entrance or lift lobby to gain access to the premises.</p>
          <table cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
            <tr>
              <td style="padding:0 8px 0 0;"><a href="${qrImageUrl}" download="regalia-entry-pass.png" style="display:inline-block;background:linear-gradient(90deg,#0098b2 0%,#7ed957 100%);color:#fff!important;padding:12px 24px;border-radius:8px;font-weight:600;text-decoration:none;font-size:14px;">Download Pass</a></td>
              <td style="padding:0 0 0 8px;"><a href="${qrImageUrl}" target="_blank" style="display:inline-block;background:#e2e8f0;color:#334155!important;padding:12px 24px;border-radius:8px;font-weight:600;text-decoration:none;font-size:14px;">View in App</a></td>
            </tr>
          </table>
        </div>
        <div style="padding:32px;background:rgba(0,152,178,0.05);">
          <h4 style="margin:0 0 24px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:${primary};">Booking Details</h4>
          <table style="width:100%;border-collapse:collapse;">
            <tr>
              <td style="padding:8px 0;vertical-align:top;width:50%;">
                <span style="display:block;font-size:11px;font-weight:500;text-transform:uppercase;color:${slate400};margin-bottom:4px;">Guest Name</span>
                <span style="font-weight:600;color:${slate900};">${guestName}</span>
              </td>
              <td style="padding:8px 0;vertical-align:top;width:50%;">
                <span style="display:block;font-size:11px;font-weight:500;text-transform:uppercase;color:${slate400};margin-bottom:4px;">Property / Tower</span>
                <span style="font-weight:600;color:${slate900};">${towerName}</span>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 0;vertical-align:top;">
                <span style="display:block;font-size:11px;font-weight:500;text-transform:uppercase;color:${slate400};margin-bottom:4px;">Unit Number</span>
                <span style="font-weight:600;color:${slate900};">${unitNumber}</span>
              </td>
              <td style="padding:8px 0;vertical-align:top;">
                <span style="display:block;font-size:11px;font-weight:500;text-transform:uppercase;color:${slate400};margin-bottom:4px;">Stay Dates</span>
                <span style="font-weight:600;color:${slate900};">${stayDatesText}</span>
              </td>
            </tr>
          </table>
        </div>
      </div>
      <div style="background:#f8fafc;border-radius:8px;padding:24px;display:flex;flex-wrap:wrap;align-items:center;gap:16px;">
        <div style="background:rgba(0,152,178,0.12);width:48px;height:48px;border-radius:9999px;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;">ℹ</div>
        <div style="flex:1;min-width:200px;">
          <p style="margin:0 0 4px;font-size:14px;font-weight:500;color:${slate900};">Important Note:</p>
          <p style="margin:0;font-size:12px;color:${slate500};">Check-in time starts at 3:00 PM. Please ensure you have a valid ID matching your booking name for verification by security. <a href="#" style="color:${primary};font-weight:700;">House Rules</a></p>
        </div>
      </div>
    </main>
    <footer style="padding:40px 32px;background:#f8fafc;border-top:1px solid #f1f5f9;text-align:center;">
      <p style="margin:0 0 16px;color:${slate400};font-size:14px;">&#9432; &nbsp; &#9993; &nbsp; &#9742;</p>
      <p style="margin:0 0 8px;color:${slate500};font-size:14px;">Need assistance with your booking?</p>
      <p style="margin:0 0 32px;color:${slate400};font-size:12px;">Contact our 24/7 support at support@regalia.com or call +1 (800) REGALIA</p>
      <div style="opacity:0.6;margin-bottom:16px;">
        <span style="font-weight:700;">Regalia</span>
      </div>
      <p style="margin:0;font-size:10px;color:${slate400};text-transform:uppercase;letter-spacing:0.05em;">© ${new Date().getFullYear()} Regalia Premium Condominiums. All rights reserved.</p>
    </footer>
  </div>
</body>
</html>`;
}

function escapeHtml(s) {
  if (s == null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

app.put("/api/bookings/:id/reject", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { reason } = req.body;
    const [result] = await db.promise().query(
      "UPDATE BOOKING SET status = 'rejected', rejection_reason = ? WHERE booking_id = ?",
      [reason ? String(reason).trim() : null, id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: "Booking not found" });
    res.json({ message: "Booking rejected" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to reject" });
  }
});

// Staff: record check-in (requires BOOKING.checked_in_at column)
app.post("/api/bookings/:id/check-in", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [result] = await db.promise().query(
      "UPDATE BOOKING SET checked_in_at = COALESCE(checked_in_at, NOW()) WHERE booking_id = ? AND status = 'confirmed'",
      [id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: "Booking not found or not confirmed" });
    const [rows] = await db.promise().query(
      "SELECT booking_id, guest_name, unit_id, checked_in_at FROM BOOKING WHERE booking_id = ?",
      [id]
    );
    res.json({ message: "Check-in recorded", booking: rows[0] });
  } catch (err) {
    if (err.code === "ER_BAD_FIELD_ERROR") return res.status(500).json({ error: "Add checked_in_at DATETIME NULL to BOOKING table" });
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to record check-in" });
  }
});

// Staff: record check-out (requires BOOKING.checked_out_at column)
app.post("/api/bookings/:id/check-out", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [result] = await db.promise().query(
      "UPDATE BOOKING SET checked_out_at = COALESCE(checked_out_at, NOW()) WHERE booking_id = ? AND status = 'confirmed'",
      [id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: "Booking not found or not confirmed" });
    const [rows] = await db.promise().query(
      "SELECT booking_id, guest_name, unit_id, checked_out_at FROM BOOKING WHERE booking_id = ?",
      [id]
    );
    res.json({ message: "Check-out recorded", booking: rows[0] });
  } catch (err) {
    if (err.code === "ER_BAD_FIELD_ERROR") return res.status(500).json({ error: "Add checked_out_at DATETIME NULL to BOOKING table" });
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to record check-out" });
  }
});

// ---------------- Catch-all for frontend routing ----------------
// Fixes Render Node v22+ "Missing parameter name at index 1: *" error
app.get(/^\/.*$/, (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend", "index.html"));
});

// ---------------- Start Server ----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
