// ==================== server.js ====================
const express = require("express");
const cors = require("cors");
const mysql = require("mysql2");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const path = require("path");
require("dotenv").config();

const app = express();

// ---------------- Middleware ----------------
app.use(cors());
app.use(express.json()); // Parse JSON bodies

// ---------------- DB Connection ----------------
const fs = require("fs");
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
    res.status(500).json({ error: "Failed to create tower" });
  }
});

// ---------------- Units (ERD: UNIT – linked to TOWER) ----------------
app.get("/api/units", async (req, res) => {
  try {
    const [rows] = await db.promise().query(
      `SELECT u.unit_id, u.tower_id, u.unit_number, u.floor_number, u.unit_type, u.unit_size, u.description,
        t.tower_name
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

app.post("/api/units", async (req, res) => {
  try {
    const { tower_id, unit_number, floor_number, unit_type, unit_size, description } = req.body;
    if (!tower_id || !unit_number)
      return res.status(400).json({ error: "tower_id and unit_number required" });
    const [result] = await db.promise().query(
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
    res.status(500).json({ error: "Failed to create unit" });
  }
});

// ---------------- Properties = units with tower (for admin list) ----------------
app.get("/api/properties", async (req, res) => {
  try {
    const [rows] = await db.promise().query(
      `SELECT u.unit_id, u.tower_id, u.unit_number, u.floor_number, u.unit_type, u.unit_size, u.description,
        t.tower_name, t.number_floors
       FROM UNIT u
       LEFT JOIN TOWER t ON t.tower_id = u.tower_id
       ORDER BY t.tower_name, u.floor_number, u.unit_number`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch properties" });
  }
});

// ---------------- Employees (ERD: EMPLOYEE + EMPLOYEE_ROLE) ----------------
app.get("/api/employees", async (req, res) => {
  try {
    const [rows] = await db.promise().query(
      `SELECT e.employee_id, e.full_name, e.username, e.contact_number, e.email, e.address,
        (SELECT r.role_type FROM EMPLOYEE_ROLE r WHERE r.employee_id = e.employee_id AND r.status = 'active' ORDER BY r.role_id DESC LIMIT 1) AS role_type,
        (SELECT t.tower_name FROM EMPLOYEE_TOWER et JOIN TOWER t ON t.tower_id = et.tower_id WHERE et.employee_id = e.employee_id LIMIT 1) AS assigned_tower
       FROM EMPLOYEE e
       ORDER BY e.full_name`
    );
    res.json(rows);
  } catch (err) {
    if (err.code === "ER_NO_SUCH_TABLE" && err.message.includes("EMPLOYEE_TOWER")) {
      const [rows] = await db.promise().query(
        `SELECT e.employee_id, e.full_name, e.username, e.contact_number, e.email, e.address,
          (SELECT r.role_type FROM EMPLOYEE_ROLE r WHERE r.employee_id = e.employee_id AND r.status = 'active' ORDER BY r.role_id DESC LIMIT 1) AS role_type
         FROM EMPLOYEE e ORDER BY e.full_name`
      );
      return res.json(rows.map(r => ({ ...r, assigned_tower: null })));
    }
    console.error(err);
    res.status(500).json({ error: "Failed to fetch employees" });
  }
});

app.post("/api/employees", async (req, res) => {
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
    const [result] = await db.promise().query(
      "INSERT INTO EMPLOYEE (full_name, address, username, password, contact_number, email) VALUES (?, ?, ?, ?, ?, ?)",
      [full_name, address || null, username, hashedPassword, contact_number || null, email]
    );
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

// Assign employee to tower (optional EMPLOYEE_TOWER table)
app.put("/api/employees/:id/assign-tower", async (req, res) => {
  try {
    const employeeId = Number(req.params.id);
    const { tower_id } = req.body;
    if (!tower_id) return res.status(400).json({ error: "tower_id required" });

    await db.promise().query(
      "DELETE FROM EMPLOYEE_TOWER WHERE employee_id = ?",
      [employeeId]
    );
    await db.promise().query(
      "INSERT INTO EMPLOYEE_TOWER (employee_id, tower_id) VALUES (?, ?)",
      [employeeId, Number(tower_id)]
    );
    res.json({ message: "Assignment saved" });
  } catch (err) {
    if (err.code === "ER_NO_SUCH_TABLE" && err.message.includes("EMPLOYEE_TOWER")) {
      return res.status(501).json({ error: "EMPLOYEE_TOWER table not found. Add it in Aiven (see README or schema)." });
    }
    console.error(err);
    res.status(500).json({ error: "Failed to assign tower" });
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
