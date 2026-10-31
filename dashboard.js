import http from "http";
import fs from "fs";
import path from "path";
import https from "https";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import dotenv from "dotenv";
import {
  getStats,
  getAccounts,
  insertAccount,
  updateAccountStatus,
  deleteAccount,
  getAllActiveTokens,
  importFromTokensFile,
} from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const PORT = process.env.PORT || 3333;
const HOST = "127.0.0.1";
const TOKENS_FILE = path.join(__dirname, "tokens.txt");

const AUTH_USER = (process.env.DASHBOARD_USER || "admin").trim();
const AUTH_PASS = (process.env.DASHBOARD_PASS || "tdatdev@123").trim();

// Lưu trữ các active session token trong bộ nhớ
const activeSessions = new Map(); // token -> { user, createdAt, expiresAt }

let activeProcess = null;
let logHistory = [];
const sseClients = new Set();

function broadcastLog(line) {
  console.log(line);
  logHistory.push(line);
  if (logHistory.length > 500) logHistory.shift();
  for (const client of sseClients) {
    client.write(`data: ${JSON.stringify({ log: line })}\n\n`);
  }
}

/**
 * Kiểm tra trạng thái sống của token qua Hugging Face API
 */
function verifyHfToken(token) {
  return new Promise((resolve) => {
    const req = https.request(
      "https://huggingface.co/api/whoami-v2",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": "Vanta-Token-Verifier/1.0",
        },
        timeout: 8000,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          if (res.statusCode === 200) {
            try {
              const data = JSON.parse(raw);
              resolve({
                valid: true,
                username: data.name || data.preferred_username || "",
                email: data.email || "",
                type: data.type || "user",
                orgs: data.orgs?.length || 0,
              });
            } catch {
              resolve({ valid: true });
            }
          } else {
            resolve({ valid: false, code: res.statusCode });
          }
        });
      }
    );

    req.on("error", () => resolve({ valid: false, error: "Network error" }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ valid: false, error: "Timeout" });
    });
    req.end();
  });
}

function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (!rc) return list;
  rc.split(";").forEach((cookie) => {
    const parts = cookie.split("=");
    list[parts.shift().trim()] = decodeURI(parts.join("="));
  });
  return list;
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

function checkUserAuth(req) {
  // 1. Kiểm tra qua Cookie Session (Dành cho trình duyệt trên hf.zoldify.com)
  const cookies = parseCookies(req);
  const sessionToken = cookies["vanta_session"];
  if (sessionToken && activeSessions.has(sessionToken)) {
    const sess = activeSessions.get(sessionToken);
    if (Date.now() < sess.expiresAt) {
      return { authenticated: true, user: sess.user };
    } else {
      activeSessions.delete(sessionToken);
    }
  }

  // 2. Kiểm tra qua Header Authorization (Basic Auth hoặc Bearer cho CLI / API)
  const authHeader = req.headers["authorization"];
  if (authHeader && authHeader.startsWith("Basic ")) {
    try {
      const creds = Buffer.from(authHeader.slice(6), "base64").toString("utf-8");
      const [u, p] = creds.split(":");
      if (u === AUTH_USER && p === AUTH_PASS) {
        return { authenticated: true, user: u };
      }
    } catch {}
  }

  return { authenticated: false };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // API Đăng nhập
  if (url.pathname === "/api/login" && req.method === "POST") {
    const body = await parseBody(req);
    const u = String(body.username || "").trim();
    const p = String(body.password || "").trim();

    if (u === AUTH_USER && p === AUTH_PASS) {
      const sessionToken = crypto.randomBytes(32).toString("hex");
      const maxAgeSeconds = 30 * 24 * 60 * 60; // 30 ngày
      activeSessions.set(sessionToken, {
        user: u,
        createdAt: Date.now(),
        expiresAt: Date.now() + maxAgeSeconds * 1000,
      });

      res.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": `vanta_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`,
      });
      return res.end(JSON.stringify({ success: true, user: u }));
    } else {
      console.log(`[AUTH FAIL] Nhận username='${u}', password='${p ? "***" : "empty"}' (kỳ vọng: '${AUTH_USER}')`);
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Tên đăng nhập hoặc mật khẩu không chính xác!" }));
    }
  }

  // Đăng xuất
  if (url.pathname === "/logout" || url.pathname === "/api/logout") {
    const cookies = parseCookies(req);
    if (cookies["vanta_session"]) activeSessions.delete(cookies["vanta_session"]);
    res.writeHead(302, {
      "Set-Cookie": "vanta_session=; Path=/; HttpOnly; Max-Age=0",
      Location: "/login",
    });
    return res.end();
  }

  // Trang đăng nhập HTML
  if (url.pathname === "/login") {
    const authState = checkUserAuth(req);
    if (authState.authenticated) {
      res.writeHead(302, { Location: "/" });
      return res.end();
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(renderLoginHtml());
  }

  // BẢO VỆ TẤT CẢ CÁC ROUTE CÒN LẠI
  const auth = checkUserAuth(req);
  if (!auth.authenticated) {
    if (url.pathname.startsWith("/api/")) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "401 Unauthorized: Vui lòng đăng nhập trước khi gọi API" }));
    } else {
      res.writeHead(302, { Location: "/login" });
      return res.end();
    }
  }

  // 1. SSE Logs
  if (url.pathname === "/api/logs") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    for (const line of logHistory) {
      res.write(`data: ${JSON.stringify({ log: line })}\n\n`);
    }
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  // 2. Thống kê Database
  if (url.pathname === "/api/stats") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(getStats()));
  }

  // 3. Danh sách accounts trong DB
  if (url.pathname === "/api/accounts" && req.method === "GET") {
    const status = url.searchParams.get("status") || "all";
    const search = url.searchParams.get("search") || "";
    const limit = parseInt(url.searchParams.get("limit") || "100", 10);
    const offset = parseInt(url.searchParams.get("offset") || "0", 10);

    const accounts = getAccounts({ status, search, limit, offset });
    const stats = getStats();

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ stats, accounts }));
  }

  // 4. Lấy mảng tokens active (Tương thích ngược hệ thống cũ)
  if (url.pathname === "/api/tokens") {
    const activeTokens = getAllActiveTokens();
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ tokens: activeTokens }));
  }

  // 5. Thêm account thủ công
  if (url.pathname === "/api/accounts/add" && req.method === "POST") {
    const body = await parseBody(req);
    try {
      insertAccount({
        token: body.token,
        email: body.email,
        password: body.password,
        username: body.username,
        token_name: body.token_name || "manual_added",
        notes: body.notes || "Thêm thủ công từ Dashboard",
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ success: true, stats: getStats() }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // 6. Xóa account
  if (url.pathname === "/api/accounts/delete" && req.method === "POST") {
    const body = await parseBody(req);
    if (!body.id) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Missing account id" }));
    }
    deleteAccount(body.id);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ success: true, stats: getStats() }));
  }

  // 7. Đổi trạng thái account
  if (url.pathname === "/api/accounts/status" && req.method === "POST") {
    const body = await parseBody(req);
    if (!body.id || !body.status) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Missing id or status" }));
    }
    updateAccountStatus(body.id, body.status, body.notes);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ success: true, stats: getStats() }));
  }

  // 8. Kiểm tra live một token qua HF API
  if (url.pathname === "/api/accounts/check" && req.method === "POST") {
    const body = await parseBody(req);
    if (!body.token) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Missing token" }));
    }
    const checkRes = await verifyHfToken(body.token);
    const newStatus = checkRes.valid ? "active" : "invalid";
    updateAccountStatus(
      body.token,
      newStatus,
      checkRes.valid ? `Verified user: ${checkRes.username}` : `Invalid (${checkRes.code || checkRes.error})`,
      checkRes.username || null
    );
    
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ...checkRes, status: newStatus }));
  }

  // 9. Kiểm tra live TẤT CẢ các token trong DB (Batch Check)
  if (url.pathname === "/api/accounts/check-all" && req.method === "POST") {
    const all = getAccounts({ limit: 500 });
    broadcastLog(`\n🔍 [CHECKER] Bắt đầu kiểm tra live ${all.length} token trên Hugging Face API...`);
    
    (async () => {
      let okCount = 0;
      let deadCount = 0;
      for (let i = 0; i < all.length; i++) {
        const acc = all[i];
        const resCheck = await verifyHfToken(acc.token);
        if (resCheck.valid) {
          okCount++;
          updateAccountStatus(acc.id, "active", `Verified: ${resCheck.username || "OK"}`, resCheck.username || null);
          broadcastLog(`  [${i + 1}/${all.length}] ✅ Token #${acc.id} (${acc.token.slice(0, 10)}...): HỢP LỆ (User: ${resCheck.username || "N/A"})`);
        } else {
          deadCount++;
          updateAccountStatus(acc.id, "invalid", `Check failed (${resCheck.code || resCheck.error})`);
          broadcastLog(`  [${i + 1}/${all.length}] ❌ Token #${acc.id} (${acc.token.slice(0, 10)}...): HỎNG (${resCheck.code || resCheck.error})`);
        }
        await new Promise((r) => setTimeout(r, 400));
      }
      broadcastLog(`🏁 [CHECKER] Hoàn tất kiểm tra: ${okCount} hợp lệ, ${deadCount} hỏng.\n`);
    })();

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ message: "Batch verification started" }));
  }

  // 10. Import từ tokens.txt
  if (url.pathname === "/api/accounts/import-txt" && req.method === "POST") {
    const count = importFromTokensFile();
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ imported: count, stats: getStats() }));
  }

  // 11. Export dữ liệu (CSV, JSON, TXT)
  if (url.pathname === "/api/export") {
    const format = url.searchParams.get("format") || "txt";
    const accounts = getAccounts({ limit: 10000 });

    if (format === "json") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Disposition": 'attachment; filename="hf_tokens_database.json"',
      });
      return res.end(JSON.stringify(accounts, null, 2));
    } else if (format === "csv") {
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="hf_tokens_database.csv"',
      });
      const header = "id,token,username,email,password,status,tier,created_at,last_checked_at,notes\n";
      const rows = accounts
        .map((a) =>
          [
            a.id,
            `"${a.token}"`,
            `"${a.username || ""}"`,
            `"${a.email || ""}"`,
            `"${a.password || ""}"`,
            `"${a.status}"`,
            `"${a.tier}"`,
            `"${a.created_at}"`,
            `"${a.last_checked_at || ""}"`,
            `"${(a.notes || "").replace(/"/g, '""')}"`,
          ].join(",")
        )
        .join("\n");
      return res.end(header + rows);
    } else {
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": 'attachment; filename="tokens.txt"',
      });
      const txt = accounts
        .filter((a) => a.status === "active")
        .map((a) => a.token)
        .join("\n");
      return res.end(txt);
    }
  }

  // 12. Dừng Farmer process
  if (url.pathname === "/api/stop" && req.method === "POST") {
    if (activeProcess) {
      broadcastLog("\n🛑 [GUI] ĐÃ GỬI LỆNH DỪNG TIẾN TRÌNH...");
      try {
        activeProcess.kill("SIGKILL");
      } catch (e) {}
      activeProcess = null;
      broadcastLog("✅ [GUI] Tiến trình đã bị hủy hoàn toàn.");
    } else {
      broadcastLog("ℹ️ [GUI] Không có tiến trình nào đang chạy.");
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "stopped" }));
  }

  // 13. Khởi chạy Farmer process
  if (url.pathname === "/api/start-create" && req.method === "POST") {
    const body = await parseBody(req);
    const targetCount = Number(body.count) || 5;

    if (activeProcess) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Một tiến trình đang chạy! Vui lòng bấm DỪNG trước." }));
    }

    broadcastLog(`\n==============================================`);
    broadcastLog(`🚀 [GUI] Khởi động tạo ${targetCount} tài khoản với Google Chrome thật...`);
    broadcastLog(`   Mọi token tạo thành công sẽ tự động ghi vào SQLite Database (tokens.db)`);
    broadcastLog(`==============================================`);

    const isLinuxNoDisplay = process.platform === "linux" && !process.env.DISPLAY;
    const cmd = isLinuxNoDisplay ? "xvfb-run" : "node";
    const args = isLinuxNoDisplay
      ? ["-a", "node", "auto_reg_hf.js", `--count=${targetCount}`]
      : ["auto_reg_hf.js", `--count=${targetCount}`];

    activeProcess = spawn(cmd, args, { cwd: __dirname });

    activeProcess.stdout.on("data", (data) => {
      const lines = data.toString().split("\n");
      lines.forEach((l) => l && broadcastLog(l));
    });

    activeProcess.stderr.on("data", (data) => {
      const lines = data.toString().split("\n");
      lines.forEach((l) => l && broadcastLog(`[STDERR] ${l}`));
    });

    activeProcess.on("close", (code) => {
      broadcastLog(`\n🏁 [GUI] Tiến trình tạo tài khoản hoàn tất (Exit Code: ${code})`);
      activeProcess = null;
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "started" }));
  }

  // 14. WEB GUI DASHBOARD (Sau khi đã đăng nhập thành công)
  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderDashboardHtml(auth.user));
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, HOST, () => {
  console.log(`[Dashboard] Database Manager listening on http://${HOST}:${PORT}`);
});

/**
 * TRANG ĐĂNG NHẬP CHUYÊN NGHIỆP CHO hf.zoldify.com
 */
function renderLoginHtml() {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>VANTA Studio — Login</title>
  <style>
    :root {
      --bg: #07080c;
      --card-bg: #10131d;
      --border: #1e2638;
      --accent: #10b981;
      --text: #f1f5f9;
      --muted: #64748b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: var(--bg); color: var(--text); display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
    .login-box { width: 100%; max-width: 380px; background: var(--card-bg); border: 1px solid var(--border); border-radius: 16px; padding: 32px 28px; box-shadow: 0 20px 40px rgba(0,0,0,0.6); }
    .brand { text-align: center; margin-bottom: 24px; }
    .brand h1 { font-size: 22px; font-weight: 800; background: linear-gradient(90deg, #10b981, #06b6d4); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .brand p { font-size: 13px; color: var(--muted); margin-top: 6px; }
    .field { margin-bottom: 18px; }
    label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 6px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
    input { width: 100%; background: #07090f; border: 1px solid #232c40; color: #fff; padding: 12px 14px; border-radius: 8px; font-size: 14px; outline: none; transition: 0.2s; }
    input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.15); }
    .btn-submit { width: 100%; padding: 12px; background: linear-gradient(135deg, #10b981, #059669); color: #fff; border: none; border-radius: 8px; font-size: 14px; font-weight: 700; cursor: pointer; transition: 0.2s; margin-top: 8px; }
    .btn-submit:hover { opacity: 0.9; transform: translateY(-1px); }
    .error-msg { background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3); color: #f87171; padding: 10px 12px; border-radius: 8px; font-size: 13px; margin-bottom: 16px; display: none; }
    .footer-note { font-size: 11px; text-align: center; color: var(--muted); margin-top: 24px; }
  </style>
</head>
<body>
  <div class="login-box">
    <div class="brand">
      <h1>⚡ VANTA STUDIO</h1>
      <p>Bảo mật ZeroGPU Token Pool</p>
    </div>

    <div id="errMsg" class="error-msg"></div>

    <form id="loginForm" onsubmit="handleLogin(event)">
      <div class="field">
        <label>Tài khoản</label>
        <input type="text" id="username" value="admin" required autofocus autocomplete="username">
      </div>
      <div class="field">
        <label>Mật khẩu</label>
        <input type="password" id="password" required autocomplete="current-password" placeholder="Nhập mật khẩu...">
      </div>
      <button type="submit" id="btnSubmit" class="btn-submit">🔒 Đăng Nhập</button>
    </form>

    <div class="footer-note">
      Được mã hóa & bảo vệ 24/7 qua Cloudflare Tunnel
    </div>
  </div>

  <script>
    async function handleLogin(e) {
      e.preventDefault();
      const u = document.getElementById('username').value.trim();
      const p = document.getElementById('password').value;
      const btn = document.getElementById('btnSubmit');
      const err = document.getElementById('errMsg');

      btn.disabled = true;
      btn.innerText = 'Đang xác thực...';
      err.style.display = 'none';

      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: u, password: p })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          window.location.href = '/';
        } else {
          err.innerText = data.error || 'Đăng nhập thất bại!';
          err.style.display = 'block';
        }
      } catch (e) {
        err.innerText = 'Lỗi kết nối: ' + e.message;
        err.style.display = 'block';
      } finally {
        btn.disabled = false;
        btn.innerText = '🔒 Đăng Nhập';
      }
    }
  </script>
</body>
</html>`;
}

function renderDashboardHtml(currentUser = "vanta") {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>VANTA ZeroGPU Token Database Manager</title>
  <style>
    :root {
      --bg: #090a0f;
      --card-bg: #11141e;
      --card-border: #1e2638;
      --accent: #10b981;
      --accent-glow: rgba(16, 185, 129, 0.2);
      --text: #f1f5f9;
      --muted: #64748b;
      --primary: #38bdf8;
      --danger: #ef4444;
      --warning: #f59e0b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "SF Pro Display", sans-serif; }
    body { background: var(--bg); color: var(--text); padding: 24px; min-height: 100vh; }
    .container { max-width: 1200px; margin: 0 auto; }
    
    /* Header */
    header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid var(--card-border); }
    h1 { font-size: 24px; font-weight: 800; background: linear-gradient(90deg, #10b981, #06b6d4, #818cf8); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .header-pills { display: flex; gap: 8px; align-items: center; }
    .pill { font-size: 11px; padding: 4px 10px; border-radius: 9999px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
    .pill-green { background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); }
    .pill-blue { background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); }
    .btn-logout { background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3); color: #f87171; padding: 5px 12px; border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer; text-decoration: none; transition: 0.2s; display: inline-flex; align-items: center; gap: 4px; }
    .btn-logout:hover { background: rgba(239, 68, 68, 0.3); color: #fff; }

    /* Metric Cards */
    .metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 24px; }
    .metric-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 12px; padding: 18px; position: relative; overflow: hidden; }
    .metric-title { font-size: 12px; color: var(--muted); text-transform: uppercase; font-weight: 600; letter-spacing: 0.5px; }
    .metric-value { font-size: 28px; font-weight: 800; margin-top: 6px; }
    .metric-card.total .metric-value { color: #f8fafc; }
    .metric-card.active .metric-value { color: #34d399; text-shadow: 0 0 16px rgba(52, 211, 153, 0.4); }
    .metric-card.exhausted .metric-value { color: #fbbf24; }
    .metric-card.invalid .metric-value { color: #f87171; }

    /* Layout Grid */
    .grid-top { display: grid; grid-template-columns: 360px 1fr; gap: 20px; margin-bottom: 24px; }
    .card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 12px; padding: 20px; }
    .card-title { font-size: 15px; font-weight: 700; color: #f8fafc; display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }

    /* Controls */
    label { font-size: 12px; color: var(--muted); display: block; margin-bottom: 6px; font-weight: 600; }
    input, select { width: 100%; background: #07090e; border: 1px solid #242d42; color: #fff; padding: 10px 14px; border-radius: 8px; font-size: 14px; outline: none; transition: 0.2s; }
    input:focus, select:focus { border-color: var(--primary); }
    .btn-group { display: flex; gap: 10px; margin-top: 14px; }
    button { padding: 10px 16px; border: none; border-radius: 8px; cursor: pointer; transition: all 0.2s; font-size: 13px; font-weight: 600; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
    button:hover { opacity: 0.9; transform: translateY(-1px); }
    .btn-primary { background: linear-gradient(135deg, #10b981, #059669); color: #fff; }
    .btn-stop { background: #ef4444; color: #fff; }
    .btn-secondary { background: #1e2638; color: #94a3b8; }
    .btn-secondary:hover { background: #2a344d; color: #fff; }
    .btn-outline { background: transparent; border: 1px solid #242d42; color: #cbd5e1; }
    .btn-outline:hover { border-color: var(--primary); color: #fff; }

    /* Terminal */
    .terminal { background: #05070a; border: 1px solid #1a2233; border-radius: 8px; padding: 14px; height: 180px; overflow-y: auto; font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 12px; line-height: 1.5; color: #38bdf8; }

    /* Database Table Toolbar */
    .table-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
    .search-box { position: relative; width: 280px; }
    .search-box input { padding-left: 34px; }
    .search-icon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--muted); font-size: 14px; }
    .toolbar-actions { display: flex; gap: 8px; align-items: center; }

    /* Database Table */
    .table-container { overflow-x: auto; border: 1px solid var(--card-border); border-radius: 8px; background: #0a0c13; }
    table { width: 100%; border-collapse: collapse; text-align: left; font-size: 13px; }
    th { background: #11141e; padding: 12px 14px; color: var(--muted); font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; border-bottom: 1px solid var(--card-border); }
    td { padding: 12px 14px; border-bottom: 1px solid #161b29; color: #cbd5e1; vertical-align: middle; }
    tr:hover td { background: #10131d; }
    
    .token-text { font-family: "SF Mono", monospace; color: #a7f3d0; background: rgba(16, 185, 129, 0.1); padding: 4px 8px; border-radius: 6px; font-size: 12px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; border: 1px solid rgba(16, 185, 129, 0.2); }
    .token-text:hover { background: rgba(16, 185, 129, 0.25); color: #fff; }
    
    .status-tag { display: inline-block; padding: 3px 8px; border-radius: 6px; font-size: 11px; font-weight: 700; text-transform: uppercase; }
    .status-active { background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); }
    .status-exhausted { background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3); }
    .status-invalid { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }

    .action-btn { background: #161c29; border: 1px solid #222b3e; color: #94a3b8; padding: 5px 10px; border-radius: 6px; font-size: 12px; cursor: pointer; transition: 0.2s; }
    .action-btn:hover { background: #222b3e; color: #fff; }
    .action-btn.del:hover { background: rgba(239, 68, 68, 0.2); color: #f87171; border-color: rgba(239, 68, 68, 0.4); }

    .toast { position: fixed; bottom: 24px; right: 24px; background: #0f172a; color: #38bdf8; border: 1px solid #0284c7; padding: 12px 20px; border-radius: 8px; font-size: 13px; font-weight: 600; box-shadow: 0 10px 25px rgba(0,0,0,0.5); opacity: 0; pointer-events: none; transition: opacity 0.3s; z-index: 9999; }
    .toast.show { opacity: 1; pointer-events: auto; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1>⚡ VANTA ZEROGPU DATABASE</h1>
        <p style="font-size: 13px; color: var(--muted); margin-top: 4px;">Hệ thống lưu trữ SQLite an toàn & Tự động tạo Token ZeroGPU</p>
      </div>
      <div class="header-pills">
        <span class="pill pill-green">DB: tokens.db (WAL)</span>
        <span class="pill pill-blue">User: ${currentUser}</span>
        <a href="/logout" class="btn-logout" title="Đăng xuất khỏi phiên">🚪 Đăng xuất</a>
      </div>
    </header>

    <!-- 4 THẺ THỐNG KÊ REALTIME -->
    <div class="metrics">
      <div class="metric-card total">
        <div class="metric-title">Tổng Số Tài Khoản</div>
        <div class="metric-value" id="statTotal">0</div>
      </div>
      <div class="metric-card active">
        <div class="metric-title">Token Active (ZeroGPU)</div>
        <div class="metric-value" id="statActive">0</div>
      </div>
      <div class="metric-card exhausted">
        <div class="metric-title">Hết Quota / Chờ Reset</div>
        <div class="metric-value" id="statExhausted">0</div>
      </div>
      <div class="metric-card invalid">
        <div class="metric-title">Token Lỗi / Bị khóa</div>
        <div class="metric-value" id="statInvalid">0</div>
      </div>
    </div>

    <!-- KHỐI ĐIỀU KHIỂN & TERMINAL -->
    <div class="grid-top">
      <div class="card">
        <div class="card-title">🤖 Trình Farm Tự Động (2Captcha + Chrome)</div>
        <label>Số lượng tài khoản cần tạo:</label>
        <input type="number" id="accCount" value="5" min="1" max="50">
        <div class="btn-group">
          <button class="btn-primary" id="btnStart" onclick="startBatch()">🚀 Bắt Đầu Farm</button>
          <button class="btn-stop" id="btnStop" onclick="stopBatch()">🛑 Dừng</button>
        </div>
      </div>

      <div class="card">
        <div class="card-title">📟 Live Log Terminal</div>
        <div class="terminal" id="termOutput">Hệ thống sẵn sàng...</div>
      </div>
    </div>

    <!-- KHỐI QUẢN LÝ DATABASE TOKENS -->
    <div class="card">
      <div class="card-title">
        <span>🗄️ Bảng Quản Lý Database (SQLite - tokens.db)</span>
        <div style="font-size: 12px; color: var(--muted); font-weight: normal;">
          Nhấn vào token để copy nhanh
        </div>
      </div>

      <!-- THANH CÔNG CỤ TÌM KIẾM & BỘ LỌC -->
      <div class="table-toolbar">
        <div style="display: flex; gap: 10px; align-items: center;">
          <div class="search-box">
            <span class="search-icon">🔍</span>
            <input type="text" id="searchInput" placeholder="Tìm theo Token, User, Email..." oninput="filterAccounts()">
          </div>
          <select id="statusFilter" onchange="filterAccounts()" style="width: 140px;">
            <option value="all">Tất cả trạng thái</option>
            <option value="active" selected>🟢 Active</option>
            <option value="exhausted">🟡 Exhausted</option>
            <option value="invalid">🔴 Invalid</option>
          </select>
        </div>

        <div class="toolbar-actions">
          <button class="btn-outline" onclick="checkAllTokens()">⚡ Kiểm Tra Live Tất Cả</button>
          <button class="btn-outline" onclick="copyAllActiveTokens()">📋 Copy All Active</button>
          <button class="btn-outline" onclick="window.location.href='/api/export?format=csv'">📥 Xuất CSV</button>
          <button class="btn-outline" onclick="window.location.href='/api/export?format=json'">📥 Xuất JSON</button>
          <button class="btn-secondary" onclick="promptAddToken()">➕ Thêm Thủ Công</button>
        </div>
      </div>

      <!-- BẢNG DỮ LIỆU -->
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>HuggingFace Access Token</th>
              <th>Tài Khoản / Email</th>
              <th>Trạng Thái</th>
              <th>Ngày Tạo</th>
              <th>Ghi Chú</th>
              <th style="text-align: right;">Hành Động</th>
            </tr>
          </thead>
          <tbody id="accountsTableBody">
            <tr><td colspan="7" style="text-align: center; color: var(--muted); padding: 24px;">Đang tải dữ liệu từ database...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <div id="toast" class="toast">Đã copy token vào clipboard!</div>

  <script>
    let currentAccounts = [];

    function showToast(text) {
      const t = document.getElementById('toast');
      t.innerText = text;
      t.classList.add('show');
      setTimeout(() => t.classList.remove('show'), 2500);
    }

    function copyToClipboard(text, label = "Token") {
      navigator.clipboard.writeText(text).then(() => {
        showToast('✅ Đã copy ' + label + ' vào clipboard!');
      });
    }

    async function loadStats() {
      try {
        const res = await fetch('/api/stats');
        if (res.status === 401) { window.location.href = '/login'; return; }
        const s = await res.json();
        document.getElementById('statTotal').innerText = s.total;
        document.getElementById('statActive').innerText = s.active;
        document.getElementById('statExhausted').innerText = s.exhausted;
        document.getElementById('statInvalid').innerText = s.invalid;
      } catch (e) {}
    }

    async function loadAccounts() {
      const status = document.getElementById('statusFilter').value;
      const search = document.getElementById('searchInput').value;
      try {
        const res = await fetch('/api/accounts?status=' + encodeURIComponent(status) + '&search=' + encodeURIComponent(search));
        if (res.status === 401) { window.location.href = '/login'; return; }
        const data = await res.json();
        currentAccounts = data.accounts || [];
        renderTable(currentAccounts);
        loadStats();
      } catch (e) {
        console.error(e);
      }
    }

    function filterAccounts() {
      loadAccounts();
    }

    function renderTable(list) {
      const tbody = document.getElementById('accountsTableBody');
      if (list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--muted); padding: 32px;">Không có tài khoản nào phù hợp bộ lọc</td></tr>';
        return;
      }

      tbody.innerHTML = list.map(a => {
        const masked = a.token.slice(0, 7) + '...' + a.token.slice(-5);
        const userDisplay = a.username ? '<strong>' + a.username + '</strong>' : '<span style="color:#64748b;">(Tự động)</span>';
        const emailDisplay = a.email ? '<div style="font-size:11px;color:#94a3b8;">' + a.email + '</div>' : '';
        const statusClass = 'status-' + a.status;
        const statusLabel = a.status === 'active' ? '🟢 Active' : (a.status === 'exhausted' ? '🟡 Hết Quota' : '🔴 Lỗi');

        return '<tr>' +
          '<td><span style="color:var(--muted); font-size:11px;">#' + a.id + '</span></td>' +
          '<td>' +
            '<span class="token-text" onclick="copyToClipboard(\\'' + a.token + '\\', \\'Token\\')" title="Bấm để copy full token">' +
              masked + ' <span style="font-size:10px;opacity:0.7;">📋</span>' +
            '</span>' +
          '</td>' +
          '<td>' + userDisplay + emailDisplay + '</td>' +
          '<td>' +
            '<span class="status-tag ' + statusClass + '">' + statusLabel + '</span>' +
          '</td>' +
          '<td style="font-size:12px;color:var(--muted);">' + (a.created_at || '').replace('T', ' ').slice(0, 16) + '</td>' +
          '<td style="font-size:12px;color:#94a3b8; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">' + (a.notes || 'Auto-farmed') + '</td>' +
          '<td style="text-align: right; white-space: nowrap;">' +
            '<button class="action-btn" onclick="checkSingleToken(\\'' + a.token + '\\')" title="Kiểm tra trạng thái token qua HF">🔍 Test</button> ' +
            '<button class="action-btn" onclick="toggleStatus(' + a.id + ', \\'' + a.status + '\\')" title="Chuyển trạng thái">🔄</button> ' +
            '<button class="action-btn del" onclick="deleteAccount(' + a.id + ')" title="Xóa tài khoản khỏi DB">🗑️</button>' +
          '</td>' +
        '</tr>';
      }).join('');
    }

    async function toggleStatus(id, current) {
      const next = current === 'active' ? 'exhausted' : (current === 'exhausted' ? 'invalid' : 'active');
      await fetch('/api/accounts/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status: next })
      });
      loadAccounts();
    }

    async function deleteAccount(id) {
      if (!confirm('Bạn có chắc chắn muốn xóa tài khoản #' + id + ' khỏi database?')) return;
      await fetch('/api/accounts/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      loadAccounts();
    }

    async function checkSingleToken(token) {
      showToast('⏳ Đang kiểm tra token qua Hugging Face API...');
      const res = await fetch('/api/accounts/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      const data = await res.json();
      if (data.valid) {
        showToast('✅ Token HỢP LỆ! User: ' + (data.username || 'Active'));
      } else {
        showToast('❌ Token KHÔNG hợp lệ (' + (data.code || data.error) + ')');
      }
      loadAccounts();
    }

    async function checkAllTokens() {
      if (!confirm('Bạn có muốn bắt đầu kiểm tra live toàn bộ token trong Database không?')) return;
      await fetch('/api/accounts/check-all', { method: 'POST' });
      showToast('🚀 Đang kiểm tra live toàn bộ token... Xem tiến trình ở Live Terminal');
    }

    async function copyAllActiveTokens() {
      const active = currentAccounts.filter(a => a.status === 'active').map(a => a.token);
      if (active.length === 0) {
        alert('Không có token active nào trong danh sách!');
        return;
      }
      copyToClipboard(active.join('\\n'), active.length + ' Active Tokens');
    }

    async function promptAddToken() {
      const token = prompt('Nhập Hugging Face Access Token (hf_...):');
      if (!token) return;
      const email = prompt('Nhập Email (tùy chọn):') || '';
      const username = prompt('Nhập Username (tùy chọn):') || '';
      
      const res = await fetch('/api/accounts/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, email, username })
      });
      const data = await res.json();
      if (data.error) alert(data.error);
      else {
        showToast('✅ Đã thêm tài khoản mới vào database!');
        loadAccounts();
      }
    }

    async function startBatch() {
      const count = document.getElementById('accCount').value;
      const btn = document.getElementById('btnStart');
      btn.disabled = true;

      try {
        const res = await fetch('/api/start-create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ count: parseInt(count, 10) })
        });
        const data = await res.json();
        if (data.error) alert(data.error);
      } catch (e) {
        alert('Lỗi: ' + e.message);
      } finally {
        btn.disabled = false;
      }
    }

    async function stopBatch() {
      await fetch('/api/stop', { method: 'POST' });
    }

    // SSE Realtime log streaming
    const evtSource = new EventSource('/api/logs');
    const term = document.getElementById('termOutput');
    term.innerHTML = '';

    evtSource.onmessage = function(e) {
      const msg = JSON.parse(e.data);
      term.innerHTML += msg.log + '<br>';
      term.scrollTop = term.scrollHeight;
      if (msg.log.includes('DATABASE') || msg.log.includes('THÀNH CÔNG') || msg.log.includes('[CHECKER]')) {
        loadAccounts();
      }
    };

    // Load ban đầu
    loadAccounts();
  </script>
</body>
</html>`;
}
