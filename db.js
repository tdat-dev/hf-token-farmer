import { DatabaseSync } from "node:sqlite";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.TOKENS_DB_PATH || process.env.DB_PATH || path.join(__dirname, "tokens.db");
const TOKENS_FILE = path.join(__dirname, "tokens.txt");

// Khởi tạo Database SQLite Node.js native
const db = new DatabaseSync(DB_PATH);

// Bật WAL mode cho hiệu năng cao và an toàn đa tiến trình
db.exec("PRAGMA journal_mode = WAL;");

// Khởi tạo cấu trúc bảng accounts
db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT UNIQUE NOT NULL,
    email TEXT,
    password TEXT,
    username TEXT,
    token_name TEXT,
    status TEXT DEFAULT 'active', -- 'active' | 'exhausted' | 'invalid'
    tier TEXT DEFAULT 'zerogpu',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_checked_at DATETIME,
    last_used_at DATETIME,
    notes TEXT,
    exhausted_until INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_accounts_token ON accounts(token);
  CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);
`);

/**
 * Thêm một account / token mới vào database SQLite và đồng bộ đến các MCP pools
 */
export function insertAccount({ token, email = "", password = "", username = "", token_name = "", notes = "", status = "active" }) {
  if (!token || !token.startsWith("hf_")) {
    throw new Error("Token không hợp lệ, phải bắt đầu bằng 'hf_'");
  }

  const cleanToken = token.trim();

  // 1. Insert vào Database chính
  const stmt = db.prepare(`
    INSERT INTO accounts (token, email, password, username, token_name, notes, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(token) DO UPDATE SET
      email = COALESCE(NULLIF(excluded.email, ''), accounts.email),
      password = COALESCE(NULLIF(excluded.password, ''), accounts.password),
      username = COALESCE(NULLIF(excluded.username, ''), accounts.username),
      token_name = COALESCE(NULLIF(excluded.token_name, ''), accounts.token_name),
      notes = COALESCE(NULLIF(excluded.notes, ''), accounts.notes),
      status = excluded.status
  `);

  const result = stmt.run(cleanToken, email, password, username, token_name, notes, status);
  return result;
}

/**
 * Lấy danh sách accounts có filter & search
 */
export function getAccounts({ status = "all", search = "", limit = 100, offset = 0 } = {}) {
  let query = "SELECT * FROM accounts WHERE 1=1";
  const params = [];

  if (status && status !== "all") {
    query += " AND status = ?";
    params.push(status);
  }

  if (search && search.trim()) {
    query += " AND (token LIKE ? OR username LIKE ? OR email LIKE ?)";
    const term = `%${search.trim()}%`;
    params.push(term, term, term);
  }

  query += " ORDER BY id DESC LIMIT ? OFFSET ?";
  params.push(Number(limit) || 100, Number(offset) || 0);

  return db.prepare(query).all(...params);
}

/**
 * Đếm tổng số accounts theo trạng thái
 */
export function getStats() {
  const total = db.prepare("SELECT COUNT(*) AS count FROM accounts").get().count;
  const active = db.prepare("SELECT COUNT(*) AS count FROM accounts WHERE status = 'active'").get().count;
  const exhausted = db.prepare("SELECT COUNT(*) AS count FROM accounts WHERE status = 'exhausted'").get().count;
  const invalid = db.prepare("SELECT COUNT(*) AS count FROM accounts WHERE status = 'invalid'").get().count;

  return { total, active, exhausted, invalid };
}

/**
 * Cập nhật trạng thái của account
 */
export function updateAccountStatus(idOrToken, status, notes = null, username = null) {
  let stmt;
  if (typeof idOrToken === "number" || !isNaN(idOrToken)) {
    stmt = db.prepare(`
      UPDATE accounts 
      SET status = ?, 
          last_checked_at = datetime('now'),
          notes = COALESCE(?, notes),
          username = CASE WHEN (username IS NULL OR username = '') AND ? IS NOT NULL THEN ? ELSE username END
      WHERE id = ?
    `);
    return stmt.run(status, notes, username, username, Number(idOrToken));
  } else {
    stmt = db.prepare(`
      UPDATE accounts 
      SET status = ?, 
          last_checked_at = datetime('now'),
          notes = COALESCE(?, notes),
          username = CASE WHEN (username IS NULL OR username = '') AND ? IS NOT NULL THEN ? ELSE username END
      WHERE token = ?
    `);
    return stmt.run(status, notes, username, username, idOrToken);
  }
}

/**
 * Xóa account theo ID
 */
export function deleteAccount(id) {
  const stmt = db.prepare("DELETE FROM accounts WHERE id = ?");
  return stmt.run(Number(id));
}

/**
 * Lấy danh sách tất cả các token đang active
 */
export function getAllActiveTokens() {
  const rows = db.prepare("SELECT token FROM accounts WHERE status = 'active' ORDER BY id DESC").all();
  return rows.map(r => r.token);
}

/**
 * Nhập tự động tất cả các token từ file ngoài vào database (tránh trùng lặp)
 */
export function importFromTokensFile(filePath = TOKENS_FILE) {
  if (!fs.existsSync(filePath)) return 0;
  const raw = fs.readFileSync(filePath, "utf8");
  const tokens = raw.split("\n")
    .map(t => t.trim())
    .filter(t => t.startsWith("hf_"));

  let imported = 0;
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO accounts (token, status, notes, created_at)
    VALUES (?, 'active', 'Imported from file', datetime('now'))
  `);

  db.exec("BEGIN");
  try {
    for (const t of tokens) {
      const res = insertStmt.run(t);
      if (res.changes > 0) imported++;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return imported;
}

export default db;
