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
app.get("/api/bookings", async (req, res) => {
  try {
    const [rows] = await db.promise().query(
      `SELECT b.booking_id, b.unit_id, b.guest_name, b.email, b.contact_number, b.check_in_date, b.check_out_date,
        b.inclusive_dates, b.status, b.rejection_reason, b.created_at,
        u.unit_number, u.unit_type, t.tower_name
       FROM BOOKING b
       LEFT JOIN UNIT u ON u.unit_id = b.unit_id
       LEFT JOIN TOWER t ON t.tower_id = u.tower_id
       ORDER BY b.check_in_date ASC, b.created_at DESC`
    );
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
    if (!booking || !booking.email) {
      console.log("Confirm: no guest email for booking " + id + " – email not sent. Add guest email when creating the booking.");
    } else if (!BREVO_API_KEY) {
      console.log("Confirm: BREVO_API_KEY missing – email not sent to " + booking.email);
    } else {
      try {
        const toEmail = booking.email.trim();
        console.log("Sending confirmation email to " + toEmail + " for booking " + id + "...");
        const checkInPayload = JSON.stringify({ booking_id: id, type: "check-in" });
        const qrPng = await QRCode.toDataURL(checkInPayload, { type: "image/png", margin: 2, width: 260 });
        const senderEmail = process.env.BREVO_FROM_EMAIL || "regalia@example.com";
        const senderName = process.env.BREVO_FROM_NAME || "Regalia";
        const html = `
          <h2>Booking confirmed</h2>
          <p>Hi ${escapeHtml(booking.guest_name || "Guest")},</p>
          <p>Your booking has been confirmed.</p>
          <ul>
            <li><strong>Unit:</strong> ${escapeHtml(booking.unit_number || "")} ${escapeHtml(booking.tower_name || "")}</li>
            <li><strong>Check-in:</strong> ${escapeHtml(String(booking.check_in_date || ""))}</li>
            <li><strong>Check-out:</strong> ${escapeHtml(String(booking.check_out_date || ""))}</li>
          </ul>
          <p>Use the QR code below at check-in and check-out:</p>
          <p><img src="${qrPng}" alt="Booking QR Code" width="260" height="260" style="display:block;margin:1rem 0;" /></p>
          <p>Booking ID: ${id}</p>
          <p>— Regalia</p>
        `;
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
          console.error("Brevo error:", brevoRes.status, JSON.stringify(brevoData));
        } else {
          console.log("Confirmation email sent to " + toEmail + " (messageId: " + (brevoData.messageId || "ok") + ")");
        }
      } catch (emailErr) {
        console.error("Confirm email send failed:", emailErr.message || emailErr);
      }
    }

    res.json({ message: "Booking confirmed" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to confirm" });
  }
});

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

// ---------------- Catch-all for frontend routing ----------------
// Fixes Render Node v22+ "Missing parameter name at index 1: *" error
app.get(/^\/.*$/, (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend", "index.html"));
});

// ---------------- Start Server ----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
