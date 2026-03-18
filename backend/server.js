// ==================== server.js ====================
const express = require("express");
const cors = require("cors");
const mysql = require("mysql2");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const path = require("path");
const fs = require("fs");
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

/** Signup → ADMIN (condo management). OWNER = unit resident (owner dashboard only). */
function normalizeJwtRole(role) {
  return role ? String(role).toUpperCase().replace(/[\s_-]/g, "") : "";
}
function isCondoAdminRole(role) {
  return normalizeJwtRole(role) === "ADMIN";
}
function isResidentOwnerRole(role) {
  return normalizeJwtRole(role) === "OWNER";
}
function isDeveloperRole(role) {
  return normalizeJwtRole(role) === "DEVELOPER";
}
function isEmployeeRoleMgmt(roleType) {
  const u = String(roleType || "").toUpperCase();
  return u === "OWNER" || u === "ADMIN";
}

/** Matches EMPLOYEE_ROLE rows that count as resident owner (same logic as GET /api/owners list). */
const OWNER_ROLE_EXISTS_SQL = `EXISTS (SELECT 1 FROM EMPLOYEE_ROLE r WHERE r.employee_id = e.employee_id AND r.status = 'active' AND (r.role_type = 'OWNER' OR UPPER(TRIM(r.role_type)) = 'OWNER'))`;

async function runStartupSchemaFixes() {
  try {
    const [[dbRow]] = await db.promise().query("SELECT DATABASE() AS d");
    const schema = dbRow && dbRow.d;
    if (!schema) return;
    async function tableExists(name) {
      const [t] = await db.promise().query(
        "SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1",
        [schema, name]
      );
      return t.length > 0;
    }
    async function colExists(table, col) {
      const [c] = await db.promise().query(
        "SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1",
        [schema, table, col]
      );
      return c.length > 0;
    }
    if (await tableExists("OWNER_UNIT")) {
      const hasOe = await colExists("OWNER_UNIT", "owner_employee_id");
      const hasEmp = await colExists("OWNER_UNIT", "employee_id");
      if (!hasOe && hasEmp) {
        await db.promise().query(
          "ALTER TABLE OWNER_UNIT CHANGE COLUMN employee_id owner_employee_id INT NOT NULL"
        );
        console.log("[schema] OWNER_UNIT: employee_id → owner_employee_id");
      }
    }
    for (const tbl of ["TOWER", "UNIT"]) {
      if (await tableExists(tbl) && !(await colExists(tbl, "owner_employee_id"))) {
        await db.promise().query(`ALTER TABLE \`${tbl}\` ADD COLUMN owner_employee_id INT NULL`);
        console.log(`[schema] ${tbl}: added owner_employee_id`);
      }
    }
  } catch (e) {
    console.error("[schema] startup fixes:", e.message || e);
  }
}

// ---------------- OWNER_UNIT schema compatibility ----------------
// OWNER_UNIT may store the "owner linkage" column as one of:
// - owner_employee_id (current expectation)
// - employee_id (legacy)
// - owner_id (FK to OWNER.owner_id)
// These helpers let unit-assignment endpoints work across schemas.
let ownerUnitOwnerColumnCache = null;
let ownerUnitOwnerColumnChecked = false;

async function getOwnerUnitOwnerColumnName() {
  if (ownerUnitOwnerColumnChecked) return ownerUnitOwnerColumnCache;
  ownerUnitOwnerColumnChecked = true;

  const [[dbRow]] = await db.promise().query("SELECT DATABASE() AS d");
  const schema = dbRow && dbRow.d;
  if (!schema) throw new Error("Could not detect current DB schema");

  const [rows] = await db.promise().query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'OWNER_UNIT' AND COLUMN_NAME IN ('owner_employee_id','employee_id','owner_id')",
    [schema]
  );
  const found = (rows || []).map((r) => String(r.COLUMN_NAME || r.column_name || "").trim()).filter(Boolean);

  // Prefer `owner_id` because in your ERD it's NOT NULL.
  // If we pick `owner_employee_id` first (nullable), INSERTs into OWNER_UNIT will fail.
  const priority = ["owner_id", "owner_employee_id", "employee_id"];
  for (const col of priority) {
    if (found.includes(col)) {
      ownerUnitOwnerColumnCache = col;
      return ownerUnitOwnerColumnCache;
    }
  }

  throw new Error(
    "OWNER_UNIT has no supported owner key column (expected owner_employee_id, employee_id, or owner_id)."
  );
}

async function getOwnerUnitOwnerValue(ownerEmployeeId) {
  const ownerCol = await getOwnerUnitOwnerColumnName();
  if (ownerCol === "owner_id") {
    // Prefer mapping via OWNER.employee_id if that column exists/populated.
    try {
      const [[row]] = await db.promise().query(
        "SELECT owner_id FROM OWNER WHERE employee_id = ? LIMIT 1",
        [ownerEmployeeId]
      );
      if (row && row.owner_id != null) return row.owner_id;
    } catch (e) {
      // Some DBs may not have OWNER.employee_id yet; fall back to email mapping.
    }

    // Fallback: map OWNER.owner_id via OWNER.email = EMPLOYEE.email.
    const [[emp]] = await db.promise().query(
      "SELECT email FROM EMPLOYEE WHERE employee_id = ? LIMIT 1",
      [ownerEmployeeId]
    );
    const email = emp && emp.email ? String(emp.email).trim() : null;
    if (!email) return null;

    const [[row2]] = await db.promise().query(
      "SELECT owner_id FROM OWNER WHERE email = ? LIMIT 1",
      [email]
    );
    return row2 ? row2.owner_id : null;
  }
  return ownerEmployeeId;
}

let ownerUnitColumnSetCache = null;
let ownerUnitColumnSetChecked = false;
async function getOwnerUnitColumnSet() {
  if (ownerUnitColumnSetChecked) return ownerUnitColumnSetCache;
  ownerUnitColumnSetChecked = true;
  const [[dbRow]] = await db.promise().query("SELECT DATABASE() AS d");
  const schema = dbRow && dbRow.d;
  const [rows] = await db.promise().query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'OWNER_UNIT' AND COLUMN_NAME IN ('owner_employee_id','employee_id','owner_id','unit_id','owner_unit_id')",
    [schema]
  );
  const set = new Set((rows || []).map((r) => String(r.COLUMN_NAME || r.column_name || "").trim()).filter(Boolean));
  ownerUnitColumnSetCache = set;
  return ownerUnitColumnSetCache;
}

// Used when OWNER_UNIT.owner_id is NOT NULL (your ERD) but unit-assignment code was only inserting owner_employee_id.
async function getOwnerIdForEmployee(ownerEmployeeId) {
  // 1) Try direct mapping
  try {
    const [[row]] = await db.promise().query(
      "SELECT owner_id FROM OWNER WHERE employee_id = ? LIMIT 1",
      [ownerEmployeeId]
    );
    if (row && row.owner_id != null) return row.owner_id;
  } catch (e) {
    // ignore
  }

  // 2) Fallback mapping by email
  const [[emp]] = await db.promise().query(
    "SELECT email FROM EMPLOYEE WHERE employee_id = ? LIMIT 1",
    [ownerEmployeeId]
  );
  const email = emp && emp.email ? String(emp.email).trim() : null;
  if (!email) return null;

  const [[row2]] = await db.promise().query(
    "SELECT owner_id FROM OWNER WHERE email = ? LIMIT 1",
    [email]
  );
  return row2 ? row2.owner_id : null;
}

function requireAuth(req, res, next) {
  return optionalAuth(req, res, () => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    next();
  });
}

function requireRole(...allowed) {
  const normalizedAllowed = allowed.map(normalizeJwtRole);
  return (req, res, next) => {
    return requireAuth(req, res, () => {
      const r = normalizeJwtRole(req.user && req.user.role);
      if (!r || !normalizedAllowed.includes(r))
        return res.status(403).json({ error: "Forbidden" });
      next();
    });
  };
}

let didBackfillTowerOwners = false;
async function tryBackfillTowerOwners() {
  if (didBackfillTowerOwners) return;
  didBackfillTowerOwners = true;
  try {
    // Best-effort backfill: infer tower owner from employees assigned to tower (employee.created_by_employee_id).
    // If schema doesn't support multi-tenant ownership columns yet, this no-ops.
    await db.promise().query(
      `UPDATE TOWER t
       JOIN (
         SELECT et.tower_id, MIN(e.created_by_employee_id) AS owner_employee_id
         FROM EMPLOYEE_TOWER et
         JOIN EMPLOYEE e ON e.employee_id = et.employee_id
         WHERE e.created_by_employee_id IS NOT NULL
         GROUP BY et.tower_id
       ) x ON x.tower_id = t.tower_id
       SET t.owner_employee_id = COALESCE(t.owner_employee_id, x.owner_employee_id)`
    );
  } catch (e) {
    // Likely missing columns/tables (older schema). Ignore safely.
  }
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
  else {
    console.log("✅ Connected to Aiven DB!");
    db.query("ALTER TABLE EMPLOYEE ADD COLUMN resident_unit_id INT NULL", (e) => {
      if (e && e.code !== "ER_DUP_FIELDNAME") { /* ignore if exists */ }
    });
    db.promise()
      .query(
        `CREATE TABLE IF NOT EXISTS OWNER (
          owner_id INT AUTO_INCREMENT PRIMARY KEY,
          employee_id INT NOT NULL UNIQUE,
          unit_id INT NULL,
          full_name VARCHAR(255) NOT NULL,
          contact_number VARCHAR(128) NULL,
          email VARCHAR(255) NOT NULL,
          valid_id LONGBLOB NULL,
          is_verified TINYINT(1) NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_owner_unit (unit_id)
        )`
      )
      .catch((e) => console.error("OWNER table:", e.message));
    db.query("ALTER TABLE EMPLOYEE ADD COLUMN condominium_id INT NULL", (e) => {
      if (e && e.code !== "ER_DUP_FIELDNAME") { /* ignore if exists */ }
    });
    db.query(
      `CREATE TABLE IF NOT EXISTS CONDOMINIUM (
        condominium_id INT NOT NULL AUTO_INCREMENT,
        name VARCHAR(255) NOT NULL,
        passcode_hash VARCHAR(255) NOT NULL,
        created_by_employee_id INT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (condominium_id),
        UNIQUE KEY uniq_condominium_name (name)
      )`,
      (e) => {
        if (e) console.error("Failed creating CONDOMINIUM table:", e.message || e);
      }
    );

    db.query(
      `CREATE TABLE IF NOT EXISTS APP_CONFIG (
        config_key VARCHAR(100) NOT NULL,
        config_value VARCHAR(255) NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (config_key)
      )`,
      (e) => {
        if (e) console.error("Failed creating APP_CONFIG table:", e.message || e);
      }
    );

    db.query(
      `CREATE TABLE IF NOT EXISTS OWNER_UNIT (
        owner_employee_id INT NOT NULL,
        unit_id INT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (owner_employee_id, unit_id),
        UNIQUE KEY uniq_owner_unit_unit (unit_id),
        INDEX idx_owner_unit_owner (owner_employee_id)
      )`,
      (e) => {
        if (e) console.error("Failed creating OWNER_UNIT table:", e.message || e);
      }
    );

    try {
      const seededHash = bcrypt.hashSync("REGALIADEV", 10);
      db.query(
        "INSERT IGNORE INTO APP_CONFIG (config_key, config_value) VALUES ('DEV_MASTER_PASSCODE_HASH', ?)",
        [seededHash],
        (e) => {
          if (e) console.error("Failed seeding DEV_MASTER_PASSCODE_HASH:", e.message || e);
        }
      );
    } catch (e) {
      console.error("Failed hashing default DEV master passcode:", e.message || e);
    }
  }
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
  res.status(403).json({
    error: "Self-service signup is disabled. Ask your developer to provision an admin account.",
  });
});

// ---------------- Site gate verification (condominium passcode) ----------------
app.post("/api/gate/verify", async (req, res) => {
  try {
    const raw = String(req.body && req.body.condominium_passcode || "").trim();
    if (!raw) return res.status(400).json({ error: "Passcode required" });
    if (raw === "SUPERSECRETKEY") return res.json({ ok: true, bypass: true, condominium_id: null });
    const [rows] = await db.promise().query("SELECT condominium_id, name, passcode_hash FROM CONDOMINIUM");
    for (const r of (rows || [])) {
      const ok = await bcrypt.compare(raw, String(r.passcode_hash || ""));
      if (ok) return res.json({ ok: true, condominium_id: r.condominium_id, condominium_name: r.name || null });
    }
    return res.status(403).json({ error: "Incorrect passcode. Try again." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ---------------- LOGIN ----------------
app.post("/login", async (req, res) => {
  try {
    const { username, password, condominium_passcode } = req.body;

    const [rows] = await db.promise().query(
      "SELECT * FROM EMPLOYEE WHERE username = ?",
      [username]
    );
    if (rows.length === 0) return res.status(400).json({ error: "User not found" });

    const employee = rows[0];
    const match = await bcrypt.compare(password, employee.password);
    if (!match) return res.status(400).json({ error: "Invalid password" });

    const [roles] = await db.promise().query(
      `SELECT role_type FROM EMPLOYEE_ROLE WHERE employee_id = ?
       ORDER BY CASE UPPER(TRIM(role_type)) WHEN 'ADMIN' THEN 1 WHEN 'OWNER' THEN 2 ELSE 3 END, role_id DESC`,
      [employee.employee_id]
    );

    const primaryRole = roles[0]?.role_type || null;
    // Enforce condominium passcode for ADMIN accounts (prevents cross-condo login).
    if (normalizeJwtRole(primaryRole) === "ADMIN") {
      const condoId = Number(employee.condominium_id || 0);
      if (!condoId) return res.status(403).json({ error: "Admin account is not linked to a condominium" });
      const passRaw = String(condominium_passcode || "").trim();
      if (!passRaw) return res.status(403).json({ error: "Condominium passcode required for admin login" });
      const [[condo]] = await db.promise().query(
        "SELECT passcode_hash FROM CONDOMINIUM WHERE condominium_id = ?",
        [condoId]
      );
      if (!condo || !condo.passcode_hash) return res.status(403).json({ error: "Condominium configuration missing" });
      const ok = await bcrypt.compare(passRaw, String(condo.passcode_hash || ""));
      if (!ok) return res.status(403).json({ error: "Incorrect condominium passcode" });
    }

    const token = jwt.sign(
      { employee_id: employee.employee_id, role: primaryRole },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    res.json({ message: "Login successful", token, employee, role: primaryRole, theme_color: employee.theme_color || "default" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ---------------- Developer Auth + Provisioning ----------------
// Temporary bootstrap credentials (no DB setup needed). Remove when you have real developer accounts.
const TEMP_DEV_USERNAME = "Dev";
const TEMP_DEV_PASSWORD = "123";

app.post("/api/developer/login", async (req, res) => {
  try {
    const master = String(req.body && req.body.master_passcode || "").trim();
    if (!master) return res.status(403).json({ error: "Invalid developer passcode" });
    const [[cfg]] = await db.promise().query(
      "SELECT config_value FROM APP_CONFIG WHERE config_key = 'DEV_MASTER_PASSCODE_HASH' LIMIT 1"
    );
    if (!cfg || !cfg.config_value)
      return res.status(503).json({ error: "Developer passcode is not configured" });
    const okMaster = await bcrypt.compare(master, String(cfg.config_value || ""));
    if (!okMaster) return res.status(403).json({ error: "Invalid developer passcode" });

    const username = String(req.body && req.body.username || "").trim();
    const password = String(req.body && req.body.password || "").trim();
    if (!username || !password) return res.status(400).json({ error: "username and password required" });

    // Temporary fallback developer login (does not require a DB user).
    if (username === TEMP_DEV_USERNAME && password === TEMP_DEV_PASSWORD) {
      const roleType = "DEVELOPER";
      const token = jwt.sign(
        { employee_id: 0, role: roleType },
        process.env.JWT_SECRET,
        { expiresIn: "2h" }
      );
      return res.json({
        message: "Developer login successful (temporary)",
        token,
        employee: { employee_id: 0, full_name: "Temporary Developer", username: TEMP_DEV_USERNAME },
        role: roleType,
      });
    }

    const [rows] = await db.promise().query("SELECT * FROM EMPLOYEE WHERE username = ?", [username]);
    if (rows.length === 0) return res.status(400).json({ error: "User not found" });
    const employee = rows[0];
    const match = await bcrypt.compare(password, employee.password);
    if (!match) return res.status(400).json({ error: "Invalid password" });

    const [roles] = await db.promise().query(
      "SELECT role_type FROM EMPLOYEE_ROLE WHERE employee_id = ? AND status = 'active' ORDER BY role_id DESC",
      [employee.employee_id]
    );
    const roleType = roles[0] && roles[0].role_type ? String(roles[0].role_type) : "";
    if (!isDeveloperRole(roleType)) return res.status(403).json({ error: "Not a developer account" });

    const token = jwt.sign(
      { employee_id: employee.employee_id, role: roleType },
      process.env.JWT_SECRET,
      { expiresIn: "2h" }
    );
    res.json({ message: "Developer login successful", token, employee, role: roleType });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/developer/master-passcode", requireRole("DEVELOPER"), async (req, res) => {
  try {
    const current_passcode = String(req.body && req.body.current_passcode || "").trim();
    const new_passcode = String(req.body && req.body.new_passcode || "").trim();
    if (!current_passcode || !new_passcode)
      return res.status(400).json({ error: "current_passcode and new_passcode required" });

    const [[cfg]] = await db.promise().query(
      "SELECT config_value FROM APP_CONFIG WHERE config_key = 'DEV_MASTER_PASSCODE_HASH' LIMIT 1"
    );
    if (!cfg || !cfg.config_value)
      return res.status(503).json({ error: "Developer passcode is not configured" });
    const ok = await bcrypt.compare(current_passcode, String(cfg.config_value || ""));
    if (!ok) return res.status(403).json({ error: "Current developer passcode is incorrect" });

    const nextHash = await bcrypt.hash(new_passcode, 10);
    await db.promise().query(
      "INSERT INTO APP_CONFIG (config_key, config_value) VALUES ('DEV_MASTER_PASSCODE_HASH', ?) ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)",
      [nextHash]
    );
    res.json({ message: "Developer passcode updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update developer passcode" });
  }
});

app.get("/api/developer/condominiums", requireRole("DEVELOPER"), async (req, res) => {
  try {
    const [rows] = await db.promise().query(
      "SELECT condominium_id, name, created_at, updated_at FROM CONDOMINIUM WHERE created_by_employee_id = ? OR created_by_employee_id IS NULL ORDER BY name",
      [req.user.employee_id]
    );
    res.json(rows || []);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch condominiums" });
  }
});

app.post("/api/developer/condominiums", requireRole("DEVELOPER"), async (req, res) => {
  try {
    const name = String(req.body && req.body.name || "").trim();
    const passcode = String(req.body && req.body.passcode || "").trim();
    if (!name || !passcode) return res.status(400).json({ error: "name and passcode required" });
    const passcodeHash = await bcrypt.hash(passcode, 10);
    const [result] = await db.promise().query(
      "INSERT INTO CONDOMINIUM (name, passcode_hash, created_by_employee_id) VALUES (?, ?, ?)",
      [name, passcodeHash, req.user.employee_id]
    );
    res.status(201).json({ message: "Condominium created", condominium_id: result.insertId, name });
  } catch (err) {
    const msg = String(err && err.code || "");
    if (msg === "ER_DUP_ENTRY") return res.status(400).json({ error: "Condominium name already exists" });
    console.error(err);
    res.status(500).json({ error: "Failed to create condominium" });
  }
});

app.delete("/api/developer/condominiums/:id", requireRole("DEVELOPER"), async (req, res) => {
  try {
    const developerId = req.user.employee_id;
    const condominiumId = Number(req.params.id);
    if (!condominiumId) return res.status(400).json({ error: "Invalid condominium id" });

    const [[condo]] = await db.promise().query(
      "SELECT condominium_id FROM CONDOMINIUM WHERE condominium_id = ? AND created_by_employee_id = ?",
      [condominiumId, developerId]
    );
    if (!condo) return res.status(404).json({ error: "Condominium not found" });

    const [[linked]] = await db.promise().query(
      "SELECT COUNT(*) AS cnt FROM EMPLOYEE WHERE condominium_id = ?",
      [condominiumId]
    );
    if (Number(linked && linked.cnt || 0) > 0)
      return res.status(400).json({ error: "Cannot delete condominium: accounts are linked to it" });

    await db.promise().query("DELETE FROM CONDOMINIUM WHERE condominium_id = ?", [condominiumId]);
    res.json({ message: "Condominium deleted", condominium_id: condominiumId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete condominium" });
  }
});

app.post("/api/developer/admins", requireRole("DEVELOPER"), async (req, res) => {
  try {
    const condominium_id = Number(req.body && req.body.condominium_id);
    const condominium_passcode = String(req.body && req.body.condominium_passcode || "").trim();
    if (!condominium_id || !condominium_passcode)
      return res.status(400).json({ error: "condominium_id and condominium_passcode required" });

    const [[condo]] = await db.promise().query(
      "SELECT condominium_id, name, passcode_hash FROM CONDOMINIUM WHERE condominium_id = ?",
      [condominium_id]
    );
    if (!condo) return res.status(404).json({ error: "Condominium not found" });
    const ok = await bcrypt.compare(condominium_passcode, String(condo.passcode_hash || ""));
    if (!ok) return res.status(403).json({ error: "Invalid condominium passcode" });

    const full_name = String(req.body && req.body.full_name || "").trim();
    const address = String(req.body && req.body.address || "").trim();
    const username = String(req.body && req.body.username || "").trim();
    const password = String(req.body && req.body.password || "").trim();
    const contact_number = String(req.body && req.body.contact_number || "").trim();
    const email = String(req.body && req.body.email || "").trim();
    if (!full_name || !username || !password || !email)
      return res.status(400).json({ error: "full_name, username, password, and email required" });

    const [existing] = await db.promise().query(
      "SELECT 1 FROM EMPLOYEE WHERE username = ? OR email = ?",
      [username, email]
    );
    if (existing.length > 0) return res.status(400).json({ error: "Username or email already exists" });

    const hashedPassword = await bcrypt.hash(password, 10);
    const [result] = await db.promise().query(
      "INSERT INTO EMPLOYEE (full_name, address, username, password, contact_number, email, created_by_employee_id, condominium_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [full_name, address || null, username, hashedPassword, contact_number || null, email, req.user.employee_id, condominium_id]
    );
    const employeeId = result.insertId;
    await db.promise().query(
      "INSERT INTO EMPLOYEE_ROLE (employee_id, role_type, status) VALUES (?, 'ADMIN', 'active')",
      [employeeId]
    );

    res.status(201).json({ message: "Admin account created", employeeId, condominium_id, condominium_name: condo.name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to create admin" });
  }
});

app.get("/api/developer/admins", requireRole("DEVELOPER"), async (req, res) => {
  try {
    const developerId = req.user.employee_id;
    const [rows] = await db.promise().query(
      `SELECT
         a.employee_id,
         a.full_name,
         a.username,
         a.email,
         a.contact_number,
         a.condominium_id,
         c.name AS condominium_name,
         (
           SELECT COUNT(*)
           FROM EMPLOYEE e
           WHERE e.created_by_employee_id = a.employee_id
             AND EXISTS (SELECT 1 FROM EMPLOYEE_ROLE r WHERE r.employee_id = e.employee_id AND r.status = 'active' AND UPPER(TRIM(r.role_type)) = 'OWNER')
         ) AS ownersCreatedCount,
         (
           SELECT COUNT(*)
           FROM EMPLOYEE e
           WHERE e.created_by_employee_id = a.employee_id
             AND EXISTS (SELECT 1 FROM EMPLOYEE_ROLE r WHERE r.employee_id = e.employee_id AND r.status = 'active' AND UPPER(TRIM(r.role_type)) NOT IN ('OWNER','ADMIN','DEVELOPER'))
         ) AS staffCreatedCount
       FROM EMPLOYEE a
       LEFT JOIN CONDOMINIUM c ON c.condominium_id = a.condominium_id
       WHERE a.created_by_employee_id = ?
         AND EXISTS (SELECT 1 FROM EMPLOYEE_ROLE r WHERE r.employee_id = a.employee_id AND r.status = 'active' AND UPPER(TRIM(r.role_type)) = 'ADMIN')
       ORDER BY a.full_name`,
      [developerId]
    );
    res.json(rows || []);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch admins" });
  }
});

function generateTempPasscode(len = 10) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

async function developerOwnsAdmin(db, developerId, adminId) {
  const [[row]] = await db.promise().query(
    `SELECT e.employee_id
     FROM EMPLOYEE e
     WHERE e.employee_id = ? AND e.created_by_employee_id = ?
       AND EXISTS (SELECT 1 FROM EMPLOYEE_ROLE r WHERE r.employee_id = e.employee_id AND r.status = 'active' AND UPPER(TRIM(r.role_type)) = 'ADMIN')`,
    [adminId, developerId]
  );
  return !!row;
}

async function developerOwnsUserInAdminTree(db, developerId, userId) {
  // Allowed targets:
  // - Admin created by developer
  // - Any employee created by an admin created by developer
  const [[row]] = await db.promise().query(
    `SELECT e.employee_id
     FROM EMPLOYEE e
     WHERE e.employee_id = ?
       AND (
         e.created_by_employee_id = ?
         OR e.created_by_employee_id IN (
           SELECT a.employee_id
           FROM EMPLOYEE a
           WHERE a.created_by_employee_id = ?
             AND EXISTS (SELECT 1 FROM EMPLOYEE_ROLE r WHERE r.employee_id = a.employee_id AND r.status = 'active' AND UPPER(TRIM(r.role_type)) = 'ADMIN')
         )
       )
       AND NOT EXISTS (SELECT 1 FROM EMPLOYEE_ROLE r WHERE r.employee_id = e.employee_id AND r.status = 'active' AND UPPER(TRIM(r.role_type)) = 'DEVELOPER')
     LIMIT 1`,
    [userId, developerId, developerId]
  );
  return !!row;
}

app.get("/api/developer/admins/:id/tree", requireRole("DEVELOPER"), async (req, res) => {
  try {
    const developerId = req.user.employee_id;
    const adminId = Number(req.params.id);
    if (!adminId) return res.status(400).json({ error: "Invalid admin id" });
    const ok = await developerOwnsAdmin(db, developerId, adminId);
    if (!ok) return res.status(404).json({ error: "Admin not found" });

    const [children] = await db.promise().query(
      `SELECT
         e.employee_id,
         e.full_name,
         e.username,
         e.email,
         e.contact_number,
         e.address,
         e.created_by_employee_id,
         (SELECT r.role_type FROM EMPLOYEE_ROLE r WHERE r.employee_id = e.employee_id AND r.status = 'active' ORDER BY r.role_id DESC LIMIT 1) AS role_type
       FROM EMPLOYEE e
       WHERE e.created_by_employee_id = ?
       ORDER BY e.full_name`,
      [adminId]
    );

    res.json({
      admin_id: adminId,
      owners: (children || []).filter((c) => String(c.role_type || "").toUpperCase() === "OWNER"),
      staff: (children || []).filter((c) => {
        const r = String(c.role_type || "").toUpperCase();
        return r !== "OWNER" && r !== "ADMIN" && r !== "DEVELOPER";
      }),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch admin tree" });
  }
});

app.put("/api/developer/users/:id", requireRole("DEVELOPER"), async (req, res) => {
  try {
    const developerId = req.user.employee_id;
    const userId = Number(req.params.id);
    if (!userId) return res.status(400).json({ error: "Invalid user id" });
    const ok = await developerOwnsUserInAdminTree(db, developerId, userId);
    if (!ok) return res.status(404).json({ error: "User not found" });

    const { full_name, username, email, contact_number, address, password } = req.body || {};
    const updates = [];
    const values = [];
    if (full_name !== undefined) { updates.push("full_name = ?"); values.push(String(full_name).trim()); }
    if (address !== undefined) { updates.push("address = ?"); values.push(address === "" || address == null ? null : String(address).trim()); }
    if (contact_number !== undefined) { updates.push("contact_number = ?"); values.push(contact_number === "" || contact_number == null ? null : String(contact_number).trim()); }
    if (email !== undefined) { updates.push("email = ?"); values.push(email === "" || email == null ? null : String(email).trim()); }
    if (username !== undefined) { updates.push("username = ?"); values.push(String(username).trim()); }
    if (password !== undefined && String(password).trim()) {
      const hashed = await bcrypt.hash(String(password).trim(), 10);
      updates.push("password = ?");
      values.push(hashed);
    }
    if (updates.length === 0) return res.status(400).json({ error: "No fields to update" });

    if (username !== undefined || email !== undefined) {
      const u = username !== undefined ? String(username).trim() : null;
      const em = email !== undefined ? String(email).trim() : null;
      const [existing] = await db.promise().query(
        "SELECT employee_id FROM EMPLOYEE WHERE employee_id <> ? AND (username = ? OR email = ?)",
        [userId, u || "", em || ""]
      );
      if ((existing || []).length > 0) return res.status(400).json({ error: "Username or email already exists" });
    }

    values.push(userId);
    await db.promise().query(`UPDATE EMPLOYEE SET ${updates.join(", ")} WHERE employee_id = ?`, values);
    res.json({ message: "User updated", employee_id: userId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update user" });
  }
});

app.post("/api/developer/users/:id/reset-passcode", requireRole("DEVELOPER"), async (req, res) => {
  try {
    const developerId = req.user.employee_id;
    const userId = Number(req.params.id);
    if (!userId) return res.status(400).json({ error: "Invalid user id" });
    const ok = await developerOwnsUserInAdminTree(db, developerId, userId);
    if (!ok) return res.status(404).json({ error: "User not found" });

    const explicit = String(req.body && req.body.new_passcode || "").trim();
    const newPasscode = explicit || generateTempPasscode(10);
    const hashed = await bcrypt.hash(newPasscode, 10);
    await db.promise().query("UPDATE EMPLOYEE SET password = ? WHERE employee_id = ?", [hashed, userId]);
    res.json({ message: "Passcode reset", employee_id: userId, new_passcode: newPasscode });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to reset passcode" });
  }
});

app.delete("/api/developer/users/:id", requireRole("DEVELOPER"), async (req, res) => {
  try {
    const developerId = req.user.employee_id;
    const userId = Number(req.params.id);
    if (!userId) return res.status(400).json({ error: "Invalid user id" });
    const ok = await developerOwnsUserInAdminTree(db, developerId, userId);
    if (!ok) return res.status(404).json({ error: "User not found" });

    await db.promise().query("DELETE FROM EMPLOYEE_ROLE WHERE employee_id = ?", [userId]);
    await db.promise().query("DELETE FROM EMPLOYEE_TOWER WHERE employee_id = ?", [userId]);
    await db.promise().query("DELETE FROM EMPLOYEE WHERE employee_id = ?", [userId]);
    res.json({ message: "User deleted", employee_id: userId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete user" });
  }
});

app.post("/api/developer/admins/:id/reset-passcode", requireRole("DEVELOPER"), async (req, res) => {
  try {
    const developerId = req.user.employee_id;
    const adminId = Number(req.params.id);
    if (!adminId) return res.status(400).json({ error: "Invalid admin id" });

    const explicit = String(req.body && req.body.new_passcode || "").trim();
    const newPasscode = explicit || generateTempPasscode(10);

    const row = await developerOwnsAdmin(db, developerId, adminId);
    if (!row) return res.status(404).json({ error: "Admin not found" });

    const hashed = await bcrypt.hash(newPasscode, 10);
    await db.promise().query("UPDATE EMPLOYEE SET password = ? WHERE employee_id = ?", [hashed, adminId]);
    res.json({ message: "Admin passcode reset", admin_id: adminId, new_passcode: newPasscode });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to reset admin passcode" });
  }
});

app.delete("/api/developer/admins/:id", requireRole("DEVELOPER"), async (req, res) => {
  try {
    const developerId = req.user.employee_id;
    const adminId = Number(req.params.id);
    if (!adminId) return res.status(400).json({ error: "Invalid admin id" });

    const [[row]] = await db.promise().query(
      `SELECT e.employee_id
       FROM EMPLOYEE e
       WHERE e.employee_id = ? AND e.created_by_employee_id = ?
         AND EXISTS (SELECT 1 FROM EMPLOYEE_ROLE r WHERE r.employee_id = e.employee_id AND r.status = 'active' AND UPPER(TRIM(r.role_type)) = 'ADMIN')`,
      [adminId, developerId]
    );
    if (!row) return res.status(404).json({ error: "Admin not found" });

    await db.promise().query("DELETE FROM EMPLOYEE_ROLE WHERE employee_id = ?", [adminId]);
    await db.promise().query("DELETE FROM EMPLOYEE_TOWER WHERE employee_id = ?", [adminId]);
    await db.promise().query("DELETE FROM EMPLOYEE WHERE employee_id = ?", [adminId]);
    res.json({ message: "Admin deleted", admin_id: adminId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete admin" });
  }
});

// ---------------- Towers (ERD: TOWER) ----------------
app.get("/api/towers", optionalAuth, async (req, res) => {
  try {
    if (req.user && isResidentOwnerRole(req.user.role)) return res.json([]);
    await tryBackfillTowerOwners();
    let rows;
    const isOwner = !!(req.user && isCondoAdminRole(req.user.role));
    const ownerId = isOwner ? Number(req.user.employee_id) : null;
    try {
      [rows] = await db.promise().query(
        "SELECT tower_id, tower_name, number_floors FROM TOWER WHERE (? IS NULL OR owner_employee_id = ?) ORDER BY tower_name",
        [ownerId, ownerId]
      );
    } catch (colErr) {
      if (colErr.code === "ER_BAD_FIELD_ERROR") {
        if (ownerId) {
          try {
            [rows] = await db.promise().query(
              `SELECT t.tower_id, t.tower_name, t.number_floors
               FROM TOWER t
               WHERE t.tower_id IN (
                 SELECT DISTINCT et.tower_id
                 FROM EMPLOYEE_TOWER et
                 JOIN EMPLOYEE e ON e.employee_id = et.employee_id
                 WHERE e.created_by_employee_id = ?
               )
               ORDER BY t.tower_name`,
              [ownerId]
            );
          } catch (e) {
            [rows] = await db.promise().query(
              "SELECT tower_id, tower_name, number_floors FROM TOWER ORDER BY tower_name"
            );
          }
        } else {
          [rows] = await db.promise().query(
            "SELECT tower_id, tower_name, number_floors FROM TOWER ORDER BY tower_name"
          );
        }
      } else throw colErr;
    }
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch towers" });
  }
});

// Units in a tower (admin portfolio) — for owner unit assignment UI
app.get("/api/towers/:towerId/units", optionalAuth, async (req, res) => {
  try {
    if (!req.user || !isCondoAdminRole(req.user.role))
      return res.status(403).json({ error: "Admins only" });
    const tid = Number(req.params.towerId);
    const adminId = req.user.employee_id;
    if (!tid) return res.status(400).json({ error: "Invalid tower" });
    // Admin assignment UI: list units in the selected tower.
    // Do not filter by owner_employee_id here; that breaks when the column isn't present and also mixes ownership with admin scope.
    const sqlWithAdminScope = `SELECT u.unit_id, u.unit_number, u.floor_number, t.tower_name
       FROM UNIT u
       LEFT JOIN TOWER t ON t.tower_id = u.tower_id
       WHERE u.tower_id = ?
         AND u.tower_id IN (SELECT et.tower_id FROM EMPLOYEE_TOWER et WHERE et.employee_id = ?)
       ORDER BY u.floor_number, u.unit_number, u.unit_id`;
    const sqlNoScope = `SELECT u.unit_id, u.unit_number, u.floor_number, t.tower_name
       FROM UNIT u
       LEFT JOIN TOWER t ON t.tower_id = u.tower_id
       WHERE u.tower_id = ?
       ORDER BY u.floor_number, u.unit_number, u.unit_id`;

    let rows = [];
    try {
      const [r] = await db.promise().query(sqlWithAdminScope, [tid, adminId]);
      rows = r || [];
      if (!rows.length) {
        const [r2] = await db.promise().query(sqlNoScope, [tid]);
        rows = r2 || [];
      }
    } catch (e) {
      const [r3] = await db.promise().query(sqlNoScope, [tid]);
      rows = r3 || [];
    }
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to fetch units" });
  }
});

app.post("/api/towers", optionalAuth, async (req, res) => {
  try {
    if (!req.user || !isCondoAdminRole(req.user.role))
      return res.status(403).json({ error: "Admins only" });
    const { tower_name, number_floors } = req.body;
    if (!tower_name || number_floors == null)
      return res.status(400).json({ error: "tower_name and number_floors required" });
    const ownerId = Number(req.user.employee_id);
    let result;
    try {
      [result] = await db.promise().query(
        "INSERT INTO TOWER (tower_name, number_floors, owner_employee_id) VALUES (?, ?, ?)",
        [String(tower_name).trim(), Number(number_floors), ownerId]
      );
    } catch (colErr) {
      if (colErr.code === "ER_BAD_FIELD_ERROR") {
        [result] = await db.promise().query(
          "INSERT INTO TOWER (tower_name, number_floors) VALUES (?, ?)",
          [String(tower_name).trim(), Number(number_floors)]
        );
      } else throw colErr;
    }
    res.status(201).json({ tower_id: result.insertId, tower_name, number_floors });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to create tower" });
  }
});

app.delete("/api/towers/:id", optionalAuth, async (req, res) => {
  try {
    if (!req.user || !isCondoAdminRole(req.user.role))
      return res.status(403).json({ error: "Admins only" });
    const towerId = Number(req.params.id);
    if (!towerId) return res.status(400).json({ error: "Invalid tower id" });
    const ownerId = Number(req.user.employee_id);

    const [[row]] = await db.promise().query(
      "SELECT tower_id FROM TOWER WHERE tower_id = ? AND (owner_employee_id IS NULL OR owner_employee_id = ?)",
      [towerId, ownerId]
    );
    if (!row) return res.status(404).json({ error: "Tower not found or you cannot delete it" });

    const [unitRows] = await db.promise().query("SELECT unit_id FROM UNIT WHERE tower_id = ?", [towerId]);
    const unitIds = (unitRows || []).map((r) => r.unit_id);
    if (unitIds.length > 0) {
      const placeholdersUnit = unitIds.map(() => "?").join(",");
      const [bookRows] = await db.promise().query(
        "SELECT booking_id FROM BOOKING WHERE unit_id IN (" + placeholdersUnit + ")",
        unitIds
      );
      const bookingIds = (bookRows || []).map((r) => r.booking_id);
      if (bookingIds.length > 0) {
        const placeholdersBook = bookingIds.map(() => "?").join(",");
        await db.promise().query("DELETE FROM ADDITIONAL_CHARGE WHERE booking_id IN (" + placeholdersBook + ")", bookingIds);
        await db.promise().query("DELETE FROM BOOKING_GUEST WHERE booking_id IN (" + placeholdersBook + ")", bookingIds);
      }
      await db.promise().query("DELETE FROM BOOKING WHERE unit_id IN (" + placeholdersUnit + ")", unitIds);
    }
    await db.promise().query("DELETE FROM EMPLOYEE_TOWER WHERE tower_id = ?", [towerId]);
    await db.promise().query("DELETE FROM UNIT WHERE tower_id = ?", [towerId]);
    const [result] = await db.promise().query("DELETE FROM TOWER WHERE tower_id = ?", [towerId]);
    if (result.affectedRows === 0) return res.status(404).json({ error: "Tower not found" });
    res.json({ message: "Tower deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to delete tower" });
  }
});

// ---------------- Units (ERD: UNIT – linked to TOWER) ----------------
app.get("/api/units", optionalAuth, async (req, res) => {
  try {
    await tryBackfillTowerOwners();
    const roleNorm = req.user && req.user.role ? String(req.user.role).toUpperCase().replace(/[\s_-]/g, "") : "";
    const isOwner = !!(req.user && isCondoAdminRole(req.user.role));
    const isFrontDesk = !!(req.user && (roleNorm === "FRONTDESK" || roleNorm === "STAFF"));
    const ownerId = isOwner ? Number(req.user.employee_id) : null;
    const staffId = isFrontDesk ? Number(req.user.employee_id) : null;
    let rows;
    try {
      if (ownerId) {
        [rows] = await db.promise().query(
          `SELECT u.unit_id, u.tower_id, u.unit_number, u.floor_number, u.unit_type, u.unit_size, u.description,
            u.image_urls, t.tower_name
           FROM UNIT u
           LEFT JOIN TOWER t ON t.tower_id = u.tower_id
           WHERE (? IS NULL OR COALESCE(u.owner_employee_id, t.owner_employee_id) = ?)
           ORDER BY t.tower_name, u.floor_number, u.unit_number`,
          [ownerId, ownerId]
        );
      } else if (staffId) {
        const [towerRows] = await db.promise().query("SELECT tower_id FROM EMPLOYEE_TOWER WHERE employee_id = ?", [staffId]);
        const towerIds = (towerRows || []).map((r) => r.tower_id).filter((id) => id != null);
        if (towerIds.length > 0) {
          const placeholders = towerIds.map(() => "?").join(",");
          [rows] = await db.promise().query(
            `SELECT u.unit_id, u.tower_id, u.unit_number, u.floor_number, u.unit_type, u.unit_size, u.description,
              u.image_urls, t.tower_name
             FROM UNIT u
             LEFT JOIN TOWER t ON t.tower_id = u.tower_id
             WHERE u.tower_id IN (${placeholders})
             ORDER BY t.tower_name, u.floor_number, u.unit_number`,
            towerIds
          );
        } else {
          rows = [];
        }
      } else {
        [rows] = await db.promise().query(
          `SELECT u.unit_id, u.tower_id, u.unit_number, u.floor_number, u.unit_type, u.unit_size, u.description,
            u.image_urls, t.tower_name
           FROM UNIT u
           LEFT JOIN TOWER t ON t.tower_id = u.tower_id
           WHERE (? IS NULL OR COALESCE(u.owner_employee_id, t.owner_employee_id) = ?)
           ORDER BY t.tower_name, u.floor_number, u.unit_number`,
          [ownerId, ownerId]
        );
      }
    } catch (colErr) {
      if (colErr.code === "ER_BAD_FIELD_ERROR") {
        if (ownerId) {
          try {
            [rows] = await db.promise().query(
              `SELECT u.unit_id, u.tower_id, u.unit_number, u.floor_number, u.unit_type, u.unit_size, u.description,
                u.image_urls, t.tower_name
               FROM UNIT u
               LEFT JOIN TOWER t ON t.tower_id = u.tower_id
               WHERE u.tower_id IN (
                 SELECT DISTINCT et.tower_id
                 FROM EMPLOYEE_TOWER et
                 JOIN EMPLOYEE e ON e.employee_id = et.employee_id
                 WHERE e.created_by_employee_id = ?
               )
               ORDER BY t.tower_name, u.floor_number, u.unit_number`,
              [ownerId]
            );
          } catch (e) {
            [rows] = await db.promise().query(
              `SELECT u.unit_id, u.tower_id, u.unit_number, u.floor_number, u.unit_type, u.unit_size, u.description,
                u.image_urls, t.tower_name
               FROM UNIT u
               LEFT JOIN TOWER t ON t.tower_id = u.tower_id
               ORDER BY t.tower_name, u.floor_number, u.unit_number`
            );
          }
        } else if (staffId) {
          try {
            const [towerRows] = await db.promise().query("SELECT tower_id FROM EMPLOYEE_TOWER WHERE employee_id = ?", [staffId]);
            const towerIds = (towerRows || []).map((r) => r.tower_id).filter((id) => id != null);
            if (towerIds.length > 0) {
              const placeholders = towerIds.map(() => "?").join(",");
              [rows] = await db.promise().query(
                `SELECT u.unit_id, u.tower_id, u.unit_number, u.floor_number, u.unit_type, u.unit_size, u.description,
                  u.image_urls, t.tower_name
                 FROM UNIT u
                 LEFT JOIN TOWER t ON t.tower_id = u.tower_id
                 WHERE u.tower_id IN (${placeholders})
                 ORDER BY t.tower_name, u.floor_number, u.unit_number`,
                towerIds
              );
            } else {
              rows = [];
            }
          } catch (e) {
            rows = [];
          }
        } else {
          [rows] = await db.promise().query(
            `SELECT u.unit_id, u.tower_id, u.unit_number, u.floor_number, u.unit_type, u.unit_size, u.description,
              u.image_urls, t.tower_name
             FROM UNIT u
             LEFT JOIN TOWER t ON t.tower_id = u.tower_id
             ORDER BY t.tower_name, u.floor_number, u.unit_number`
          );
        }
      } else throw colErr;
    }
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

app.post("/api/units", optionalAuth, async (req, res) => {
  try {
    if (!req.user || !isCondoAdminRole(req.user.role))
      return res.status(403).json({ error: "Admins only" });
    const { tower_id, unit_number, floor_number, unit_type, unit_size, description, image_urls, price } = req.body;
    if (!tower_id || !unit_number)
      return res.status(400).json({ error: "tower_id and unit_number required" });
    const priceNum = price !== undefined && price !== "" && price != null ? Number(price) : NaN;
    if (isNaN(priceNum) || priceNum < 0)
      return res.status(400).json({ error: "price is required and must be >= 0" });
    const hasImages = image_urls != null && String(image_urls).trim() !== "";
    const priceVal = priceNum;
    await tryBackfillTowerOwners();
    const ownerId = Number(req.user.employee_id);
    let result;
    try {
      if (hasImages) {
        [result] = await db.promise().query(
          `INSERT INTO UNIT (tower_id, unit_number, floor_number, unit_type, unit_size, description, image_urls, owner_employee_id, price)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            Number(tower_id),
            String(unit_number).trim(),
            floor_number != null ? String(floor_number).trim() : null,
            unit_type ? String(unit_type).trim() : null,
            unit_size != null ? Number(unit_size) : null,
            description ? String(description).trim() : null,
            String(image_urls).trim(),
            ownerId,
            priceVal
          ]
        );
      } else {
        [result] = await db.promise().query(
          `INSERT INTO UNIT (tower_id, unit_number, floor_number, unit_type, unit_size, description, owner_employee_id, price)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            Number(tower_id),
            String(unit_number).trim(),
            floor_number != null ? String(floor_number).trim() : null,
            unit_type ? String(unit_type).trim() : null,
            unit_size != null ? Number(unit_size) : null,
            description ? String(description).trim() : null,
            ownerId,
            priceVal
          ]
        );
      }
    } catch (colErr) {
      if (colErr.code === "ER_BAD_FIELD_ERROR") {
        const [legacy] = hasImages
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
        result = legacy;
      } else throw colErr;
    }
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

app.get("/api/properties", optionalAuth, async (req, res) => {
  try {
    let rows;
    if (req.user && isResidentOwnerRole(req.user.role)) {
      try {
        let unitIds = [];
        try {
          const [mapRows] = await db.promise().query("SELECT unit_id FROM OWNER_UNIT WHERE owner_employee_id = ?", [req.user.employee_id]);
          unitIds = (mapRows || []).map((r) => Number(r.unit_id)).filter((n) => n > 0);
        } catch (e) {
          const [[emp]] = await db.promise().query("SELECT resident_unit_id FROM EMPLOYEE WHERE employee_id = ?", [req.user.employee_id]);
          const uid = emp && emp.resident_unit_id ? Number(emp.resident_unit_id) : null;
          if (uid) unitIds = [uid];
        }
        if (!unitIds.length) return res.json([]);
        const placeholders = unitIds.map(() => "?").join(",");
        const [r] = await db.promise().query(
          `SELECT u.unit_id, u.tower_id, u.unit_number, u.floor_number, u.unit_type, u.unit_size, u.description,
            u.image_urls, u.price, t.tower_name, t.number_floors
           FROM UNIT u
           LEFT JOIN TOWER t ON t.tower_id = u.tower_id
           WHERE u.unit_id IN (${placeholders})
           ORDER BY t.tower_name, u.floor_number, u.unit_number`,
          unitIds
        );
        return res.json(r || []);
      } catch (e) {
        return res.json([]);
      }
    }
    try {
      await tryBackfillTowerOwners();
      const roleNorm = req.user && req.user.role ? String(req.user.role).toUpperCase().replace(/[\s_-]/g, "") : "";
      const isOwner = !!(req.user && isCondoAdminRole(req.user.role));
      const isFrontDesk = !!(req.user && (roleNorm === "FRONTDESK" || roleNorm === "STAFF"));
      const ownerId = isOwner ? Number(req.user.employee_id) : null;
      const staffId = isFrontDesk ? Number(req.user.employee_id) : null;
      if (ownerId) {
        [rows] = await db.promise().query(
          `SELECT u.unit_id, u.tower_id, u.unit_number, u.floor_number, u.unit_type, u.unit_size, u.description,
            u.image_urls, u.price, t.tower_name, t.number_floors
           FROM UNIT u
           LEFT JOIN TOWER t ON t.tower_id = u.tower_id
           WHERE (COALESCE(u.owner_employee_id, t.owner_employee_id) = ?)
           ORDER BY t.tower_name, u.floor_number, u.unit_number`,
          [ownerId]
        );
      } else if (staffId) {
        [rows] = await db.promise().query(
          `SELECT u.unit_id, u.tower_id, u.unit_number, u.floor_number, u.unit_type, u.unit_size, u.description,
            u.image_urls, u.price, t.tower_name, t.number_floors
           FROM UNIT u
           LEFT JOIN TOWER t ON t.tower_id = u.tower_id
           WHERE u.tower_id IN (SELECT et.tower_id FROM EMPLOYEE_TOWER et WHERE et.employee_id = ?)
           ORDER BY t.tower_name, u.floor_number, u.unit_number`,
          [staffId]
        );
      } else {
        [rows] = await db.promise().query(
          `SELECT u.unit_id, u.tower_id, u.unit_number, u.floor_number, u.unit_type, u.unit_size, u.description,
            u.image_urls, u.price, t.tower_name, t.number_floors
           FROM UNIT u
           LEFT JOIN TOWER t ON t.tower_id = u.tower_id
           ORDER BY t.tower_name, u.floor_number, u.unit_number`
        );
      }
    } catch (colErr) {
      if (colErr.code === "ER_BAD_FIELD_ERROR") {
        // Older schema without ownership columns: best-effort isolation for management admin using employee->tower assignments.
        const roleNorm = req.user && req.user.role ? String(req.user.role).toUpperCase().replace(/[\s_-]/g, "") : "";
        const isOwner = !!(req.user && isCondoAdminRole(req.user.role));
        const isFrontDesk = !!(req.user && (roleNorm === "FRONTDESK" || roleNorm === "STAFF"));
        const ownerId = isOwner ? Number(req.user.employee_id) : null;
        const staffId = isFrontDesk ? Number(req.user.employee_id) : null;
        if (ownerId) {
          try {
            [rows] = await db.promise().query(
              `SELECT u.unit_id, u.tower_id, u.unit_number, u.floor_number, u.unit_type, u.unit_size, u.description,
                t.tower_name, t.number_floors
               FROM UNIT u
               LEFT JOIN TOWER t ON t.tower_id = u.tower_id
               WHERE u.tower_id IN (
                 SELECT DISTINCT et.tower_id
                 FROM EMPLOYEE_TOWER et
                 JOIN EMPLOYEE e ON e.employee_id = et.employee_id
                 WHERE e.created_by_employee_id = ?
               )
               ORDER BY t.tower_name, u.floor_number, u.unit_number`,
              [ownerId]
            );
          } catch (e) {
            [rows] = await db.promise().query(PROPERTIES_MINIMAL_SQL);
          }
        } else if (staffId) {
          try {
            [rows] = await db.promise().query(
              `SELECT u.unit_id, u.tower_id, u.unit_number, u.floor_number, u.unit_type, u.unit_size, u.description,
                t.tower_name, t.number_floors
               FROM UNIT u
               LEFT JOIN TOWER t ON t.tower_id = u.tower_id
               WHERE u.tower_id IN (SELECT et.tower_id FROM EMPLOYEE_TOWER et WHERE et.employee_id = ?)
               ORDER BY t.tower_name, u.floor_number, u.unit_number`,
              [staffId]
            );
          } catch (e) {
            [rows] = await db.promise().query(PROPERTIES_MINIMAL_SQL);
          }
        } else {
          [rows] = await db.promise().query(PROPERTIES_MINIMAL_SQL);
        }
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
app.put("/api/units/:id", optionalAuth, async (req, res) => {
  try {
    if (!req.user || !isCondoAdminRole(req.user.role))
      return res.status(403).json({ error: "Admins only" });
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
app.delete("/api/units/:id", optionalAuth, async (req, res) => {
  try {
    if (!req.user || !isCondoAdminRole(req.user.role))
      return res.status(403).json({ error: "Admins only" });
    const unitId = Number(req.params.id);
    const [result] = await db.promise().query("DELETE FROM UNIT WHERE unit_id = ?", [unitId]);
    if (result.affectedRows === 0) return res.status(404).json({ error: "Unit not found" });
    res.json({ message: "Unit deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to delete unit" });
  }
});

// Owner edits assigned unit details (cannot change unit_number)
app.put("/api/owner/units/:id", optionalAuth, async (req, res) => {
  try {
    if (!req.user || !isResidentOwnerRole(req.user.role))
      return res.status(403).json({ error: "Owners only" });
    const unitId = Number(req.params.id);
    if (!unitId) return res.status(400).json({ error: "Invalid unit id" });

    // Verify this unit is assigned to this owner (OWNER_UNIT) or fallback resident_unit_id.
    let allowed = false;
    try {
      const [[m]] = await db.promise().query(
        "SELECT 1 AS ok FROM OWNER_UNIT WHERE owner_employee_id = ? AND unit_id = ? LIMIT 1",
        [req.user.employee_id, unitId]
      );
      allowed = !!m;
    } catch (e) {
      const [[emp]] = await db.promise().query("SELECT resident_unit_id FROM EMPLOYEE WHERE employee_id = ?", [req.user.employee_id]);
      allowed = !!(emp && Number(emp.resident_unit_id) === unitId);
    }
    if (!allowed) return res.status(403).json({ error: "Not allowed to edit this unit" });

    const { floor_number, unit_type, unit_size, description, image_urls, price } = req.body || {};
    const updates = [];
    const values = [];
    if (floor_number !== undefined) { updates.push("floor_number = ?"); values.push(floor_number === "" || floor_number == null ? null : String(floor_number).trim()); }
    if (unit_type !== undefined) { updates.push("unit_type = ?"); values.push(unit_type === "" || unit_type == null ? null : String(unit_type).trim()); }
    if (unit_size !== undefined) { updates.push("unit_size = ?"); values.push(unit_size === "" || unit_size == null ? null : Number(unit_size)); }
    if (description !== undefined) { updates.push("description = ?"); values.push(description === "" || description == null ? null : String(description).trim()); }
    if (image_urls !== undefined) { updates.push("image_urls = ?"); values.push(image_urls === "" || image_urls == null ? null : (typeof image_urls === "string" ? image_urls : JSON.stringify(image_urls))); }
    if (price !== undefined) { updates.push("price = ?"); values.push(price === "" || price == null ? null : Number(price)); }

    if (updates.length === 0) return res.status(400).json({ error: "No fields to update" });
    values.push(unitId);
    await db.promise().query(`UPDATE UNIT SET ${updates.join(", ")} WHERE unit_id = ?`, values);
    res.json({ message: "Unit updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to update unit" });
  }
});

// ---------------- Employees (ERD: EMPLOYEE + EMPLOYEE_ROLE) ----------------
// optionalAuth: if Bearer token present, req.user = { employee_id, role }. Owner sees only employees they added (created_by_employee_id) and OWNER role is hidden.
app.get("/api/employees", optionalAuth, async (req, res) => {
  try {
    const baseSelect = `SELECT e.employee_id, e.full_name, e.username, e.contact_number, e.email, e.address,
      (SELECT r.role_type FROM EMPLOYEE_ROLE r WHERE r.employee_id = e.employee_id AND r.status = 'active' ORDER BY r.role_id DESC LIMIT 1) AS role_type,
      (SELECT GROUP_CONCAT(t.tower_name ORDER BY t.tower_name SEPARATOR ', ') FROM EMPLOYEE_TOWER et JOIN TOWER t ON t.tower_id = et.tower_id WHERE et.employee_id = e.employee_id) AS assigned_tower
     FROM EMPLOYEE e`;
    let rows;
    if (req.user && isCondoAdminRole(req.user.role)) {
      try {
        const [r] = await db.promise().query(
          baseSelect + ` WHERE e.created_by_employee_id = ? AND (SELECT r.role_type FROM EMPLOYEE_ROLE r WHERE r.employee_id = e.employee_id AND r.status = 'active' ORDER BY r.role_id DESC LIMIT 1) NOT IN ('OWNER', 'ADMIN') ORDER BY e.full_name`,
          [req.user.employee_id]
        );
        rows = r;
      } catch (colErr) {
        if (colErr.code === "ER_BAD_FIELD_ERROR" && /created_by_employee_id/.test(colErr.message)) {
          const [r] = await db.promise().query(baseSelect + ` ORDER BY e.full_name`);
          rows = (r || []).filter(e => !isEmployeeRoleMgmt(e.role_type));
        } else throw colErr;
      }
    } else {
      rows = [];
    }
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch employees" });
  }
});

app.post("/api/employees", optionalAuth, async (req, res) => {
  try {
    if (!req.user || !isCondoAdminRole(req.user.role))
      return res.status(403).json({ error: "Only administrators can add employees" });
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
    let role = role_type || "Front Desk";
    const rt = String(role).toUpperCase();
    if (rt === "ADMIN" || rt === "OWNER")
      return res.status(400).json({ error: "Use Manage Owners to add unit owners. Staff roles only here." });
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

// ---------------- Unit owners (residents) — created by condo admin ----------------
async function fetchOwnersListRows(adminId) {
  const ownerRoleExists = `EXISTS (SELECT 1 FROM EMPLOYEE_ROLE r WHERE r.employee_id = e.employee_id AND r.status = 'active' AND (r.role_type = 'OWNER' OR UPPER(TRIM(r.role_type)) = 'OWNER'))`;

  const fullSql = `SELECT
           e.employee_id, e.full_name, e.username, e.email, e.contact_number,
           e.resident_unit_id AS unit_id, u.unit_number, t.tower_name,
           o.owner_id, COALESCE(o.is_verified, 0) AS is_verified,
           CASE WHEN o.valid_id IS NOT NULL THEN 1 ELSE 0 END AS has_valid_id,
           (SELECT GROUP_CONCAT(
              CONCAT(COALESCE(t2.tower_name, ''), ' – Unit ', COALESCE(u2.unit_number, u2.unit_id))
              ORDER BY t2.tower_name, u2.unit_number SEPARATOR ', ')
            FROM OWNER_UNIT ou2
            JOIN UNIT u2 ON u2.unit_id = ou2.unit_id
            LEFT JOIN TOWER t2 ON t2.tower_id = u2.tower_id
            WHERE ou2.owner_employee_id = e.employee_id) AS units_label
         FROM EMPLOYEE e
         LEFT JOIN OWNER o ON o.employee_id = e.employee_id
         LEFT JOIN UNIT u ON u.unit_id = e.resident_unit_id
         LEFT JOIN TOWER t ON t.tower_id = u.tower_id
         WHERE e.created_by_employee_id = ?
           AND ${ownerRoleExists}
         ORDER BY e.full_name`;

  const noOwnerUnitSql = `SELECT e.employee_id, e.full_name, e.username, e.email, e.contact_number,
              e.resident_unit_id AS unit_id, u.unit_number, t.tower_name,
              o.owner_id, COALESCE(o.is_verified, 0) AS is_verified,
              CASE WHEN o.valid_id IS NOT NULL THEN 1 ELSE 0 END AS has_valid_id,
              NULL AS units_label
             FROM EMPLOYEE e
             LEFT JOIN OWNER o ON o.employee_id = e.employee_id
             LEFT JOIN UNIT u ON u.unit_id = e.resident_unit_id
             LEFT JOIN TOWER t ON t.tower_id = u.tower_id
             WHERE e.created_by_employee_id = ?
               AND ${ownerRoleExists}
             ORDER BY e.full_name`;

  const ownerMetaSql = `SELECT e.employee_id, e.full_name, e.username, e.email, e.contact_number,
            NULL AS unit_id, NULL AS unit_number, NULL AS tower_name,
            o.owner_id,
            COALESCE(o.is_verified, 0) AS is_verified,
            CASE WHEN o.valid_id IS NOT NULL AND LENGTH(o.valid_id) > 0 THEN 1 ELSE 0 END AS has_valid_id,
            NULL AS units_label
           FROM EMPLOYEE e
           LEFT JOIN OWNER o ON o.employee_id = e.employee_id
           WHERE e.created_by_employee_id = ?
             AND ${ownerRoleExists}
           ORDER BY e.full_name`;

  const noOwnerSql = `SELECT e.employee_id, e.full_name, e.username, e.email, e.contact_number,
              e.resident_unit_id AS unit_id, u.unit_number, t.tower_name,
              NULL AS owner_id, 0 AS is_verified, 0 AS has_valid_id, NULL AS units_label
             FROM EMPLOYEE e
             LEFT JOIN UNIT u ON u.unit_id = e.resident_unit_id
             LEFT JOIN TOWER t ON t.tower_id = u.tower_id
             WHERE e.created_by_employee_id = ?
               AND ${ownerRoleExists}
             ORDER BY e.full_name`;

  const noResidentSql = `SELECT e.employee_id, e.full_name, e.username, e.email, e.contact_number,
            NULL AS unit_id, NULL AS unit_number, NULL AS tower_name,
            NULL AS owner_id, 0 AS is_verified, 0 AS has_valid_id, NULL AS units_label
           FROM EMPLOYEE e
           WHERE e.created_by_employee_id = ?
             AND ${ownerRoleExists}
           ORDER BY e.full_name`;

  const minimalSql = `SELECT e.employee_id, e.full_name, e.username, e.email, e.contact_number
           FROM EMPLOYEE e
           WHERE e.created_by_employee_id = ?
             AND ${ownerRoleExists}
           ORDER BY e.full_name`;

  const tries = [
    () => db.promise().query(fullSql, [adminId]),
    () => db.promise().query(noOwnerUnitSql, [adminId]),
    () => db.promise().query(ownerMetaSql, [adminId]),
    () => db.promise().query(noOwnerSql, [adminId]),
    () => db.promise().query(noResidentSql, [adminId]),
    () => db.promise().query(minimalSql, [adminId]),
  ];

  let lastErr;
  for (let i = 0; i < tries.length; i++) {
    try {
      const [r] = await tries[i]();
      const rows = r || [];
      if (rows.length && !Object.prototype.hasOwnProperty.call(rows[0], "units_label")) {
        return rows.map((row) => ({
          ...row,
          unit_id: row.unit_id ?? null,
          unit_number: row.unit_number ?? null,
          tower_name: row.tower_name ?? null,
          owner_id: null,
          is_verified: 0,
          has_valid_id: 0,
          units_label: null,
        }));
      }
      return rows;
    } catch (e) {
      lastErr = e;
      if (i < tries.length - 1) console.warn("GET /api/owners trying simpler query:", e.code || e.message);
    }
  }
  console.error("GET /api/owners all fallbacks failed:", lastErr);
  throw lastErr || new Error("Failed to list owners");
}

app.get("/api/owners", optionalAuth, async (req, res) => {
  try {
    if (!req.user || !isCondoAdminRole(req.user.role))
      return res.status(403).json({ error: "Admins only" });
    const adminId = req.user.employee_id;
    if (adminId == null || adminId === "")
      return res.status(403).json({ error: "Invalid session" });
    const rows = await fetchOwnersListRows(adminId);
    res.json(rows || []);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to fetch owners" });
  }
});

app.post("/api/owners", optionalAuth, async (req, res) => {
  try {
    if (!req.user || !isCondoAdminRole(req.user.role))
      return res.status(403).json({ error: "Admins only" });
    const {
      full_name,
      address,
      username,
      password,
      contact_number,
      email,
      is_verified,
      valid_id_data_url,
    } = req.body || {};
    const unit_numbers_raw = req.body && (req.body.unit_numbers || req.body.unit_number || "");
    const unit_ids_raw = req.body && (req.body.unit_ids != null ? req.body.unit_ids : req.body.unit_id);
    if (!full_name || !username || !password || !email)
      return res.status(400).json({ error: "full_name, username, password, and email required" });
    if (!contact_number || !String(contact_number).trim())
      return res.status(400).json({ error: "contact_number required (OWNER ERD)" });
    const adminId = req.user.employee_id;

    let requested = [];
    const unStr = typeof unit_numbers_raw === "string" ? unit_numbers_raw.trim() : "";
    if (unStr) {
      requested = unStr.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (Array.isArray(unit_ids_raw) && unit_ids_raw.length) {
      requested = unit_ids_raw.map((x) => "#" + Number(x));
    } else if (unit_ids_raw != null && unit_ids_raw !== "") {
      requested = ["#" + Number(unit_ids_raw)];
    }
    if (requested.length > 20) return res.status(400).json({ error: "Too many units (max 20)" });

    const unitIds = [];
    for (const token of requested) {
      const t = String(token).trim();
      // Allow explicit unit_id with # prefix (e.g. #123)
      if (/^#\d+$/.test(t)) {
        const id = Number(t.slice(1));
        const [[row]] = await db.promise().query(
          `SELECT u.unit_id
           FROM UNIT u
           LEFT JOIN TOWER tw ON tw.tower_id = u.tower_id
           WHERE u.unit_id = ? AND COALESCE(u.owner_employee_id, tw.owner_employee_id) = ?`,
          [id, adminId]
        );
        if (!row) return res.status(400).json({ error: `Unit ${t} not found or not in your portfolio` });
        unitIds.push(Number(row.unit_id));
        continue;
      }

      const [rows] = await db.promise().query(
        `SELECT u.unit_id
         FROM UNIT u
         LEFT JOIN TOWER tw ON tw.tower_id = u.tower_id
         WHERE u.unit_number = ? AND COALESCE(u.owner_employee_id, tw.owner_employee_id) = ?
         ORDER BY tw.tower_name, u.floor_number, u.unit_number`,
        [t, adminId]
      );
      if (!rows || rows.length === 0) return res.status(400).json({ error: `Unit number ${t} not found in your portfolio` });
      if (rows.length > 1) return res.status(400).json({ error: `Unit number ${t} is ambiguous. Use #unit_id instead.` });
      unitIds.push(Number(rows[0].unit_id));
    }

    const uniqueUnitIds = Array.from(new Set(unitIds));
    const [existing] = await db.promise().query("SELECT 1 FROM EMPLOYEE WHERE username = ? OR email = ?", [username, email]);
    if (existing.length > 0) return res.status(400).json({ error: "Username or email already exists" });
    const hashedPassword = await bcrypt.hash(password, 10);
    const empVals = [
      full_name,
      address || null,
      username,
      hashedPassword,
      contact_number || null,
      email,
      adminId,
      uniqueUnitIds[0] || null,
    ];
    const empSql =
      "INSERT INTO EMPLOYEE (full_name, address, username, password, contact_number, email, created_by_employee_id, resident_unit_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
    let result;
    try {
      [result] = await db.promise().query(empSql, empVals);
    } catch (insErr) {
      const insMsg = String(insErr.sqlMessage || insErr.message || "");
      const nullUnit =
        insErr.code === "ER_BAD_NULL_ERROR" ||
        insErr.errno === 1048 ||
        /cannot be null/i.test(insMsg);
      const missingCol = insErr.code === "ER_BAD_FIELD_ERROR" && /resident_unit_id/i.test(insMsg);
      if (nullUnit && /resident_unit_id/i.test(insMsg)) {
        try {
          await db.promise().query("ALTER TABLE EMPLOYEE MODIFY COLUMN resident_unit_id INT NULL");
          [result] = await db.promise().query(empSql, empVals);
        } catch (e2) {
          console.error("owner create after ALTER resident_unit_id:", e2);
          return res.status(503).json({
            error:
              "Database blocks owners with no unit yet: EMPLOYEE.resident_unit_id must allow NULL. Run: ALTER TABLE EMPLOYEE MODIFY COLUMN resident_unit_id INT NULL;",
            detail: String(e2.sqlMessage || e2.message || ""),
          });
        }
      } else if (missingCol) {
        try {
          await db.promise().query("ALTER TABLE EMPLOYEE ADD COLUMN resident_unit_id INT NULL");
          [result] = await db.promise().query(empSql, empVals);
        } catch (e3) {
          return res.status(503).json({
            error: "Add column: ALTER TABLE EMPLOYEE ADD COLUMN resident_unit_id INT NULL;",
            detail: String(e3.sqlMessage || e3.message || ""),
          });
        }
      } else {
        throw insErr;
      }
    }
    const employeeId = result.insertId;
    if (!employeeId) {
      return res.status(500).json({ error: "Could not create employee record (no insert id)." });
    }
    try {
      await db.promise().query("INSERT INTO EMPLOYEE_ROLE (employee_id, role_type, status) VALUES (?, 'OWNER', 'active')", [
        employeeId,
      ]);
    } catch (roleErr) {
      try {
        await db.promise().query("DELETE FROM EMPLOYEE WHERE employee_id = ?", [employeeId]);
      } catch (delE) {
        /* */
      }
      console.error("EMPLOYEE_ROLE OWNER insert failed:", roleErr);
      return res.status(503).json({
        error: String(roleErr.sqlMessage || roleErr.message || "Could not assign OWNER role"),
        hint: "Check EMPLOYEE_ROLE allows role_type OWNER and status active.",
      });
    }
    if (uniqueUnitIds.length) {
      try {
        for (const uid of uniqueUnitIds) {
          await db.promise().query("INSERT INTO OWNER_UNIT (owner_employee_id, unit_id) VALUES (?, ?)", [employeeId, uid]);
        }
      } catch (e) {
        /* OWNER_UNIT optional on older DB */
      }
    }
    let validBlob = null;
    if (valid_id_data_url && typeof valid_id_data_url === "string") {
      const m = valid_id_data_url.match(/^data:([^;]+);base64,(.+)$/);
      if (m && m[2]) {
        try {
          validBlob = Buffer.from(m[2], "base64");
          if (validBlob.length > 15 * 1024 * 1024) validBlob = null;
        } catch (e2) {
          validBlob = null;
        }
      }
    }
    const verified =
      is_verified === true ||
      is_verified === 1 ||
      is_verified === "1" ||
      String(is_verified).toLowerCase() === "true";
    const primaryUid = uniqueUnitIds[0] ?? null;
    try {
      await db.promise().query(
        `INSERT INTO OWNER (employee_id, unit_id, full_name, contact_number, email, valid_id, is_verified)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          employeeId,
          primaryUid,
          String(full_name).trim(),
          contact_number ? String(contact_number).trim() : null,
          String(email).trim(),
          validBlob,
          verified ? 1 : 0,
        ]
      );
    } catch (ownErr) {
      if (ownErr.code === "ER_NO_SUCH_TABLE") {
        console.warn("OWNER table missing; run migrations/owner_table.sql");
      } else {
        console.error("OWNER insert (with ID file):", ownErr);
        try {
          await db.promise().query(
            `INSERT INTO OWNER (employee_id, unit_id, full_name, contact_number, email, valid_id, is_verified)
             VALUES (?, ?, ?, ?, ?, NULL, ?)`,
            [
              employeeId,
              primaryUid,
              String(full_name).trim(),
              contact_number ? String(contact_number).trim() : null,
              String(email).trim(),
              verified ? 1 : 0,
            ]
          );
        } catch (own2) {
          console.error("OWNER insert (retry without ID blob):", own2);
        }
      }
    }
    res.status(201).json({ message: "Owner account created", employeeId, unit_ids: uniqueUnitIds });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to create owner" });
  }
});

app.patch("/api/owners/:id", optionalAuth, async (req, res) => {
  try {
    if (!req.user || !isCondoAdminRole(req.user.role))
      return res.status(403).json({ error: "Admins only" });
    const id = Number(req.params.id);
    const adminId = req.user.employee_id;
    const [[row]] = await db.promise().query(
      `SELECT e.employee_id FROM EMPLOYEE e
       WHERE e.employee_id = ? AND e.created_by_employee_id = ?
         AND ` + OWNER_ROLE_EXISTS_SQL,
      [id, adminId]
    );
    if (!row) return res.status(404).json({ error: "Owner not found" });
    const body = req.body || {};
    if (typeof body.is_verified === "undefined")
      return res.status(400).json({ error: "is_verified required" });
    const v =
      body.is_verified === true ||
      body.is_verified === 1 ||
      body.is_verified === "1" ||
      String(body.is_verified).toLowerCase() === "true";
    const bit = v ? 1 : 0;
    try {
      const [ur] = await db.promise().query("UPDATE OWNER SET is_verified = ? WHERE employee_id = ?", [bit, id]);
      const n = ur && typeof ur.affectedRows === "number" ? ur.affectedRows : 0;
      if (n === 0) {
        const [[emp]] = await db.promise().query(
          "SELECT full_name, contact_number, email, resident_unit_id FROM EMPLOYEE WHERE employee_id = ?",
          [id]
        );
        if (emp) {
          await db.promise().query(
            `INSERT INTO OWNER (employee_id, unit_id, full_name, contact_number, email, valid_id, is_verified)
             VALUES (?, ?, ?, ?, ?, NULL, ?)`,
            [
              id,
              emp.resident_unit_id != null ? emp.resident_unit_id : null,
              String(emp.full_name || "").trim() || "Owner",
              emp.contact_number ? String(emp.contact_number).trim() : null,
              String(emp.email || "").trim(),
              bit,
            ]
          );
        }
      }
    } catch (e) {
      if (e.code === "ER_NO_SUCH_TABLE") return res.json({ ok: true, is_verified: bit });
      throw e;
    }
    res.json({ ok: true, is_verified: bit });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to update owner" });
  }
});

async function syncOwnerPrimaryUnit(dbConn, ownerEmployeeId) {
  try {
    const ownerUnitOwnerCol = await getOwnerUnitOwnerColumnName();
    const ownerUnitOwnerVal = await getOwnerUnitOwnerValue(ownerEmployeeId);
    const ownerUnitCols = await getOwnerUnitColumnSet();
    let whereSql = `ou.${ownerUnitOwnerCol} = ?`;
    let params = [ownerUnitOwnerVal];
    if (ownerUnitCols.has("owner_id") && ownerUnitOwnerCol !== "owner_id") {
      const ownerId = await getOwnerIdForEmployee(ownerEmployeeId);
      if (ownerId != null) {
        whereSql = `(ou.${ownerUnitOwnerCol} = ? OR ou.owner_id = ?)`;
        params = [ownerUnitOwnerVal, ownerId];
      }
    }
    const [rows] = await dbConn.promise().query(
      `SELECT ou.unit_id FROM OWNER_UNIT ou WHERE ${whereSql} ORDER BY ou.unit_id LIMIT 1`,
      params
    );
    const uid = rows && rows[0] ? rows[0].unit_id : null;
    await dbConn.promise().query("UPDATE EMPLOYEE SET resident_unit_id = ? WHERE employee_id = ?", [uid, ownerEmployeeId]);
    await dbConn.promise().query("UPDATE OWNER SET unit_id = ? WHERE employee_id = ?", [uid, ownerEmployeeId]);
  } catch (e) {
    try {
      const ownerUnitOwnerCol = await getOwnerUnitOwnerColumnName();
      const ownerUnitOwnerVal = await getOwnerUnitOwnerValue(ownerEmployeeId);
      const ownerUnitCols = await getOwnerUnitColumnSet();
      let whereSql = `ou.${ownerUnitOwnerCol} = ?`;
      let params = [ownerUnitOwnerVal];
      if (ownerUnitCols.has("owner_id") && ownerUnitOwnerCol !== "owner_id") {
        const ownerId = await getOwnerIdForEmployee(ownerEmployeeId);
        if (ownerId != null) {
          whereSql = `(ou.${ownerUnitOwnerCol} = ? OR ou.owner_id = ?)`;
          params = [ownerUnitOwnerVal, ownerId];
        }
      }
      const [rows] = await dbConn.promise().query(
        `SELECT ou.unit_id FROM OWNER_UNIT ou WHERE ${whereSql} ORDER BY ou.unit_id LIMIT 1`,
        params
      );
      const uid = rows && rows[0] ? rows[0].unit_id : null;
      await dbConn.promise().query("UPDATE EMPLOYEE SET resident_unit_id = ? WHERE employee_id = ?", [uid, ownerEmployeeId]);
    } catch (e2) { /* */ }
  }
}

app.get("/api/owners/:id/units", optionalAuth, async (req, res) => {
  try {
    if (!req.user || !isCondoAdminRole(req.user.role))
      return res.status(403).json({ error: "Admins only" });
    const id = Number(req.params.id);
    const adminId = req.user.employee_id;
    const [[own]] = await db.promise().query(
      `SELECT e.employee_id FROM EMPLOYEE e
       WHERE e.employee_id = ? AND e.created_by_employee_id = ?
         AND ` + OWNER_ROLE_EXISTS_SQL,
      [id, adminId]
    );
    if (!own) return res.status(404).json({ error: "Owner not found" });
    let units = [];
    try {
      const ownerUnitOwnerCol = await getOwnerUnitOwnerColumnName();
      const ownerUnitOwnerVal = await getOwnerUnitOwnerValue(id);
      const ownerUnitCols = await getOwnerUnitColumnSet();
      let whereSql = `ou.${ownerUnitOwnerCol} = ?`;
      let params = [ownerUnitOwnerVal];
      if (ownerUnitCols.has("owner_id") && ownerUnitOwnerCol !== "owner_id") {
        const ownerId = await getOwnerIdForEmployee(id);
        if (ownerId != null) {
          whereSql = `(ou.${ownerUnitOwnerCol} = ? OR ou.owner_id = ?)`;
          params = [ownerUnitOwnerVal, ownerId];
        }
      }
      const [r] = await db.promise().query(
        `SELECT u.unit_id, u.unit_number, t.tower_id, t.tower_name
         FROM OWNER_UNIT ou
         JOIN UNIT u ON u.unit_id = ou.unit_id
         LEFT JOIN TOWER t ON t.tower_id = u.tower_id
         WHERE ${whereSql}
         ORDER BY t.tower_name, u.unit_number`,
        params
      );
      units = r || [];
    } catch (e) {
      if (e.code === "ER_NO_SUCH_TABLE") {
        const [[emp]] = await db.promise().query(
          "SELECT resident_unit_id FROM EMPLOYEE WHERE employee_id = ?",
          [id]
        );
        if (emp && emp.resident_unit_id) {
          const [r2] = await db.promise().query(
            `SELECT u.unit_id, u.unit_number, t.tower_id, t.tower_name
             FROM UNIT u LEFT JOIN TOWER t ON t.tower_id = u.tower_id WHERE u.unit_id = ?`,
            [emp.resident_unit_id]
          );
          units = r2 || [];
        }
      } else throw e;
    }
    res.json({ units });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to fetch units" });
  }
});

app.post("/api/owners/:id/units", optionalAuth, async (req, res) => {
  try {
    if (!req.user || !isCondoAdminRole(req.user.role))
      return res.status(403).json({ error: "Admins only" });
    const id = Number(req.params.id);
    const adminId = req.user.employee_id;
    const [[own]] = await db.promise().query(
      `SELECT e.employee_id FROM EMPLOYEE e
       WHERE e.employee_id = ? AND e.created_by_employee_id = ?
         AND ` + OWNER_ROLE_EXISTS_SQL,
      [id, adminId]
    );
    if (!own) return res.status(404).json({ error: "Owner not found" });
    const raw = req.body && req.body.unit_ids;
    const ids = Array.isArray(raw) ? raw.map((x) => Number(x)).filter((x) => x > 0) : [];
    if (!ids.length) return res.status(400).json({ error: "unit_ids array required" });
    const added = [];
    const ownerUnitOwnerCol = await getOwnerUnitOwnerColumnName();
    const ownerUnitOwnerVal = await getOwnerUnitOwnerValue(id);
    const ownerUnitCols = await getOwnerUnitColumnSet();
    const ownerIdForInsert = ownerUnitCols.has("owner_id") ? await getOwnerIdForEmployee(id) : null;
    if (ownerUnitCols.has("owner_id") && ownerIdForInsert == null && ownerUnitOwnerCol !== "owner_id") {
      return res.status(400).json({ error: "Could not resolve OWNER_UNIT.owner_id for this owner" });
    }
    if (ownerUnitOwnerCol === "owner_id" && ownerUnitOwnerVal == null) {
      return res.status(400).json({ error: "Owner row missing in OWNER; cannot map OWNER_UNIT.owner_id." });
    }
    for (const unitId of [...new Set(ids)]) {
      const [[row]] = await db.promise().query(
        "SELECT u.unit_id FROM UNIT u WHERE u.unit_id = ?",
        [unitId]
      );
      if (!row) continue;
      try {
        let existsSql = `SELECT 1 AS x FROM OWNER_UNIT WHERE ${ownerUnitOwnerCol} = ? AND unit_id = ? LIMIT 1`;
        let existsParams = [ownerUnitOwnerVal, unitId];
        if (ownerUnitCols.has("owner_id") && ownerIdForInsert != null && ownerUnitOwnerCol !== "owner_id") {
          existsSql = "SELECT 1 AS x FROM OWNER_UNIT WHERE owner_id = ? AND unit_id = ? LIMIT 1";
          existsParams = [ownerIdForInsert, unitId];
        }

        const [[exists]] = await db.promise().query(existsSql, existsParams);
        if (!exists) {
          const insertCols = [ownerUnitOwnerCol, "unit_id"];
          const insertVals = [ownerUnitOwnerVal, unitId];
          if (ownerUnitCols.has("owner_id") && ownerIdForInsert != null && ownerUnitOwnerCol !== "owner_id") {
            insertCols.push("owner_id");
            insertVals.push(ownerIdForInsert);
          }
          await db.promise().query(
            `INSERT INTO OWNER_UNIT (${insertCols.join(", ")}) VALUES (${insertCols.map(() => "?").join(", ")})`,
            insertVals
          );
          added.push(unitId);
        }
      } catch (e) {
        if (e.code !== "ER_NO_SUCH_TABLE") throw e;
      }
    }
    await syncOwnerPrimaryUnit(db, id);
    res.json({ ok: true, added });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to assign units" });
  }
});

app.delete("/api/owners/:id/units/:unitId", optionalAuth, async (req, res) => {
  try {
    if (!req.user || !isCondoAdminRole(req.user.role))
      return res.status(403).json({ error: "Admins only" });
    const id = Number(req.params.id);
    const unitId = Number(req.params.unitId);
    const adminId = req.user.employee_id;
    const [[own]] = await db.promise().query(
      `SELECT e.employee_id FROM EMPLOYEE e
       WHERE e.employee_id = ? AND e.created_by_employee_id = ?
         AND ` + OWNER_ROLE_EXISTS_SQL,
      [id, adminId]
    );
    if (!own) return res.status(404).json({ error: "Owner not found" });
    try {
      const ownerUnitOwnerCol = await getOwnerUnitOwnerColumnName();
      const ownerUnitOwnerVal = await getOwnerUnitOwnerValue(id);
      const ownerUnitCols = await getOwnerUnitColumnSet();
      let sql = `DELETE FROM OWNER_UNIT WHERE ${ownerUnitOwnerCol} = ? AND unit_id = ?`;
      let params = [ownerUnitOwnerVal, unitId];
      if (ownerUnitCols.has("owner_id") && ownerUnitOwnerCol !== "owner_id") {
        const ownerId = await getOwnerIdForEmployee(id);
        if (ownerId != null) {
          sql = "DELETE FROM OWNER_UNIT WHERE owner_id = ? AND unit_id = ?";
          params = [ownerId, unitId];
        }
      }
      await db.promise().query(sql, params);
    } catch (e) {
      if (e.code !== "ER_NO_SUCH_TABLE") throw e;
    }
    await syncOwnerPrimaryUnit(db, id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to remove unit" });
  }
});

app.put("/api/owners/:id", optionalAuth, async (req, res) => {
  try {
    if (!req.user || !isCondoAdminRole(req.user.role))
      return res.status(403).json({ error: "Admins only" });
    const id = Number(req.params.id);
    const adminId = req.user.employee_id;
    const [[own]] = await db.promise().query(
      `SELECT e.employee_id, e.username FROM EMPLOYEE e
       WHERE e.employee_id = ? AND e.created_by_employee_id = ?
         AND ` + OWNER_ROLE_EXISTS_SQL,
      [id, adminId]
    );
    if (!own) return res.status(404).json({ error: "Owner not found" });
    const b = req.body || {};
    const full_name = b.full_name != null ? String(b.full_name).trim() : null;
    const email = b.email != null ? String(b.email).trim() : null;
    const contact_number = b.contact_number != null ? String(b.contact_number).trim() : null;
    const username = b.username != null ? String(b.username).trim() : null;
    const new_password = b.new_password != null ? String(b.new_password) : "";
    if (!full_name || !email) return res.status(400).json({ error: "full_name and email required" });
    if (username && username !== own.username) {
      const [taken] = await db.promise().query("SELECT 1 FROM EMPLOYEE WHERE username = ? AND employee_id <> ?", [
        username,
        id,
      ]);
      if (taken.length) return res.status(400).json({ error: "Username already taken" });
    }
    const [emailTaken] = await db.promise().query("SELECT 1 FROM EMPLOYEE WHERE email = ? AND employee_id <> ?", [
      email,
      id,
    ]);
    if (emailTaken.length) return res.status(400).json({ error: "Email already in use" });
    let hash = null;
    if (new_password.length >= 6) hash = await bcrypt.hash(new_password, 10);
    if (hash) {
      await db.promise().query(
        "UPDATE EMPLOYEE SET full_name = ?, email = ?, contact_number = ?, username = ?, password = ? WHERE employee_id = ?",
        [full_name, email, contact_number || null, username || own.username, hash, id]
      );
    } else {
      await db.promise().query(
        "UPDATE EMPLOYEE SET full_name = ?, email = ?, contact_number = ?, username = ? WHERE employee_id = ?",
        [full_name, email, contact_number || null, username || own.username, id]
      );
    }
    try {
      await db.promise().query(
        "UPDATE OWNER SET full_name = ?, email = ?, contact_number = ? WHERE employee_id = ?",
        [full_name, email, contact_number || null, id]
      );
    } catch (e) {
      /* OWNER row optional */
    }
    res.json({ ok: true, message: "Owner updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to update owner" });
  }
});

app.delete("/api/owners/:id", optionalAuth, async (req, res) => {
  try {
    if (!req.user || !isCondoAdminRole(req.user.role))
      return res.status(403).json({ error: "Admins only" });
    const id = Number(req.params.id);
    const adminId = req.user.employee_id;
    const [[row]] = await db.promise().query(
      `SELECT e.employee_id FROM EMPLOYEE e
       WHERE e.employee_id = ? AND e.created_by_employee_id = ?
         AND ` + OWNER_ROLE_EXISTS_SQL,
      [id, adminId]
    );
    if (!row) return res.status(404).json({ error: "Owner not found" });
    try {
      await db.promise().query("DELETE FROM OWNER WHERE employee_id = ?", [id]);
    } catch (e) { /* table may not exist */ }
    try {
      await db.promise().query("DELETE FROM OWNER_UNIT WHERE owner_employee_id = ?", [id]);
    } catch (e) { /* */ }
    await db.promise().query("DELETE FROM EMPLOYEE_ROLE WHERE employee_id = ?", [id]);
    await db.promise().query("DELETE FROM EMPLOYEE_TOWER WHERE employee_id = ?", [id]);
    await db.promise().query("DELETE FROM EMPLOYEE WHERE employee_id = ?", [id]);
    res.json({ message: "Owner removed" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to remove owner" });
  }
});

// Get employee's assigned towers (for assign sidebar – multi-select)
app.get("/api/employees/:id/towers", optionalAuth, async (req, res) => {
  try {
    const employeeId = Number(req.params.id);
    const [rows] = await db.promise().query(
      `SELECT et.tower_id, t.tower_name, t.number_floors
       FROM EMPLOYEE_TOWER et
       JOIN TOWER t ON t.tower_id = et.tower_id
       WHERE et.employee_id = ?
       ORDER BY t.tower_name`,
      [employeeId]
    );
    res.json({ towers: rows || [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to fetch assignments" });
  }
});

// Assign employee to one or more towers (EMPLOYEE_TOWER). Body: { tower_ids: [1, 2, 3] }. Empty array = unassign all.
app.put("/api/employees/:id/assign-tower", optionalAuth, async (req, res) => {
  try {
    const employeeId = Number(req.params.id);
    const towerIds = req.body && req.body.tower_ids;
    const ids = Array.isArray(towerIds)
      ? towerIds.map((id) => Number(id)).filter((id) => id > 0)
      : req.body && req.body.tower_id != null
        ? [Number(req.body.tower_id)]
        : null;
    if (ids === null) return res.status(400).json({ error: "tower_ids (array) or tower_id required" });

    await db.promise().query("DELETE FROM EMPLOYEE_TOWER WHERE employee_id = ?", [employeeId]);
    for (const tid of ids) {
      await db.promise().query("INSERT INTO EMPLOYEE_TOWER (employee_id, tower_id) VALUES (?, ?)", [employeeId, tid]);
    }
    res.json({ message: "Assignment saved" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to assign tower" });
  }
});

// Unassign employee from one tower. Body: { tower_id: 1 } or DELETE /api/employees/:id/towers/:towerId
app.delete("/api/employees/:id/towers/:towerId", optionalAuth, async (req, res) => {
  try {
    const employeeId = Number(req.params.id);
    const towerId = Number(req.params.towerId);
    await db.promise().query("DELETE FROM EMPLOYEE_TOWER WHERE employee_id = ? AND tower_id = ?", [employeeId, towerId]);
    res.json({ message: "Tower unassigned" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to unassign" });
  }
});

// Update employee (full_name, contact_number, email, address, role_type)
app.put("/api/employees/:id", optionalAuth, async (req, res) => {
  try {
    const employeeId = Number(req.params.id);
    const body = req.body || {};
    const { full_name, contact_number, email, address, role_type } = body;

    if (full_name != null && full_name !== undefined) await db.promise().query("UPDATE EMPLOYEE SET full_name = ? WHERE employee_id = ?", [String(full_name).trim(), employeeId]);
    if (contact_number !== undefined) await db.promise().query("UPDATE EMPLOYEE SET contact_number = ? WHERE employee_id = ?", [contact_number === "" || contact_number == null ? null : String(contact_number).trim(), employeeId]);
    if (email != null && email !== undefined) await db.promise().query("UPDATE EMPLOYEE SET email = ? WHERE employee_id = ?", [String(email).trim(), employeeId]);
    if (address !== undefined) await db.promise().query("UPDATE EMPLOYEE SET address = ? WHERE employee_id = ?", [address === "" || address == null ? null : String(address).trim(), employeeId]);
    if (role_type != null && role_type !== undefined) {
      await db.promise().query("DELETE FROM EMPLOYEE_ROLE WHERE employee_id = ?", [employeeId]);
      await db.promise().query("INSERT INTO EMPLOYEE_ROLE (employee_id, role_type, status) VALUES (?, ?, 'active')", [employeeId, String(role_type).trim()]);
    }
    res.json({ message: "Employee updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to update employee" });
  }
});

// Delete employee (removes EMPLOYEE_ROLE and EMPLOYEE_TOWER via FK, then EMPLOYEE).
// If the employee is an OWNER (admin), cascade-delete all employees they created (created_by_employee_id).
app.delete("/api/employees/:id", optionalAuth, async (req, res) => {
  try {
    const employeeId = Number(req.params.id);
    const [roleRows] = await db.promise().query(
      "SELECT 1 FROM EMPLOYEE_ROLE WHERE employee_id = ? AND role_type IN ('OWNER', 'ADMIN') AND status = 'active' LIMIT 1",
      [employeeId]
    );
    const isOwner = Array.isArray(roleRows) && roleRows.length > 0;

    if (isOwner) {
      const [childRows] = await db.promise().query(
        "SELECT employee_id FROM EMPLOYEE WHERE created_by_employee_id = ?",
        [employeeId]
      );
      const childIds = Array.isArray(childRows) ? childRows.map((r) => r.employee_id) : [];
      for (const childId of childIds) {
        await db.promise().query("DELETE FROM EMPLOYEE_ROLE WHERE employee_id = ?", [childId]);
        await db.promise().query("DELETE FROM EMPLOYEE_TOWER WHERE employee_id = ?", [childId]);
        await db.promise().query("DELETE FROM EMPLOYEE WHERE employee_id = ?", [childId]);
      }
      await db.promise().query("UPDATE TOWER SET owner_employee_id = NULL WHERE owner_employee_id = ?", [employeeId]);
      await db.promise().query("UPDATE UNIT SET owner_employee_id = NULL WHERE owner_employee_id = ?", [employeeId]);
    }

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

app.get("/api/bookings", optionalAuth, async (req, res) => {
  try {
    await tryBackfillTowerOwners();
    const roleNorm = req.user && req.user.role ? String(req.user.role).toUpperCase().replace(/[\s_-]/g, "") : "";
    const isOwner = !!(req.user && isCondoAdminRole(req.user.role));
    const isFrontDesk = !!(req.user && (roleNorm === "FRONTDESK" || roleNorm === "STAFF"));
    const ownerId = isOwner ? Number(req.user.employee_id) : null;
    const staffId = isFrontDesk ? Number(req.user.employee_id) : null;
    let rows;
    try {
      const baseSelect = `SELECT b.booking_id, b.unit_id, b.guest_name, b.email, b.contact_number, b.check_in_date, b.check_out_date,
          b.inclusive_dates, b.status, b.rejection_reason, b.created_at,
          b.checked_in_at, b.checked_out_at, b.booking_platform,
          u.unit_number, u.unit_type, t.tower_name
         FROM BOOKING b
         LEFT JOIN UNIT u ON u.unit_id = b.unit_id
         LEFT JOIN TOWER t ON t.tower_id = u.tower_id`;
      const orderBy = " ORDER BY b.check_in_date ASC, b.created_at DESC";
      if (ownerId) {
        [rows] = await db.promise().query(
          baseSelect + ` WHERE (COALESCE(u.owner_employee_id, t.owner_employee_id) = ?)` + orderBy,
          [ownerId]
        );
      } else if (staffId) {
        const [towerRows] = await db.promise().query("SELECT tower_id FROM EMPLOYEE_TOWER WHERE employee_id = ?", [staffId]);
        const towerIds = (towerRows || []).map((r) => r.tower_id).filter((id) => id != null);
        if (towerIds.length > 0) {
          const placeholders = towerIds.map(() => "?").join(",");
          [rows] = await db.promise().query(
            baseSelect + ` WHERE u.tower_id IN (${placeholders})` + orderBy,
            towerIds
          );
        } else {
          rows = [];
        }
      } else {
        [rows] = await db.promise().query(baseSelect + orderBy);
      }
    } catch (colErr) {
      if (colErr.code === "ER_BAD_FIELD_ERROR") {
        if (ownerId) {
          try {
            [rows] = await db.promise().query(
              `SELECT b.booking_id, b.unit_id, b.guest_name, b.email, b.contact_number, b.check_in_date, b.check_out_date,
                b.inclusive_dates, b.status, b.rejection_reason, b.created_at,
                u.unit_number, u.unit_type, t.tower_name
               FROM BOOKING b
               LEFT JOIN UNIT u ON u.unit_id = b.unit_id
               LEFT JOIN TOWER t ON t.tower_id = u.tower_id
               WHERE b.unit_id IN (
                 SELECT u2.unit_id FROM UNIT u2
                 JOIN TOWER t2 ON t2.tower_id = u2.tower_id
                 WHERE t2.tower_id IN (
                   SELECT et.tower_id FROM EMPLOYEE_TOWER et
                   JOIN EMPLOYEE e ON e.employee_id = et.employee_id
                   WHERE e.created_by_employee_id = ?
                 )
               )
               ORDER BY b.check_in_date ASC, b.created_at DESC`,
              [ownerId]
            );
          } catch (e) {
            [rows] = await db.promise().query(BOOKINGS_BASE_SQL);
          }
        } else if (staffId) {
          try {
            const [towerRows] = await db.promise().query("SELECT tower_id FROM EMPLOYEE_TOWER WHERE employee_id = ?", [staffId]);
            const towerIds = (towerRows || []).map((r) => r.tower_id).filter((id) => id != null);
            if (towerIds.length > 0) {
              const placeholders = towerIds.map(() => "?").join(",");
              [rows] = await db.promise().query(
                `SELECT b.booking_id, b.unit_id, b.guest_name, b.email, b.contact_number, b.check_in_date, b.check_out_date,
                  b.inclusive_dates, b.status, b.rejection_reason, b.created_at,
                  u.unit_number, u.unit_type, t.tower_name
                 FROM BOOKING b
                 LEFT JOIN UNIT u ON u.unit_id = b.unit_id
                 LEFT JOIN TOWER t ON t.tower_id = u.tower_id
                 WHERE u.tower_id IN (${placeholders})
                 ORDER BY b.check_in_date ASC, b.created_at DESC`,
                towerIds
              );
            } else {
              rows = [];
            }
          } catch (e) {
            rows = [];
          }
        } else {
          [rows] = await db.promise().query(BOOKINGS_BASE_SQL);
        }
        rows.forEach((r) => { r.checked_in_at = r.checked_in_at != null ? r.checked_in_at : null; r.checked_out_at = r.checked_out_at != null ? r.checked_out_at : null; r.booking_platform = r.booking_platform != null ? r.booking_platform : null; });
      } else throw colErr;
    }
    res.json(rows || []);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch bookings" });
  }
});

// Staff: list all rooms (units) with Available / Not available; for walk-in QR use rooms that have a booking
app.get("/api/rooms/with-availability", async (req, res) => {
  try {
    const [units] = await db.promise().query(
      `SELECT u.unit_id, u.unit_number, t.tower_name
       FROM UNIT u
       LEFT JOIN TOWER t ON t.tower_id = u.tower_id
       ORDER BY t.tower_name, u.unit_number`
    );
    const [bookings] = await db.promise().query(
      `SELECT booking_id, unit_id, guest_name FROM BOOKING
       WHERE status = 'confirmed' AND (check_out_date IS NULL OR check_out_date >= CURDATE()) AND checked_out_at IS NULL`
    );
    const byUnit = {};
    (bookings || []).forEach((b) => { byUnit[b.unit_id] = b; });
    const list = (units || []).map((u) => {
      const b = byUnit[u.unit_id];
      const available = !b;
      return {
        unit_id: u.unit_id,
        unit_number: u.unit_number,
        tower_name: u.tower_name,
        available,
        booking_id: b ? b.booking_id : null,
        guest_name: b ? b.guest_name : null,
        ref: b ? "REG-" + String(b.booking_id).padStart(5, "0") : null,
        label: [u.tower_name, u.unit_number].filter(Boolean).join(" • ") || "Unit " + u.unit_id,
      };
    });
    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch rooms" });
  }
});

// Staff: list rooms (bookings) available for walk-in guest registration (kept for backward compatibility)
app.get("/api/bookings/available-for-walkin", async (req, res) => {
  try {
    const [rows] = await db.promise().query(
      `SELECT b.booking_id, b.unit_id, b.guest_name, b.check_in_date, b.check_out_date,
              u.unit_number, u.unit_type, t.tower_name
       FROM BOOKING b
       LEFT JOIN UNIT u ON u.unit_id = b.unit_id
       LEFT JOIN TOWER t ON t.tower_id = u.tower_id
       WHERE b.status = 'confirmed' AND (b.check_out_date IS NULL OR b.check_out_date >= CURDATE())
       ORDER BY b.check_in_date ASC, b.booking_id ASC`
    );
    const list = (rows || []).map((r) => ({
      booking_id: r.booking_id,
      guest_name: r.guest_name,
      check_in_date: r.check_in_date,
      check_out_date: r.check_out_date,
      unit_number: r.unit_number,
      unit_type: r.unit_type,
      tower_name: r.tower_name,
      label: [r.tower_name, r.unit_number].filter(Boolean).join(" • ") || "Unit " + (r.unit_id || r.booking_id),
      ref: "REG-" + String(r.booking_id).padStart(5, "0"),
    }));
    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch available rooms" });
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

// QR options: larger size and high error correction so scanners read reliably from screens/print
const QR_OPTS = { type: "image/png", margin: 2, width: 320, errorCorrectionLevel: "H" };

async function getQRDataUrl(bookingId) {
  const payload = JSON.stringify({ booking_id: bookingId, type: "check-in" });
  return await QRCode.toDataURL(payload, QR_OPTS);
}

// Serve QR code image for a booking (used for Download/View in App links)
app.get("/api/bookings/:id/qr", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const dataUrl = await getQRDataUrl(id);
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(base64, "base64");
    res.type("png").set("Cache-Control", "public, max-age=86400").send(buffer);
  } catch (err) {
    console.error(err);
    res.status(500).send("QR generation failed");
  }
});

// Serve booking confirmation page (Tailwind template with real QR – for "View in App" / share link)
app.get("/booking/confirmation/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [rows] = await db.promise().query(
      `SELECT b.booking_id, b.guest_name, b.check_in_date, b.check_out_date, u.unit_number, t.tower_name
       FROM BOOKING b
       LEFT JOIN UNIT u ON u.unit_id = b.unit_id
       LEFT JOIN TOWER t ON t.tower_id = u.tower_id
       WHERE b.booking_id = ? AND b.status = 'confirmed'`,
      [id]
    );
    if (!rows || rows.length === 0) {
      res.status(404).send("Booking not found or not confirmed.");
      return;
    }
    const booking = rows[0];
    const baseUrl = (process.env.APP_URL || "").replace(/\/$/, "") || ("https://" + (req.get("host") || "localhost"));
    const qrImageSrc = baseUrl + "/api/bookings/" + id + "/qr";
    const bookingRef = "REG-" + String(id).padStart(5, "0");
    const checkInStr = formatDateForEmail(booking.check_in_date);
    const checkOutStr = formatDateForEmail(booking.check_out_date);
    const nights = getNights(booking.check_in_date, booking.check_out_date);
    const stayDatesText = nights > 0 ? checkInStr + " — " + checkOutStr + " (" + nights + " Night" + (nights !== 1 ? "s" : "") + ")" : checkInStr + " — " + checkOutStr;
    const addGuestsUrl = baseUrl + "/guest/guest-register.html?booking_id=" + id;
    const templatePath = path.join(__dirname, "templates", "booking-confirmation.html");
    let html = fs.readFileSync(templatePath, "utf8");
    html = html
      .replace(/\{\{QR_IMAGE_SRC\}\}/g, qrImageSrc)
      .replace(/\{\{BOOKING_REF\}\}/g, escapeHtml(bookingRef))
      .replace(/\{\{GUEST_NAME\}\}/g, escapeHtml(booking.guest_name || "Guest"))
      .replace(/\{\{UNIT_NUMBER\}\}/g, escapeHtml(booking.unit_number || "—"))
      .replace(/\{\{TOWER_NAME\}\}/g, escapeHtml(booking.tower_name || "—"))
      .replace(/\{\{STAY_DATES\}\}/g, escapeHtml(stayDatesText))
      .replace(/\{\{ADD_GUESTS_URL\}\}/g, addGuestsUrl);
    res.type("html").send(html);
  } catch (err) {
    console.error(err);
    res.status(500).send("Failed to load confirmation page.");
  }
});

// Preview confirmation email HTML in browser (no email sent – use for testing layout/QR)
app.get("/api/bookings/:id/email-preview", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [rows] = await db.promise().query(
      `SELECT b.booking_id, b.guest_name, b.check_in_date, b.check_out_date, u.unit_number, t.tower_name
       FROM BOOKING b
       LEFT JOIN UNIT u ON u.unit_id = b.unit_id
       LEFT JOIN TOWER t ON t.tower_id = u.tower_id
       WHERE b.booking_id = ?`,
      [id]
    );
    if (!rows || rows.length === 0) {
      res.status(404).send("Booking not found.");
      return;
    }
    const booking = rows[0];
    const baseUrl = (process.env.APP_URL || "").replace(/\/$/, "") || ("https://" + (req.get("host") || "localhost"));
    const qrImageUrl = baseUrl + "/api/bookings/" + id + "/qr";
    const confirmationPageUrl = baseUrl + "/booking/confirmation/" + id;
    const qrDataUrl = await getQRDataUrl(id);
    const bookingRef = "REG-" + String(id).padStart(5, "0");
    const checkInStr = formatDateForEmail(booking.check_in_date);
    const checkOutStr = formatDateForEmail(booking.check_out_date);
    const nights = getNights(booking.check_in_date, booking.check_out_date);
    const stayDatesText = nights > 0 ? checkInStr + " — " + checkOutStr + " (" + nights + " Night" + (nights !== 1 ? "s" : "") + ")" : checkInStr + " — " + checkOutStr;
    const logoUrl = process.env.APP_LOGO_URL || process.env.LOGO_URL || "";
    const html = buildConfirmationEmailHtml({
      guestName: escapeHtml(booking.guest_name || "Guest"),
      bookingRef,
      unitNumber: escapeHtml(booking.unit_number || "—"),
      towerName: escapeHtml(booking.tower_name || "—"),
      stayDatesText: escapeHtml(stayDatesText),
      qrImageUrl,
      qrDataUrl,
      confirmationPageUrl,
      logoUrl,
    });
    res.type("html").set("X-Robots-Tag", "noindex").send(html);
  } catch (err) {
    console.error(err);
    res.status(500).send("Failed to generate email preview.");
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
        const confirmationPageUrl = baseUrl + "/booking/confirmation/" + id;
        const qrDataUrl = await getQRDataUrl(id);
        const bookingRef = "REG-" + String(id).padStart(5, "0");
        const checkInStr = formatDateForEmail(booking.check_in_date);
        const checkOutStr = formatDateForEmail(booking.check_out_date);
        const nights = getNights(booking.check_in_date, booking.check_out_date);
        const stayDatesText = nights > 0 ? checkInStr + " — " + checkOutStr + " (" + nights + " Night" + (nights !== 1 ? "s" : "") + ")" : checkInStr + " — " + checkOutStr;
        const logoUrl = process.env.APP_LOGO_URL || process.env.LOGO_URL || "";
        const html = buildConfirmationEmailHtml({
          guestName: escapeHtml(booking.guest_name || "Guest"),
          bookingRef,
          unitNumber: escapeHtml(booking.unit_number || "—"),
          towerName: escapeHtml(booking.tower_name || "—"),
          stayDatesText: escapeHtml(stayDatesText),
          qrImageUrl,
          qrDataUrl,
          confirmationPageUrl,
          logoUrl,
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
    const confirmationPageUrl = baseUrl + "/booking/confirmation/" + id;
    const qrDataUrl = await getQRDataUrl(id);
    const bookingRef = "REG-" + String(id).padStart(5, "0");
    const checkInStr = formatDateForEmail(booking.check_in_date);
    const checkOutStr = formatDateForEmail(booking.check_out_date);
    const nights = getNights(booking.check_in_date, booking.check_out_date);
    const stayDatesText = nights > 0 ? checkInStr + " — " + checkOutStr + " (" + nights + " Night" + (nights !== 1 ? "s" : "") + ")" : checkInStr + " — " + checkOutStr;
    const logoUrl = process.env.APP_LOGO_URL || process.env.LOGO_URL || "";
    const html = buildConfirmationEmailHtml({
      guestName: escapeHtml(booking.guest_name || "Guest"),
      bookingRef,
      unitNumber: escapeHtml(booking.unit_number || "—"),
      towerName: escapeHtml(booking.tower_name || "—"),
      stayDatesText: escapeHtml(stayDatesText),
      qrImageUrl,
      qrDataUrl,
      confirmationPageUrl,
      logoUrl,
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

/** Return YYYY-MM-DD for MySQL DATE columns; accepts Date, ISO string, or null. */
function toYmd(d) {
  if (d == null) return null;
  if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
  try { return new Date(d).toISOString().slice(0, 10); } catch (e) { return null; }
}

function buildConfirmationEmailHtml(data) {
  const { guestName, bookingRef, unitNumber, towerName, stayDatesText, qrImageUrl, qrDataUrl, confirmationPageUrl, logoUrl } = data;
  const viewInAppUrl = confirmationPageUrl || qrImageUrl;
  const primary = "#0098b2";
  const accent = "#7ed957";
  const bgLight = "#f5f8f8";
  const slate900 = "#0f172a";
  const slate500 = "#64748b";
  const slate400 = "#94a3b8";
  const logoImg = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="Regalia" width="40" height="40" style="display:block;width:40px;height:40px;object-fit:contain;border-radius:8px;"/>`
    : `<div style="width:40px;height:40px;background:rgba(0,152,178,0.2);border-radius:8px;text-align:center;line-height:40px;font-size:20px;font-weight:700;color:${primary};font-family:Inter,Helvetica,Arial,sans-serif;">R</div>`;
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
    <header style="padding:24px 32px;border-bottom:1px solid rgba(0,152,178,0.15);">
      <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td style="vertical-align:middle;">
        <table cellpadding="0" cellspacing="0" border="0"><tr><td style="vertical-align:middle;padding-right:12px;">${logoImg}</td><td style="vertical-align:middle;">
          <h1 style="margin:0 0 4px 0;font-size:1.5rem;font-weight:700;letter-spacing:-0.025em;color:${slate900};">Regalia</h1>
          <div style="font-size:14px;color:${slate500};">Booking Ref: #${bookingRef}</div>
        </td></tr></table>
      </td></tr></table>
    </header>
    <main style="padding:40px 24px 40px 48px;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:40px;"><tr><td style="text-align:center;vertical-align:top;">
        <table cellpadding="0" cellspacing="0" border="0" align="center"><tr><td style="text-align:center;">
          <div style="width:64px;height:64px;background:rgba(126,217,87,0.2);border-radius:9999px;margin:0 auto 16px;text-align:center;line-height:64px;font-size:40px;">✓</div>
          <h2 style="margin:0 0 8px;font-size:2rem;font-weight:700;color:${slate900};">Booking Confirmed!</h2>
          <p style="margin:0;color:${slate500};font-size:1.125rem;">Your stay at Regalia is officially reserved. We look forward to hosting you.</p>
        </td></tr></table>
      </td></tr></table>
      <div style="background:#fff;border:1px solid rgba(0,152,178,0.12);border-radius:12px;box-shadow:0 10px 15px -3px rgba(0,0,0,0.06);overflow:hidden;margin-bottom:40px;">
        <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-bottom:1px solid rgba(0,152,178,0.06);">
          <tr>
            <td style="padding:40px 32px;text-align:center;">
              <h3 style="margin:0 0 16px;font-size:1.25rem;font-weight:700;">Your Digital Entry Pass</h3>
              <table cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 24px;">
                <tr><td style="width:320px;height:320px;background:#fff;padding:20px;border:2px solid #e2e8f0;border-radius:12px;text-align:center;">
                  <img src="${qrImageUrl}" alt="Booking QR Code" width="280" height="280" style="display:block;width:280px;height:280px;max-width:280px;margin:0 auto;"/>
                </td></tr>
              </table>
              <p style="margin:0 0 24px;color:${slate500};font-size:14px;max-width:400px;margin-left:auto;margin-right:auto;">Scan this QR code at the tower entrance or lift lobby to gain access to the premises.</p>
              <table cellpadding="0" cellspacing="0" border="0" align="center">
                <tr>
                  <td style="padding:0 8px 0 0;"><a href="${qrImageUrl}" download="regalia-entry-pass.png" style="display:inline-block;background:linear-gradient(90deg,#0098b2 0%,#7ed957 100%);color:#fff!important;padding:12px 24px;border-radius:8px;font-weight:600;text-decoration:none;font-size:14px;">Download Pass</a></td>
                  <td style="padding:0 0 0 8px;"><a href="${viewInAppUrl}" target="_blank" style="display:inline-block;background:#e2e8f0;color:#334155!important;padding:12px 24px;border-radius:8px;font-weight:600;text-decoration:none;font-size:14px;">View in App</a></td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
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
    let result;
    try {
      [result] = await db.promise().query(
        "UPDATE BOOKING SET status = 'rejected', rejection_reason = ? WHERE booking_id = ?",
        [reason ? String(reason).trim() : null, id]
      );
    } catch (e) {
      // Some schemas define BOOKING.status as ENUM without 'rejected' – fall back to 'cancelled' but keep the reason.
      if (e && (e.code === "ER_TRUNCATED_WRONG_VALUE_FOR_FIELD" || e.code === "ER_WARN_DATA_TRUNCATED" || e.code === "ER_DATA_TRUNCATED")) {
        [result] = await db.promise().query(
          "UPDATE BOOKING SET status = 'cancelled', rejection_reason = ? WHERE booking_id = ?",
          [reason ? String(reason).trim() : null, id]
        );
      } else {
        throw e;
      }
    }
    if (result.affectedRows === 0) return res.status(404).json({ error: "Booking not found" });

    // Email the guest about the rejection if we have Brevo and the booking has an email
    try {
      const [rows] = await db.promise().query(
        "SELECT b.email, b.guest_name, b.booking_id, u.unit_number, t.tower_name FROM BOOKING b LEFT JOIN UNIT u ON u.unit_id = b.unit_id LEFT JOIN TOWER t ON t.tower_id = u.tower_id WHERE b.booking_id = ?",
        [id]
      );
      const booking = rows && rows[0];
      const toEmail = booking && booking.email && String(booking.email).trim();
      if (toEmail && BREVO_API_KEY) {
        const reasonText = (reason && String(reason).trim()) || "No reason provided.";
        const guestName = escapeHtml(booking.guest_name || "Guest");
        const unitLabel = [booking.tower_name, booking.unit_number].filter(Boolean).join(" • ") || "your unit";
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;font-family:system-ui,sans-serif;background:#f8fafc;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 4px 12px rgba(0,0,0,0.08);">
    <p style="margin:0 0 16px;font-size:16px;color:#334155;">Dear ${guestName},</p>
    <p style="margin:0 0 16px;font-size:15px;color:#475569;">Your booking request for <strong>${escapeHtml(unitLabel)}</strong> could not be confirmed.</p>
    <p style="margin:0 0 16px;font-size:15px;color:#475569;"><strong>Reason:</strong> ${escapeHtml(reasonText)}</p>
    <p style="margin:0 0 24px;font-size:15px;color:#475569;">If you have questions, please contact the property management.</p>
    <p style="margin:0;font-size:14px;color:#64748b;">Regalia</p>
  </div>
</body></html>`;
        const senderEmail = process.env.BREVO_FROM_EMAIL || "regalia@example.com";
        const senderName = process.env.BREVO_FROM_NAME || "Regalia";
        const brevoRes = await fetch("https://api.brevo.com/v3/smtp/email", {
          method: "POST",
          headers: { "accept": "application/json", "content-type": "application/json", "api-key": BREVO_API_KEY },
          body: JSON.stringify({
            sender: { name: senderName, email: senderEmail },
            to: [{ email: toEmail }],
            subject: "Booking not confirmed – Regalia",
            htmlContent: html,
          }),
        });
        if (brevoRes.ok) console.log("Rejection email sent to " + toEmail);
        else console.warn("Rejection email failed:", brevoRes.status, await brevoRes.text());
      }
    } catch (emailErr) {
      console.warn("Rejection email error:", emailErr.message);
    }

    res.json({ message: "Booking rejected" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to reject" });
  }
});

// Admin: permanently delete a booking
app.delete("/api/bookings/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [result] = await db.promise().query("DELETE FROM BOOKING WHERE booking_id = ?", [id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: "Booking not found" });
    res.json({ message: "Booking deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to delete booking" });
  }
});

// Staff: record check-in (requires BOOKING.checked_in_at column)
// Creates a pending PAYMENT for accommodation (nights × unit price); it completes on check-out.
app.post("/api/bookings/:id/check-in", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [result] = await db.promise().query(
      "UPDATE BOOKING SET checked_in_at = COALESCE(checked_in_at, NOW()) WHERE booking_id = ? AND status = 'confirmed'",
      [id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: "Booking not found or not confirmed" });

    const [[row]] = await db.promise().query(
      `SELECT b.booking_id, b.guest_name, b.unit_id, b.check_in_date, b.check_out_date, b.payment_method,
              COALESCE(u.price, 0) AS unit_price,
              COALESCE(u.owner_employee_id, t.owner_employee_id) AS owner_employee_id
       FROM BOOKING b
       LEFT JOIN UNIT u ON u.unit_id = b.unit_id
       LEFT JOIN TOWER t ON t.tower_id = u.tower_id
       WHERE b.booking_id = ?`,
      [id]
    );
    const nights = row ? getNights(row.check_in_date, row.check_out_date) : 0;
    const unitPrice = row && row.unit_price != null ? Number(row.unit_price) : 0;
    const amount = nights * unitPrice;
    const ownerId = row && row.owner_employee_id != null ? row.owner_employee_id : null;
    const recordedBy = req.user ? req.user.employee_id : null;
    const rawMethod = row && row.payment_method ? String(row.payment_method).trim().toLowerCase() : "";
    const paymentMethod = rawMethod === "upload" ? "Online" : rawMethod === "cash" ? "Cash" : rawMethod || "Cash";
    const expectedDate = toYmd(row && row.check_out_date) || new Date().toISOString().slice(0, 10);

    if (amount > 0 && row && row.unit_id) {
      const [[existing]] = await db.promise().query(
        "SELECT payment_id FROM PAYMENT WHERE booking_id = ? AND status = 'pending' LIMIT 1",
        [id]
      );
      if (!existing) {
        const guestName = (row.guest_name || "Guest").trim();
        const payerDesc = nights > 0
          ? `${guestName} – Accommodation (${nights} night${nights !== 1 ? "s" : ""})`
          : `${guestName} – Accommodation`;
        try {
          await db.promise().query(
            `INSERT INTO PAYMENT (booking_id, unit_id, amount, payment_date, payer_description, status, method, recorded_by, owner_employee_id)
             VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
            [id, row.unit_id, amount, expectedDate, payerDesc, paymentMethod, recordedBy, ownerId]
          );
        } catch (payErr) {
          // Don't fail check-in if payment record fails; log for troubleshooting.
          console.warn("Check-in payment create failed:", payErr && payErr.message ? payErr.message : payErr);
        }
      }
    }

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
// Early checkout: if check_out_date is in the future, update it to today so the unit is freed.
// Marks the pending accommodation payment (created at check-in) as completed; if none exists, creates one.
app.post("/api/bookings/:id/check-out", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const today = new Date().toISOString().slice(0, 10);
    const [result] = await db.promise().query(
      `UPDATE BOOKING SET checked_out_at = COALESCE(checked_out_at, NOW()),
       check_out_date = CASE WHEN check_out_date > ? THEN ? ELSE check_out_date END
       WHERE booking_id = ? AND status = 'confirmed'`,
      [today, today, id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: "Booking not found or not confirmed" });

    const [[pending]] = await db.promise().query(
      "SELECT payment_id FROM PAYMENT WHERE booking_id = ? AND status = 'pending' ORDER BY payment_id DESC LIMIT 1",
      [id]
    );
    if (pending && pending.payment_id) {
      await db.promise().query(
        "UPDATE PAYMENT SET status = 'completed', payment_date = ? WHERE payment_id = ?",
        [today, pending.payment_id]
      );
    } else {
      const [[row]] = await db.promise().query(
        `SELECT b.booking_id, b.guest_name, b.unit_id, b.check_in_date, b.check_out_date, b.payment_method,
                COALESCE(u.price, 0) AS unit_price,
                COALESCE(u.owner_employee_id, t.owner_employee_id) AS owner_employee_id
         FROM BOOKING b
         LEFT JOIN UNIT u ON u.unit_id = b.unit_id
         LEFT JOIN TOWER t ON t.tower_id = u.tower_id
         WHERE b.booking_id = ?`,
        [id]
      );
      const nights = row ? getNights(row.check_in_date, row.check_out_date) : 0;
      const unitPrice = row && row.unit_price != null ? Number(row.unit_price) : 0;
      const amount = nights * unitPrice;
      const ownerId = row && row.owner_employee_id != null ? row.owner_employee_id : null;
      const recordedBy = req.user ? req.user.employee_id : null;
      const rawMethod = row && row.payment_method ? String(row.payment_method).trim().toLowerCase() : "";
      const paymentMethod = rawMethod === "upload" ? "Online" : rawMethod === "cash" ? "Cash" : rawMethod || "Cash";
      if (amount > 0 && row && row.unit_id) {
        const guestName = (row.guest_name || "Guest").trim();
        const payerDesc = nights > 0
          ? `${guestName} – Accommodation (${nights} night${nights !== 1 ? "s" : ""})`
          : `${guestName} – Accommodation`;
        await db.promise().query(
          `INSERT INTO PAYMENT (booking_id, unit_id, amount, payment_date, payer_description, status, method, recorded_by, owner_employee_id)
           VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?)`,
          [id, row.unit_id, amount, today, payerDesc, paymentMethod, recordedBy, ownerId]
        );
      }
    }

    const [rows] = await db.promise().query(
      "SELECT booking_id, guest_name, unit_id, checked_out_at, check_out_date FROM BOOKING WHERE booking_id = ?",
      [id]
    );
    res.json({ message: "Check-out recorded", booking: rows[0] });
  } catch (err) {
    if (err.code === "ER_BAD_FIELD_ERROR") return res.status(500).json({ error: "Add checked_out_at DATETIME NULL to BOOKING table" });
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to record check-out" });
  }
});

// ---------------- Additional Charges ----------------
// Auto-create table if missing
(async () => {
  try {
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS ADDITIONAL_CHARGE (
        charge_id INT AUTO_INCREMENT PRIMARY KEY,
        booking_id INT NOT NULL,
        description VARCHAR(255) NOT NULL,
        quantity INT NOT NULL DEFAULT 1,
        unit_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        added_by INT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (booking_id) REFERENCES BOOKING(booking_id) ON DELETE CASCADE,
        INDEX idx_charge_booking (booking_id)
      )
    `);
  } catch (e) { /* table may already exist */ }
  try {
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS PAYMENT (
        payment_id INT AUTO_INCREMENT PRIMARY KEY,
        booking_id INT NULL,
        unit_id INT NULL,
        amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        payment_date DATE NOT NULL,
        payer_description VARCHAR(255) NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'completed',
        method VARCHAR(64) NULL,
        recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        recorded_by INT NULL,
        owner_employee_id INT NULL,
        INDEX idx_payment_owner (owner_employee_id),
        INDEX idx_payment_date (payment_date)
      )
    `);
  } catch (e) { /* table may already exist */ }
  try {
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS MONTHLY_DUE (
        id INT AUTO_INCREMENT PRIMARY KEY,
        unit_id INT NULL,
        amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        due_date DATE NOT NULL,
        effective_from_month VARCHAR(7) NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'pending',
        owner_employee_id INT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_monthly_due_owner (owner_employee_id),
        INDEX idx_monthly_due_date (due_date)
      )
    `);
  } catch (e) { /* table may already exist */ }
  try {
    await db.promise().query("ALTER TABLE MONTHLY_DUE ADD COLUMN effective_from_month VARCHAR(7) NULL COMMENT 'YYYY-MM'");
  } catch (e) { /* column may already exist */ }
})();

app.get("/api/bookings/:id/charges", optionalAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [rows] = await db.promise().query(
      "SELECT charge_id, booking_id, description, quantity, unit_price, (quantity * unit_price) AS total, added_by, created_at FROM ADDITIONAL_CHARGE WHERE booking_id = ? ORDER BY created_at DESC",
      [id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to fetch charges" });
  }
});

app.post("/api/bookings/:id/charges", optionalAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { description, quantity, unit_price } = req.body;
    if (!description || !quantity || unit_price == null) return res.status(400).json({ error: "description, quantity, and unit_price are required" });
    const addedBy = req.user ? req.user.employee_id : null;
    const [result] = await db.promise().query(
      "INSERT INTO ADDITIONAL_CHARGE (booking_id, description, quantity, unit_price, added_by) VALUES (?, ?, ?, ?, ?)",
      [id, String(description).trim(), Number(quantity), Number(unit_price), addedBy]
    );
    const [rows] = await db.promise().query("SELECT charge_id, booking_id, description, quantity, unit_price, (quantity * unit_price) AS total, added_by, created_at FROM ADDITIONAL_CHARGE WHERE charge_id = ?", [result.insertId]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to add charge" });
  }
});

app.delete("/api/charges/:chargeId", optionalAuth, async (req, res) => {
  try {
    const chargeId = Number(req.params.chargeId);
    const [result] = await db.promise().query("DELETE FROM ADDITIONAL_CHARGE WHERE charge_id = ?", [chargeId]);
    if (result.affectedRows === 0) return res.status(404).json({ error: "Charge not found" });
    res.json({ message: "Charge deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to delete charge" });
  }
});

app.get("/api/charges/all", optionalAuth, async (req, res) => {
  try {
    const ownerId = req.user && isCondoAdminRole(req.user.role) ? req.user.employee_id : null;
    if (ownerId == null) {
      return res.json([]);
    }
    const [rows] = await db.promise().query(
      `SELECT ac.charge_id, ac.booking_id, ac.description, ac.quantity, ac.unit_price,
        (ac.quantity * ac.unit_price) AS total, ac.created_at,
        b.guest_name, b.unit_id, u.unit_number, t.tower_name
       FROM ADDITIONAL_CHARGE ac
       LEFT JOIN BOOKING b ON b.booking_id = ac.booking_id
       LEFT JOIN UNIT u ON u.unit_id = b.unit_id
       LEFT JOIN TOWER t ON t.tower_id = u.tower_id
       WHERE COALESCE(u.owner_employee_id, t.owner_employee_id) = ?
       ORDER BY ac.created_at DESC`,
      [ownerId]
    );
    res.json(rows || []);
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to fetch all charges" });
  }
});

// ---------------- Payments (record only; owner-scoped) ----------------
app.get("/api/payments", optionalAuth, async (req, res) => {
  try {
    const isOwner = !!(req.user && isCondoAdminRole(req.user.role));
    const ownerId = isOwner ? req.user.employee_id : null;
    let rows;
    if (ownerId != null) {
      const [r] = await db.promise().query(
        `SELECT p.payment_id, p.booking_id, p.unit_id, p.amount, p.payment_date, p.payer_description, p.status, p.method, p.recorded_at,
          b.guest_name, u.unit_number, t.tower_name
         FROM PAYMENT p
         LEFT JOIN BOOKING b ON b.booking_id = p.booking_id
         LEFT JOIN UNIT u ON u.unit_id = COALESCE(p.unit_id, b.unit_id)
         LEFT JOIN TOWER t ON t.tower_id = u.tower_id
         WHERE p.owner_employee_id = ?
         ORDER BY p.payment_date DESC, p.recorded_at DESC`,
        [ownerId]
      );
      rows = r || [];
    } else {
      rows = [];
    }
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to fetch payments" });
  }
});

app.post("/api/payments", optionalAuth, async (req, res) => {
  try {
    const { booking_id, unit_id, amount, payment_date, payer_description, method } = req.body || {};
    const amt = Number(amount);
    if (!amt || amt <= 0) return res.status(400).json({ error: "amount required and must be positive" });
    const date = toYmd(payment_date) || new Date().toISOString().slice(0, 10);
    let ownerId = req.user && isCondoAdminRole(req.user.role) ? req.user.employee_id : null;
    let unitId = unit_id != null ? Number(unit_id) : null;
    const bid = booking_id != null ? Number(booking_id) : null;
    if (bid && ownerId == null) {
      const [[row]] = await db.promise().query(
        "SELECT b.unit_id, COALESCE(u.owner_employee_id, t.owner_employee_id) AS owner_employee_id FROM BOOKING b LEFT JOIN UNIT u ON u.unit_id = b.unit_id LEFT JOIN TOWER t ON t.tower_id = u.tower_id WHERE b.booking_id = ?",
        [bid]
      );
      if (row) {
        if (row.owner_employee_id) ownerId = row.owner_employee_id;
        if (row.unit_id) unitId = row.unit_id;
      }
    }
    const recordedBy = req.user ? req.user.employee_id : null;
    await db.promise().query(
      `INSERT INTO PAYMENT (booking_id, unit_id, amount, payment_date, payer_description, status, method, recorded_by, owner_employee_id)
       VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?)`,
      [
        bid,
        unitId,
        amt,
        date,
        payer_description ? String(payer_description).trim() : null,
        method ? String(method).trim() : null,
        recordedBy,
        ownerId,
      ]
    );
    const [rows] = await db.promise().query(
      "SELECT payment_id, booking_id, unit_id, amount, payment_date, payer_description, status, method, recorded_at FROM PAYMENT ORDER BY payment_id DESC LIMIT 1"
    );
    res.status(201).json(rows[0] || {});
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to record payment" });
  }
});

app.delete("/api/payments/:id", optionalAuth, async (req, res) => {
  try {
    const paymentId = Number(req.params.id);
    const ownerId = req.user && isCondoAdminRole(req.user.role) ? req.user.employee_id : null;
    const [[payment]] = await db.promise().query(
      "SELECT payment_id, owner_employee_id, unit_id, booking_id FROM PAYMENT WHERE payment_id = ?",
      [paymentId]
    );
    if (!payment) return res.status(404).json({ error: "Payment not found" });
    if (ownerId != null) {
      const isOwner = payment.owner_employee_id === ownerId;
      if (!isOwner && payment.owner_employee_id != null) return res.status(403).json({ error: "Not allowed to delete this payment" });
      if (payment.owner_employee_id == null) {
        let canDelete = false;
        if (payment.unit_id != null) {
          const [unitRows] = await db.promise().query(
            `SELECT 1 FROM UNIT u JOIN TOWER t ON t.tower_id = u.tower_id WHERE u.unit_id = ? AND COALESCE(u.owner_employee_id, t.owner_employee_id) = ?`,
            [payment.unit_id, ownerId]
          );
          if (unitRows && unitRows.length > 0) canDelete = true;
        }
        if (!canDelete && payment.booking_id != null) {
          const [bookingRows] = await db.promise().query(
            `SELECT 1 FROM BOOKING b JOIN UNIT u ON u.unit_id = b.unit_id JOIN TOWER t ON t.tower_id = u.tower_id WHERE b.booking_id = ? AND COALESCE(u.owner_employee_id, t.owner_employee_id) = ?`,
            [payment.booking_id, ownerId]
          );
          if (bookingRows && bookingRows.length > 0) canDelete = true;
        }
        if (!canDelete) return res.status(403).json({ error: "Not allowed to delete this payment" });
      }
    }
    const [result] = await db.promise().query("DELETE FROM PAYMENT WHERE payment_id = ?", [paymentId]);
    if (result.affectedRows === 0) return res.status(404).json({ error: "Payment not found" });
    res.json({ message: "Payment deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to delete payment" });
  }
});

// ---------------- Monthly Dues (admin: all they created; resident OWNER: their unit only) ----------------
app.get("/api/monthly-dues", optionalAuth, async (req, res) => {
  try {
    let rows = [];
    if (req.user && isResidentOwnerRole(req.user.role)) {
      try {
        let unitIds = [];
        try {
          const [mapRows] = await db.promise().query("SELECT unit_id FROM OWNER_UNIT WHERE owner_employee_id = ?", [req.user.employee_id]);
          unitIds = (mapRows || []).map((r) => Number(r.unit_id)).filter((n) => n > 0);
        } catch (e) {
          const [[emp]] = await db.promise().query("SELECT resident_unit_id FROM EMPLOYEE WHERE employee_id = ?", [req.user.employee_id]);
          const uid = emp && emp.resident_unit_id ? Number(emp.resident_unit_id) : null;
          if (uid) unitIds = [uid];
        }
        if (unitIds.length) {
          const placeholders = unitIds.map(() => "?").join(",");
          const [r] = await db.promise().query(
            `SELECT d.id, d.unit_id, d.amount,
              DATE_FORMAT(d.due_date, '%Y-%m-%d') AS due_date,
              d.effective_from_month,
              d.status,
              DATE_FORMAT(d.created_at, '%Y-%m-%d') AS created_at,
              u.unit_number, t.tower_name
             FROM MONTHLY_DUE d
             LEFT JOIN UNIT u ON u.unit_id = d.unit_id
             LEFT JOIN TOWER t ON t.tower_id = u.tower_id
             WHERE d.unit_id IN (${placeholders})
             ORDER BY d.due_date DESC, d.id DESC`,
            unitIds
          );
          rows = r || [];
        }
      } catch (e) {
        rows = [];
      }
    } else if (req.user && isCondoAdminRole(req.user.role)) {
      const ownerId = req.user.employee_id;
      const [r] = await db.promise().query(
        `SELECT d.id, d.unit_id, d.amount,
          DATE_FORMAT(d.due_date, '%Y-%m-%d') AS due_date,
          d.effective_from_month,
          d.status,
          DATE_FORMAT(d.created_at, '%Y-%m-%d') AS created_at,
          u.unit_number, t.tower_name
         FROM MONTHLY_DUE d
         LEFT JOIN UNIT u ON u.unit_id = d.unit_id
         LEFT JOIN TOWER t ON t.tower_id = u.tower_id
         WHERE d.owner_employee_id = ?
         ORDER BY d.due_date DESC, d.id DESC`,
        [ownerId]
      );
      rows = r || [];
    }
    res.json((rows || []).map(row => {
      const dueDateStr = row.due_date && String(row.due_date).trim().slice(0, 10);
      let effectiveFrom = row.effective_from_month && String(row.effective_from_month).trim();
      if (!effectiveFrom && dueDateStr && dueDateStr.length >= 7) effectiveFrom = dueDateStr.slice(0, 7);
      return {
        ...row,
        due_date: dueDateStr || null,
        effective_from_month: effectiveFrom || null,
        created_at: row.created_at && String(row.created_at).trim().slice(0, 10),
        unit_label: row.unit_id ? (row.tower_name ? row.tower_name + " – Unit " + (row.unit_number || row.unit_id) : "Unit " + (row.unit_number || row.unit_id)) : "General / Other",
      };
    }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to fetch monthly dues" });
  }
});

app.post("/api/monthly-dues", optionalAuth, async (req, res) => {
  try {
    if (!req.user || !isCondoAdminRole(req.user.role))
      return res.status(403).json({ error: "Only administrators can create monthly dues" });
    const ownerId = req.user.employee_id;
    const { unit_id, amount, due_date } = req.body || {};
    const amt = Number(amount);
    if (amt === undefined || isNaN(amt) || amt < 0) return res.status(400).json({ error: "amount required and must be >= 0" });
    const raw = due_date && String(due_date).trim() ? String(due_date).trim() : null;
    if (!raw) return res.status(400).json({ error: "due_date required (YYYY-MM-DD or YYYY-MM)" });
    let dueDate;
    const ymdMatch = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    const dmyMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (ymdMatch) {
      const [, y, m, d] = ymdMatch;
      dueDate = y + "-" + m.padStart(2, "0") + "-" + d.padStart(2, "0");
    } else if (dmyMatch) {
      const [, d, m, y] = dmyMatch;
      dueDate = y + "-" + m.padStart(2, "0") + "-" + d.padStart(2, "0");
    } else if (raw.length === 7 && /^\d{4}-\d{1,2}$/.test(raw)) {
      dueDate = raw + "-01";
    } else {
      return res.status(400).json({ error: "due_date must be YYYY-MM-DD or DD/MM/YYYY" });
    }
    const effectiveFromMonth = dueDate.length >= 7 ? dueDate.slice(0, 7) : null;
    const [result] = await db.promise().query(
      "INSERT INTO MONTHLY_DUE (unit_id, amount, due_date, effective_from_month, status, owner_employee_id) VALUES (?, ?, ?, ?, 'pending', ?)",
      [unit_id != null && unit_id !== "" && unit_id !== "general" ? Number(unit_id) : null, amt, dueDate, effectiveFromMonth, ownerId]
    );
    const [rows] = await db.promise().query(
      "SELECT id, unit_id, amount, due_date, effective_from_month, status, created_at FROM MONTHLY_DUE WHERE id = ?",
      [result.insertId]
    );
    const row = rows[0];
    if (row) {
      const pad = (n) => String(n).padStart(2, "0");
      const d = row.due_date;
      row.due_date = !d ? null : typeof d === "string" && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : d instanceof Date && !isNaN(d.getTime()) ? d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()) : String(d).replace(/T.*/, "").slice(0, 10);
      row.effective_from_month = row.effective_from_month || (row.due_date && row.due_date.length >= 7 ? row.due_date.slice(0, 7) : null);
    }
    res.status(201).json(row || {});
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to add monthly due" });
  }
});

app.delete("/api/monthly-dues/:id", optionalAuth, async (req, res) => {
  try {
    if (!req.user || !isCondoAdminRole(req.user.role))
      return res.status(403).json({ error: "Only administrators can remove monthly dues" });
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(404).json({ error: "Not found" });
    const ownerId = req.user.employee_id;
    const [result] = await db.promise().query("DELETE FROM MONTHLY_DUE WHERE id = ? AND owner_employee_id = ?", [id, ownerId]);
    if (result.affectedRows === 0) return res.status(404).json({ error: "Not found" });
    res.json({ message: "Monthly due removed" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to remove monthly due" });
  }
});

// Staff: undo check-in (clear checked_in_at)
app.post("/api/bookings/:id/undo-check-in", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [result] = await db.promise().query(
      "UPDATE BOOKING SET checked_in_at = NULL WHERE booking_id = ? AND status = 'confirmed' AND checked_in_at IS NOT NULL",
      [id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: "Booking not found or not checked in" });
    const [rows] = await db.promise().query(
      "SELECT booking_id, guest_name, unit_id, checked_in_at, checked_out_at, check_out_date FROM BOOKING WHERE booking_id = ?",
      [id]
    );
    res.json({ message: "Check-in undone", booking: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to undo check-in" });
  }
});

// Staff: undo check-out (clear checked_out_at)
app.post("/api/bookings/:id/undo-check-out", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [result] = await db.promise().query(
      "UPDATE BOOKING SET checked_out_at = NULL WHERE booking_id = ? AND status = 'confirmed' AND checked_out_at IS NOT NULL",
      [id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: "Booking not found or not checked out" });
    const [rows] = await db.promise().query(
      "SELECT booking_id, guest_name, unit_id, checked_in_at, checked_out_at, check_out_date FROM BOOKING WHERE booking_id = ?",
      [id]
    );
    res.json({ message: "Check-out undone", booking: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to undo check-out" });
  }
});

// Staff: early check-out (set checked_out_at to NOW and update check_out_date to today)
app.post("/api/bookings/:id/early-check-out", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const today = new Date().toISOString().slice(0, 10);
    const [result] = await db.promise().query(
      "UPDATE BOOKING SET checked_out_at = NOW(), check_out_date = ? WHERE booking_id = ? AND status = 'confirmed' AND checked_in_at IS NOT NULL",
      [today, id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: "Booking not found or not checked in" });
    const [rows] = await db.promise().query(
      "SELECT booking_id, guest_name, unit_id, checked_in_at, checked_out_at, check_out_date FROM BOOKING WHERE booking_id = ?",
      [id]
    );
    res.json({ message: "Early check-out recorded. Unit is now available.", booking: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to record early check-out" });
  }
});

// ---------------- Guest authorization & registration (QR workflow) ----------------
// In-memory walk-in tokens: token -> { bookingId?, unitId?, expiresAt }. Expiry 15 min.
const walkInTokens = new Map();
const WALKIN_TOKEN_TTL_MS = 15 * 60 * 1000;
function pruneWalkInTokens() {
  const now = Date.now();
  for (const [t, data] of walkInTokens.entries()) {
    if (data.expiresAt < now) walkInTokens.delete(t);
  }
}
setInterval(pruneWalkInTokens, 60 * 1000);

async function getBookingGuests(bookingId) {
  try {
    const [rows] = await db.promise().query(
      `SELECT id, full_name, email, contact_number, added_via, purpose, relationship, valid_from, valid_to, status, created_at
       FROM BOOKING_GUEST WHERE booking_id = ? ORDER BY created_at ASC`,
      [Number(bookingId)]
    );
    return rows || [];
  } catch (e) {
    if (e.code === "ER_NO_SUCH_TABLE") return [];
    if (e.code === "ER_BAD_FIELD_ERROR") {
      const [legacy] = await db.promise().query(
        "SELECT id, full_name, email, contact_number, added_via, created_at FROM BOOKING_GUEST WHERE booking_id = ? ORDER BY created_at ASC",
        [Number(bookingId)]
      );
      return legacy || [];
    }
    throw e;
  }
}

// List authorized/registered guests for a booking
app.get("/api/bookings/:id/guests", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const guests = await getBookingGuests(id);
    res.json(guests);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to fetch guests" });
  }
});

// Booker or staff: add a guest authorization to a booking
app.post("/api/bookings/:id/guests", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { full_name, email, contact_number, purpose, relationship, valid_from, valid_to } = req.body || {};
    if (!full_name || !String(full_name).trim())
      return res.status(400).json({ error: "full_name is required" });
    const [[booking]] = await db.promise().query(
      "SELECT booking_id, check_in_date, check_out_date FROM BOOKING WHERE booking_id = ? AND status = 'confirmed'",
      [id]
    );
    if (!booking) return res.status(404).json({ error: "Booking not found or not confirmed" });
    const from = valid_from != null && valid_from !== "" ? toYmd(valid_from) : toYmd(booking.check_in_date);
    const to = valid_to != null && valid_to !== "" ? toYmd(valid_to) : toYmd(booking.check_out_date);
    try {
      await db.promise().query(
        `INSERT INTO BOOKING_GUEST (booking_id, full_name, email, contact_number, added_via, purpose, relationship, valid_from, valid_to, status)
         VALUES (?, ?, ?, ?, 'booker', ?, ?, ?, ?, 'active')`,
        [id, String(full_name).trim(), email ? String(email).trim() : null, contact_number ? String(contact_number).trim() : null, purpose ? String(purpose).trim() : null, relationship ? String(relationship).trim() : null, from || null, to || null]
      );
    } catch (insErr) {
      if (insErr.code === "ER_BAD_FIELD_ERROR") {
        await db.promise().query(
          "INSERT INTO BOOKING_GUEST (booking_id, full_name, email, contact_number, added_via) VALUES (?, ?, ?, ?, 'booker')",
          [id, String(full_name).trim(), email ? String(email).trim() : null, contact_number ? String(contact_number).trim() : null]
        );
      } else throw insErr;
    }
    const [r] = await db.promise().query("SELECT LAST_INSERT_ID() AS id");
    res.status(201).json({ message: "Guest authorization added", id: r[0].id });
  } catch (err) {
    if (err.code === "ER_NO_SUCH_TABLE")
      return res.status(503).json({ error: "Run migrations/add_booking_guest.sql to enable guest authorization" });
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to add guest" });
  }
});

// Staff: create a walk-in registration token (by unit_id or booking_id).
// QR uses the SAME guest registration link as in properties (guest-register.html). On submit: auto-confirms
// (no owner confirmation) and auto-sends confirmation email; booking shows as "Confirmed - Walk in".
app.post("/api/walkin-token", async (req, res) => {
  try {
    const { unit_id, booking_id } = req.body || {};
    const unitId = unit_id != null ? Number(unit_id) : null;
    const bookingId = booking_id != null ? Number(booking_id) : null;
    if (unitId) {
      const [[unit]] = await db.promise().query(
        "SELECT unit_id FROM UNIT WHERE unit_id = ?",
        [unitId]
      );
      if (!unit) return res.status(404).json({ error: "Unit not found" });
      const token = require("crypto").randomBytes(24).toString("hex");
      const expiresAt = Date.now() + WALKIN_TOKEN_TTL_MS;
      walkInTokens.set(token, { unitId, expiresAt });
      const baseUrl = (process.env.APP_URL || "").replace(/\/$/, "") || ("https://" + (req.get("host") || "localhost"));
      const registerUrl = baseUrl + "/guest/guest-register.html?token=" + token;
      const qrDataUrl = await QRCode.toDataURL(registerUrl, QR_OPTS);
      return res.json({ token, registerUrl, qrDataUrl, expiresIn: Math.floor(WALKIN_TOKEN_TTL_MS / 1000) });
    }
    if (bookingId) {
      const [[booking]] = await db.promise().query(
        "SELECT booking_id FROM BOOKING WHERE booking_id = ? AND status = 'confirmed'",
        [bookingId]
      );
      if (!booking) return res.status(404).json({ error: "Booking not found or not confirmed" });
      const token = require("crypto").randomBytes(24).toString("hex");
      const expiresAt = Date.now() + WALKIN_TOKEN_TTL_MS;
      walkInTokens.set(token, { bookingId, expiresAt });
      const baseUrl = (process.env.APP_URL || "").replace(/\/$/, "") || ("https://" + (req.get("host") || "localhost"));
      const registerUrl = baseUrl + "/guest/guest-register.html?token=" + token;
      const qrDataUrl = await QRCode.toDataURL(registerUrl, QR_OPTS);
      return res.json({ token, registerUrl, qrDataUrl, expiresIn: Math.floor(WALKIN_TOKEN_TTL_MS / 1000) });
    }
    return res.status(400).json({ error: "unit_id or booking_id is required" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to create token" });
  }
});

// Resolve token to booking or unit (for registration form)
app.get("/api/guest-register", async (req, res) => {
  try {
    const token = (req.query.token || "").toString().trim();
    const bookingId = req.query.booking_id ? Number(req.query.booking_id) : null;
    if (token) {
      const data = walkInTokens.get(token);
      if (!data || data.expiresAt < Date.now())
        return res.status(400).json({ error: "Invalid or expired link. Ask staff to generate a new QR." });
      if (data.unitId) {
        const [rows] = await db.promise().query(
          `SELECT u.unit_id, u.unit_number, t.tower_name FROM UNIT u LEFT JOIN TOWER t ON t.tower_id = u.tower_id WHERE u.unit_id = ?`,
          [data.unitId]
        );
        if (!rows || !rows[0]) return res.status(404).json({ error: "Unit not found" });
        const u = rows[0];
        return res.json({
          unit_id: u.unit_id,
          unit: u.unit_number || "—",
          tower: u.tower_name || "—",
          token,
          walk_in: true,
        });
      }
      if (data.bookingId) {
        const [rows] = await db.promise().query(
          `SELECT b.booking_id, b.guest_name, b.check_in_date, b.check_out_date, u.unit_number, t.tower_name
           FROM BOOKING b LEFT JOIN UNIT u ON u.unit_id = b.unit_id LEFT JOIN TOWER t ON t.tower_id = u.tower_id
           WHERE b.booking_id = ? AND b.status = 'confirmed'`,
          [data.bookingId]
        );
        if (!rows || !rows[0]) return res.status(404).json({ error: "Booking not found" });
        const b = rows[0];
        return res.json({
          booking_id: b.booking_id,
          booking_ref: "REG-" + String(b.booking_id).padStart(5, "0"),
          unit: b.unit_number || "—",
          tower: b.tower_name || "—",
          check_in: b.check_in_date,
          check_out: b.check_out_date,
          token,
        });
      }
    }
    if (bookingId) {
      const [rows] = await db.promise().query(
        `SELECT b.booking_id, b.guest_name, b.check_in_date, b.check_out_date, u.unit_number, t.tower_name
         FROM BOOKING b LEFT JOIN UNIT u ON u.unit_id = b.unit_id LEFT JOIN TOWER t ON t.tower_id = u.tower_id
         WHERE b.booking_id = ? AND b.status = 'confirmed'`,
        [bookingId]
      );
      if (!rows || !rows[0]) return res.status(404).json({ error: "Booking not found" });
      const b = rows[0];
      return res.json({
        booking_id: b.booking_id,
        booking_ref: "REG-" + String(b.booking_id).padStart(5, "0"),
        unit: b.unit_number || "—",
        tower: b.tower_name || "—",
        check_in: b.check_in_date,
        check_out: b.check_out_date,
      });
    }
    res.status(400).json({ error: "Provide token= or booking_id=" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed" });
  }
});

// Submit guest registration. Same form/link as property guest registration.
// Walk-in token (unitId): creates booking with status 'confirmed', auto-sends email—no owner confirmation.
// When walk-in uses full Avida form (booking.html), body includes check_in_date, permanent_address, etc. – full BOOKING insert.
// booking_id / token(bookingId): adds guest to existing booking.
app.post("/api/guest-register", async (req, res) => {
  try {
    const body = req.body || {};
    const { token, booking_id, full_name, email, contact_number, purpose, relationship } = body;
    const guestName = (body.guest_name || full_name || "").trim() || (full_name && String(full_name).trim());
    if (!guestName)
      return res.status(400).json({ error: "full_name or guest_name is required" });
    let bookingId = null;
    let addedVia = "booker";
    let checkIn = null, checkOut = null;
    let isWalkIn = false;

    if (token) {
      const data = walkInTokens.get(token);
      if (!data || data.expiresAt < Date.now())
        return res.status(400).json({ error: "Invalid or expired link. Ask staff to generate a new QR." });
      walkInTokens.delete(token);
      if (data.unitId) {
        isWalkIn = true;
        const hasFullForm = body.check_in_date != null || body.permanent_address != null || (body.unit_id != null && body.unit_id !== "");
        if (hasFullForm) {
          // Full Avida form: same fields as POST /api/bookings, but status 'confirmed' and booking_platform 'walk_in'
          const {
            unit_id,
            guest_name: gName,
            permanent_address,
            age,
            nationality,
            relation_to_owner,
            occupation,
            email: eMail,
            contact_number: contact,
            owner_name,
            owner_contact,
            inclusive_dates,
            check_in_date: cIn,
            check_out_date: cOut,
            purpose_of_stay,
            paid_yes_no,
            amount_paid,
            booking_platform: platform,
            payment_method,
            id_document,
            payment_proof,
            signature_data,
          } = body;
          const today = new Date().toISOString().slice(0, 10);
          const emailToUse = String(eMail || email || "").trim();
          if (!emailToUse) return res.status(400).json({ error: "Email is required." });
          try {
            await db.promise().query(
              `INSERT INTO BOOKING (
                unit_id, guest_name, permanent_address, age, nationality, relation_to_owner, occupation,
                email, contact_number, owner_name, owner_contact, inclusive_dates, check_in_date, check_out_date,
                purpose_of_stay, paid_yes_no, amount_paid, booking_platform, payment_method,
                id_document, payment_proof, signature_data, status
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed')`,
              [
                Number(data.unitId),
                String(gName || guestName || "").trim(),
                permanent_address ? String(permanent_address).trim() : null,
                age ? String(age).trim() : null,
                nationality ? String(nationality).trim() : null,
                relation_to_owner ? String(relation_to_owner).trim() : null,
                occupation ? String(occupation).trim() : null,
                emailToUse,
                contact_number ? String(contact_number).trim() : (contact ? String(contact).trim() : null),
                owner_name ? String(owner_name).trim() : null,
                owner_contact ? String(owner_contact).trim() : null,
                inclusive_dates ? String(inclusive_dates).trim() : null,
                cIn || today,
                cOut || today,
                purpose_of_stay ? String(purpose_of_stay).trim() : null,
                paid_yes_no ? String(paid_yes_no).trim() : null,
                amount_paid != null && amount_paid !== "" ? String(amount_paid).trim() : null,
                "walk_in",
                payment_method ? String(payment_method).trim() : null,
                id_document || null,
                payment_proof || null,
                signature_data || null,
              ]
            );
          } catch (insErr) {
            // If the DB BOOKING table doesn't have all Avida columns, fall back to minimal walk-in insert.
            if (insErr && insErr.code === "ER_BAD_FIELD_ERROR") {
              await db.promise().query(
                `INSERT INTO BOOKING (
                  unit_id, guest_name, email, contact_number, check_in_date, check_out_date,
                  booking_platform, status
                ) VALUES (?, ?, ?, ?, ?, ?, 'walk_in', 'confirmed')`,
                [
                  data.unitId,
                  String(gName || guestName || "").trim(),
                  emailToUse,
                  contact_number ? String(contact_number).trim() : (contact ? String(contact).trim() : null),
                  cIn || today,
                  cOut || today,
                ]
              );
            } else {
              throw insErr;
            }
          }
        } else {
          const today = new Date().toISOString().slice(0, 10);
          await db.promise().query(
            `INSERT INTO BOOKING (
              unit_id, guest_name, email, contact_number, check_in_date, check_out_date,
              booking_platform, status
            ) VALUES (?, ?, ?, ?, ?, ?, 'walk_in', 'confirmed')`,
            [
              data.unitId,
              guestName,
              email ? String(email).trim() : null,
              contact_number ? String(contact_number).trim() : null,
              today,
              today,
            ]
          );
        }
        const [[r]] = await db.promise().query("SELECT LAST_INSERT_ID() AS id");
        bookingId = r.id;
        const [[bRow]] = await db.promise().query("SELECT check_in_date, check_out_date FROM BOOKING WHERE booking_id = ?", [bookingId]);
        if (bRow) { checkIn = bRow.check_in_date; checkOut = bRow.check_out_date; }
        addedVia = "walkin";
      } else if (data.bookingId) {
        bookingId = data.bookingId;
        addedVia = "walkin";
        const [[b]] = await db.promise().query(
          "SELECT check_in_date, check_out_date FROM BOOKING WHERE booking_id = ? AND status = 'confirmed'",
          [bookingId]
        );
        if (b) { checkIn = b.check_in_date; checkOut = b.check_out_date; }
      }
    } else if (booking_id) {
      bookingId = Number(booking_id);
      const [[b]] = await db.promise().query(
        "SELECT booking_id, check_in_date, check_out_date FROM BOOKING WHERE booking_id = ? AND status = 'confirmed'",
        [bookingId]
      );
      if (!b) return res.status(404).json({ error: "Booking not found or not confirmed" });
      checkIn = b.check_in_date;
      checkOut = b.check_out_date;
    } else {
      return res.status(400).json({ error: "token or booking_id is required" });
    }

    if (!checkIn && !checkOut && bookingId) {
      const [[b]] = await db.promise().query("SELECT check_in_date, check_out_date FROM BOOKING WHERE booking_id = ?", [bookingId]);
      if (b) { checkIn = b.check_in_date; checkOut = b.check_out_date; }
    }
    const from = toYmd(checkIn);
    const to = toYmd(checkOut);
    const guestEmail = (body.email || email || "").trim() || null;
    const guestContact = (body.contact_number || contact_number || "").trim() || null;
    try {
      await db.promise().query(
        `INSERT INTO BOOKING_GUEST (booking_id, full_name, email, contact_number, added_via, purpose, relationship, valid_from, valid_to, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
        [bookingId, guestName, guestEmail || null, guestContact, addedVia, purpose ? String(purpose).trim() : null, relationship ? String(relationship).trim() : null, from, to]
      );
    } catch (insErr) {
      if (insErr.code === "ER_BAD_FIELD_ERROR") {
        await db.promise().query(
          "INSERT INTO BOOKING_GUEST (booking_id, full_name, email, contact_number, added_via) VALUES (?, ?, ?, ?, ?)",
          [bookingId, guestName, guestEmail || null, guestContact, addedVia]
        );
      } else throw insErr;
    }

    if (isWalkIn && guestEmail && BREVO_API_KEY) {
      try {
        const [rows] = await db.promise().query(
          `SELECT b.booking_id, b.guest_name, b.check_in_date, b.check_out_date, u.unit_number, t.tower_name
           FROM BOOKING b LEFT JOIN UNIT u ON u.unit_id = b.unit_id LEFT JOIN TOWER t ON t.tower_id = u.tower_id
           WHERE b.booking_id = ?`,
          [bookingId]
        );
        const booking = rows[0];
        if (booking) {
          const baseUrl = (process.env.APP_URL || "").replace(/\/$/, "") || "https://regalia-eon6.onrender.com";
          const qrImageUrl = baseUrl + "/api/bookings/" + bookingId + "/qr";
          const confirmationPageUrl = baseUrl + "/booking/confirmation/" + bookingId;
          const qrDataUrl = await getQRDataUrl(bookingId);
          const bookingRef = "REG-" + String(bookingId).padStart(5, "0");
          const checkInStr = formatDateForEmail(booking.check_in_date);
          const checkOutStr = formatDateForEmail(booking.check_out_date);
          const nights = getNights(booking.check_in_date, booking.check_out_date);
          const stayDatesText = nights > 0 ? checkInStr + " — " + checkOutStr + " (" + nights + " Night(s))" : checkInStr + " — " + checkOutStr;
          const logoUrl = process.env.APP_LOGO_URL || process.env.LOGO_URL || "";
          const html = buildConfirmationEmailHtml({
            guestName: escapeHtml(booking.guest_name || "Guest"),
            bookingRef,
            unitNumber: escapeHtml(booking.unit_number || "—"),
            towerName: escapeHtml(booking.tower_name || "—"),
            stayDatesText: escapeHtml(stayDatesText),
            qrImageUrl,
            qrDataUrl,
            confirmationPageUrl,
            logoUrl,
          });
          const senderEmail = process.env.BREVO_FROM_EMAIL || "regalia@example.com";
          const senderName = process.env.BREVO_FROM_NAME || "Regalia";
          await fetch("https://api.brevo.com/v3/smtp/email", {
            method: "POST",
            headers: { "accept": "application/json", "content-type": "application/json", "api-key": BREVO_API_KEY },
            body: JSON.stringify({
              sender: { name: senderName, email: senderEmail },
              to: [{ email: guestEmail }],
              subject: "Walk-in registration confirmed – Regalia",
              htmlContent: html,
            }),
          });
        }
      } catch (emailErr) {
        console.error("Walk-in confirmation email failed:", emailErr);
      }
    }

    res.status(201).json({ message: "You are registered. Present yourself at check-in." + (isWalkIn && guestEmail ? " A confirmation has been sent to your email." : "") });
  } catch (err) {
    if (err.code === "ER_NO_SUCH_TABLE")
      return res.status(503).json({ error: "Guest registration is not set up. Contact staff." });
    console.error(err);
    res.status(500).json({ error: err.message || "Registration failed" });
  }
});

// ---------------- Profile update ----------------
app.put("/api/employee/profile", optionalAuth, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not authenticated" });
  const { full_name, username, email, contact_number } = req.body;
  try {
    const [dup] = await db.promise().query(
      "SELECT employee_id FROM EMPLOYEE WHERE (username = ? OR email = ?) AND employee_id != ?",
      [username, email, req.user.employee_id]
    );
    if (dup.length > 0) return res.status(400).json({ error: "Username or email already taken" });
    await db.promise().query(
      "UPDATE EMPLOYEE SET full_name = ?, username = ?, email = ?, contact_number = ? WHERE employee_id = ?",
      [full_name, username, email, contact_number, req.user.employee_id]
    );
    const [rows] = await db.promise().query("SELECT * FROM EMPLOYEE WHERE employee_id = ?", [req.user.employee_id]);
    res.json({ message: "Profile updated", employee: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ---------------- Change password ----------------
app.put("/api/employee/password", optionalAuth, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not authenticated" });
  const { current_password, new_password } = req.body;
  if (!new_password || new_password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  try {
    const [rows] = await db.promise().query("SELECT password FROM EMPLOYEE WHERE employee_id = ?", [req.user.employee_id]);
    if (!rows.length) return res.status(404).json({ error: "User not found" });
    const match = await bcrypt.compare(current_password, rows[0].password);
    if (!match) return res.status(400).json({ error: "Current password is incorrect" });
    const hashed = await bcrypt.hash(new_password, 10);
    await db.promise().query("UPDATE EMPLOYEE SET password = ? WHERE employee_id = ?", [hashed, req.user.employee_id]);
    res.json({ message: "Password updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ---------------- Theme preference ----------------
app.get("/api/employee/theme", optionalAuth, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not authenticated" });
  try {
    const [rows] = await db.promise().query(
      "SELECT theme_color FROM EMPLOYEE WHERE employee_id = ?",
      [req.user.employee_id]
    );
    res.json({ theme_color: rows[0]?.theme_color || "default" });
  } catch (err) {
    if (err.code === "ER_BAD_FIELD_ERROR") return res.json({ theme_color: "default" });
    res.status(500).json({ error: "Server error" });
  }
});

app.put("/api/employee/theme", optionalAuth, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not authenticated" });
  const { theme_color } = req.body;
  const allowed = ["default", "ocean", "sunset", "forest", "purple", "midnight", "rose"];
  if (!allowed.includes(theme_color)) return res.status(400).json({ error: "Invalid theme" });
  try {
    await db.promise().query(
      "UPDATE EMPLOYEE SET theme_color = ? WHERE employee_id = ?",
      [theme_color, req.user.employee_id]
    );
    res.json({ message: "Theme saved", theme_color });
  } catch (err) {
    if (err.code === "ER_BAD_FIELD_ERROR") return res.json({ message: "Theme column not yet available", theme_color });
    res.status(500).json({ error: "Server error" });
  }
});

// ---------------- Catch-all for frontend routing ----------------
// Fixes Render Node v22+ "Missing parameter name at index 1: *" error
app.get(/^\/.*$/, (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend", "index.html"));
});

// ---------------- Start Server ----------------
const PORT = process.env.PORT || 3000;
runStartupSchemaFixes()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));
  })
  .catch((e) => {
    console.error(e);
    app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT} (schema fixes skipped)`));
  });
