import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3333;
const TOKENS_FILE = path.join(__dirname, "tokens.txt");

let activeProcess = null;
let logHistory = [];
const sseClients = new Set();

function broadcastLog(line) {
  logHistory.push(line);
  if (logHistory.length > 500) logHistory.shift();
  for (const client of sseClients) {
    client.write(`data: ${JSON.stringify({ log: line })}\n\n`);
  }
}

function getTokens() {
  if (!fs.existsSync(TOKENS_FILE)) return [];
  return fs
    .readFileSync(TOKENS_FILE, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("hf_"));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/logs") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    // Gửi lại lịch sử log cho client mới kết nối
    for (const line of logHistory) {
      res.write(`data: ${JSON.stringify({ log: line })}\n\n`);
    }
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (url.pathname === "/api/tokens") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tokens: getTokens() }));
    return;
  }

  // API to STOP running process
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

  // API to START batch creator
  if (url.pathname === "/api/start-create" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const { count } = JSON.parse(body || "{}");
      const targetCount = count || 5;

      if (activeProcess) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Một tiến trình đang chạy! Vui lòng bấm DỪNG trước." }));
      }

      broadcastLog(`\n==============================================`);
      broadcastLog(`🚀 [GUI] Khởi động tạo ${targetCount} tài khoản với Google Chrome thật...`);
      broadcastLog(`==============================================`);

      activeProcess = spawn("node", ["auto_reg_hf.js", `--count=${targetCount}`], {
        cwd: __dirname,
      });

      activeProcess.stdout.on("data", (data) => {
        const lines = data.toString().split("\n");
        lines.forEach((l) => l && broadcastLog(l));
      });

      activeProcess.stderr.on("data", (data) => {
        const lines = data.toString().split("\n");
        lines.forEach((l) => l && broadcastLog(`[STDERR] ${l}`));
      });

      activeProcess.on("close", (code) => {
        broadcastLog(`\n🏁 [GUI] Tiến trình hoàn tất (Code: ${code})`);
        activeProcess = null;
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "started" }));
    });
    return;
  }

  // UI
  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <title>Vanta Studio Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: #0c0d12; color: #e2e8f0; padding: 24px; }
    .container { max-width: 1000px; margin: 0 auto; }
    header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid #1e293b; }
    h1 { font-size: 24px; font-weight: 700; background: linear-gradient(90deg, #10b981, #06b6d4); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .card { background: #131722; border: 1px solid #1e293b; border-radius: 12px; padding: 20px; margin-bottom: 20px; }
    .card-title { font-size: 16px; font-weight: 600; margin-bottom: 12px; color: #f8fafc; display: flex; align-items: center; gap: 8px; }
    .badge { background: #064e3b; color: #34d399; font-size: 12px; padding: 3px 8px; border-radius: 20px; font-weight: 600; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    label { font-size: 13px; color: #94a3b8; display: block; margin-bottom: 6px; }
    input { width: 100%; background: #0b0f19; border: 1px solid #334155; color: #fff; padding: 10px 14px; border-radius: 8px; font-size: 14px; outline: none; }
    .btn-group { display: flex; gap: 10px; margin-top: 14px; }
    button { flex: 1; padding: 12px 20px; border: none; border-radius: 8px; cursor: pointer; transition: all 0.2s; font-size: 14px; font-weight: 600; }
    .btn-start { background: linear-gradient(135deg, #10b981, #059669); color: #fff; }
    .btn-stop { background: #ef4444; color: #fff; }
    button:hover { opacity: 0.9; transform: translateY(-1px); }
    .terminal { background: #05070a; border: 1px solid #1e293b; border-radius: 8px; padding: 14px; height: 320px; overflow-y: auto; font-family: "SF Mono", Menlo, monospace; font-size: 12px; line-height: 1.6; color: #38bdf8; }
    .token-pill { display: inline-block; background: #1e293b; color: #a7f3d0; padding: 4px 10px; border-radius: 6px; font-family: monospace; font-size: 12px; margin: 4px; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1>⚡ VANTA STUDIO DASHBOARD</h1>
        <p style="font-size: 13px; color: #64748b; margin-top: 4px;">Đã kết nối Google Chrome Thật & Guerrilla Mail</p>
      </div>
      <div class="badge" id="status-badge">ONLINE</div>
    </header>

    <div class="grid">
      <div class="card">
        <div class="card-title">🤖 Tạo Tài Khoản Hàng Loạt (Chrome Thật)</div>
        <div>
          <label>Số lượng tài khoản muốn tạo:</label>
          <input type="number" id="accCount" value="5" min="1" max="50">
        </div>
        <div class="btn-group">
          <button class="btn-start" id="btnStart" onclick="startBatch()">🚀 BẮT ĐẦU</button>
          <button class="btn-stop" id="btnStop" onclick="stopBatch()">🛑 DỪNG LẠI</button>
        </div>
      </div>

      <div class="card">
        <div class="card-title">🔑 Token Pool Hiện Tại (<span id="tokenCount">0</span> token)</div>
        <div id="tokensList" style="max-height: 140px; overflow-y: auto; margin-bottom: 10px;">
          Đang tải token...
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">📟 Live Terminal</div>
      <div class="terminal" id="termOutput">Sẵn sàng...</div>
    </div>
  </div>

  <script>
    async function loadTokens() {
      const res = await fetch('/api/tokens');
      const data = await res.json();
      document.getElementById('tokenCount').innerText = data.tokens.length;
      const list = document.getElementById('tokensList');
      if (data.tokens.length === 0) {
        list.innerHTML = '<span style="color:#64748b;font-size:12px;">Chưa có token nào</span>';
      } else {
        list.innerHTML = data.tokens.map(t => '<span class="token-pill">' + t.slice(0, 10) + '...' + t.slice(-4) + '</span>').join('');
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

    const evtSource = new EventSource('/api/logs');
    const term = document.getElementById('termOutput');
    term.innerHTML = '';

    evtSource.onmessage = function(e) {
      const msg = JSON.parse(e.data);
      term.innerHTML += msg.log + '<br>';
      term.scrollTop = term.scrollHeight;
      loadTokens();
    };

    loadTokens();
  </script>
</body>
</html>
    `);
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`Dashboard listening on port ${PORT}`);
});
