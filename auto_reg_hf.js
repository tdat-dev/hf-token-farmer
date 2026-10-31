import { chromium } from "playwright";
import fs from "fs";
import os from "os";
import path from "path";
import https from "https";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { insertAccount } from "./db.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sleep = ms => new Promise(res => setTimeout(res, ms));

function getChromeExecutable() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  if (process.platform === "darwin") {
    const macPath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if (fs.existsSync(macPath)) return macPath;
  } else if (process.platform === "linux") {
    const linuxPaths = [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium"
    ];
    for (const p of linuxPaths) {
      if (fs.existsSync(p)) return p;
    }
  } else if (process.platform === "win32") {
    const winPaths = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe")
    ];
    for (const p of winPaths) {
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined; // Fallback sang Chromium của Playwright
}

// ==========================================
// 1. GUERRILLA MAIL API
// ==========================================
function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    }).on("error", reject);
  });
}

async function createGuerrillaMail() {
  const user = "vanta" + Date.now().toString().slice(-4) + Math.floor(Math.random() * 899 + 100);
  const init = await getJson(`https://api.guerrillamail.com/ajax.php?f=set_email_user&email_user=${user}&lang=en`);
  if (!init || !init.email_addr || !init.sid_token) {
    throw new Error("Không thể kết nối đến máy chủ Guerrilla Mail");
  }

  const email = init.email_addr;
  const sid = init.sid_token;
  const rand = Math.random().toString(36).substring(2, 6);
  const password = `VantaSecure#2026_${rand}`;

  return { email, sid, password };
}

async function waitForGuerrillaVerification(sid, timeoutSec = 90) {
  console.log("   [Mail] Đang chờ email xác thực từ Hugging Face...");
  const start = Date.now();

  while ((Date.now() - start) < timeoutSec * 1000) {
    const check = await getJson(`https://api.guerrillamail.com/ajax.php?f=check_email&seq=0&sid_token=${sid}`);
    const list = check?.list || [];

    for (const msg of list) {
      if (msg.mail_subject?.includes("Hugging") || msg.mail_subject?.includes("confirm") || msg.mail_subject?.includes("Verify") || msg.mail_from?.includes("huggingface")) {
        console.log(`   [Mail] Đã nhận thư: "${msg.mail_subject}". Đang trích xuất link...`);
        const detail = await getJson(`https://api.guerrillamail.com/ajax.php?f=fetch_email&email_id=${msg.mail_id}&sid_token=${sid}`);
        const rawBody = (detail?.mail_body || "") + " " + (detail?.mail_excerpt || "");
        
        // 1. Quét tất cả href trong thẻ HTML <a href="...">
        const hrefs = [...rawBody.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]);
        
        // 2. Quét tất cả URL xuất hiện dạng text
        const textUrls = rawBody.match(/https?:\/\/[^\s"'<>\\]+/gi) || [];

        const candidateUrls = [...hrefs, ...textUrls].map(u => 
          u.replace(/&amp;/g, "&").replace(/[.,;)]+$/, "").trim()
        );

        // Lọc link kích hoạt ưu tiên cao nhất: chứa verify, confirm, hoặc token
        for (const url of candidateUrls) {
          if (url.includes("huggingface") && (url.includes("confirm") || url.includes("verify") || url.includes("token") || url.includes("/join/"))) {
            console.log(`   [Mail] ✅ BẮT ĐƯỢC LINK XÁC THỰC THÀNH CÔNG: ${url}`);
            return url;
          }
        }

        // Ưu tiên 2: Bất kỳ link nào trỏ về huggingface ngoại trừ homepage/footer
        for (const url of candidateUrls) {
          if (url.includes("huggingface.co") && !url.endsWith(".co/") && !url.endsWith(".co") && !url.includes("privacy") && !url.includes("terms")) {
            console.log(`   [Mail] ✅ BẮT ĐƯỢC LINK (FALLBACK): ${url}`);
            return url;
          }
        }

        // Ưu tiên 3: Bất kỳ link nào có chữ confirm/verify/token
        for (const url of candidateUrls) {
          if (url.includes("confirm") || url.includes("verify") || url.includes("token")) {
            console.log(`   [Mail] ✅ BẮT ĐƯỢC LINK (GENERIC): ${url}`);
            return url;
          }
        }

        console.log("   [Mail DEBUG] Raw body trích xuất:", rawBody.slice(0, 500));
      }
    }
    await sleep(2500);
  }

  throw new Error("Hết thời gian chờ email xác nhận từ Hugging Face.");
}

// ==========================================
// 2. AUTOMATION FLOW (100% HANDS-OFF 2CAPTCHA API)
const TWOCAPTCHA_API_KEY = process.env.TWOCAPTCHA_API_KEY || "";
const HCAPTCHA_SITEKEY = "5bd005a4-6ac8-4a86-8e60-53083832ed22";

if (!TWOCAPTCHA_API_KEY) {
  console.error("❌ Lỗi: Chưa cung cấp TWOCAPTCHA_API_KEY. Vui lòng cấu hình trong file .env!");
  process.exit(1);
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data)
      }
    }, res => {
      let out = "";
      res.on("data", c => out += c);
      res.on("end", () => {
        try {
          resolve(JSON.parse(out));
        } catch {
          resolve(out);
        }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function solveHcaptchaWith2Captcha() {
  console.log("   🤖 [2Captcha API] Đang gửi yêu cầu giải hCaptcha lên máy chủ 2Captcha...");

  // 1. Thử V1 API (chuẩn cho classic API key 32 ký tự hex)
  try {
    const v1Url = `https://2captcha.com/in.php?key=${TWOCAPTCHA_API_KEY}&method=hcaptcha&sitekey=${HCAPTCHA_SITEKEY}&pageurl=https://huggingface.co/join&json=1`;
    const initV1 = await getJson(v1Url);
    if (initV1 && initV1.status === 1 && initV1.request) {
      const taskId = initV1.request;
      console.log(`   ⏳ [2Captcha V1 API] Task ID: ${taskId}. Đang đợi hệ thống giải tự động 100%...`);
      const start = Date.now();
      let lastLoggedSec = 0;
      while ((Date.now() - start) < 180000) {
        await sleep(3500);
        const poll = await getJson(`https://2captcha.com/res.php?key=${TWOCAPTCHA_API_KEY}&action=get&id=${taskId}&json=1`);
        if (poll && poll.status === 1) {
          const elapsed = Math.round((Date.now() - start) / 1000);
          console.log(`   🎉 [2Captcha API] Đã giải thành công trong ${elapsed}s!`);
          return { token: poll.request, respKey: poll.request };
        }
        if (poll && poll.request === "CAPCHA_NOT_READY") {
          const elapsed = Math.round((Date.now() - start) / 1000);
          if (elapsed - lastLoggedSec >= 10) {
            lastLoggedSec = elapsed;
            console.log(`   ⏳ [2Captcha API] Đang xử lý câu đố tự động... (${elapsed}s/180s)`);
          }
        } else {
          throw new Error(`2Captcha V1 Error: ${JSON.stringify(poll)}`);
        }
      }
      throw new Error("2Captcha V1 timeout sau 180 giây.");
    }
  } catch (err) {
    console.warn(`   ⚠️ [2Captcha V1 fallback] ${err.message}. Đang thử V2 API...`);
  }

  // 2. Fallback sang V2 API (nếu dùng V2 clientKey)
  const create = await postJson("https://api.2captcha.com/createTask", {
    clientKey: TWOCAPTCHA_API_KEY,
    task: {
      type: "HCaptchaTaskProxyless",
      websiteURL: "https://huggingface.co/join",
      websiteKey: HCAPTCHA_SITEKEY
    }
  });

  if (create.errorId !== 0) {
    throw new Error(`2Captcha Task Creation Failed: ${create.errorDescription || JSON.stringify(create)}`);
  }

  const taskId = create.taskId;
  console.log(`   ⏳ [2Captcha V2 API] Task ID: ${taskId}. Đang đợi hệ thống giải tự động 100%...`);

  const start = Date.now();
  let lastLoggedSec = 0;
  while ((Date.now() - start) < 180000) {
    await sleep(3500);
    const res = await postJson("https://api.2captcha.com/getTaskResult", {
      clientKey: TWOCAPTCHA_API_KEY,
      taskId
    });

    if (res.status === "ready") {
      const elapsed = Math.round((Date.now() - start) / 1000);
      console.log(`   🎉 [2Captcha API] Đã giải thành công trong ${elapsed}s! Chi phí: $${res.cost || '0.003'}`);
      return res.solution;
    }

    if (res.status === "processing") {
      const elapsed = Math.round((Date.now() - start) / 1000);
      if (elapsed - lastLoggedSec >= 10) {
        lastLoggedSec = elapsed;
        console.log(`   ⏳ [2Captcha API] Đang xử lý câu đố tự động... (${elapsed}s/180s)`);
      }
    } else {
      throw new Error(`2Captcha Task Failed: ${res.errorDescription || JSON.stringify(res)}`);
    }
  }

  throw new Error("2Captcha timeout sau 180 giây.");
}

// ==========================================
// 2. AUTOMATION FLOW (100% HANDS-OFF 2CAPTCHA API)
// ==========================================
async function registerOneAccount(accountIndex, total) {
  console.log(`\n==============================================`);
  console.log(`🚀 [${accountIndex}/${total}] KHỞI TẠO TÀI KHOẢN MỚI...`);
  console.log(`==============================================`);

  const mailData = await createGuerrillaMail();
  console.log(`1. Email ảo được cấp: ${mailData.email}`);

  // Bắt đầu gọi 2Captcha giải câu đố song song ngay từ đầu để tiết kiệm thời gian
  const captchaPromise = solveHcaptchaWith2Captcha();

  const profileDir = path.join(os.tmpdir(), `vanta_profile_${Date.now()}`);

  const chromeExec = getChromeExecutable();
  console.log(`2. Đang khởi chạy trình duyệt: ${chromeExec || 'Playwright Chromium'}...`);

  const launchOptions = {
    headless: process.platform === "linux" ? true : false,
    slowMo: process.platform === "linux" ? 10 : 30,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
    ],
    viewport: { width: 1280, height: 800 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  };

  if (process.platform === "linux") {
    launchOptions.args.push("--proxy-server=socks5://127.0.0.1:40000");
  }

  if (chromeExec) {
    launchOptions.executablePath = chromeExec;
  }

  const context = await chromium.launchPersistentContext(profileDir, launchOptions);

  // Tiêm hook hCaptcha vào trình duyệt trước khi tải trang
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });

    window.__inject2CaptchaToken = (token, respKey) => {
      window.__solvedToken = token;
      window.__solvedRespKey = respKey;
      document.querySelectorAll("[name=\"h-captcha-response\"], [name=\"g-recaptcha-response\"]").forEach(el => {
        el.value = token;
      });
    };

    let _hcaptcha = window.hcaptcha;
    Object.defineProperty(window, "hcaptcha", {
      configurable: true,
      get: () => _hcaptcha,
      set: (val) => {
        _hcaptcha = val;
        if (val && typeof val === "object") {
          val.execute = async function(widgetId, opt) {
            console.log("🚀 [HOOK] hcaptcha.execute triggered!");
            const token = window.__solvedToken || "";
            const respKey = window.__solvedRespKey || "";
            document.querySelectorAll("[name=\"h-captcha-response\"], [name=\"g-recaptcha-response\"]").forEach(el => {
              el.value = token;
            });
            return { response: token, key: respKey };
          };
          val.getResponse = function() { return window.__solvedToken || ""; };
          val.getRespKey = function() { return window.__solvedRespKey || ""; };
        }
      }
    });
  });

  const page = context.pages()[0] || await context.newPage();

  try {
    console.log("3. Đang mở https://huggingface.co/join ...");
    await page.goto("https://huggingface.co/join", { waitUntil: "domcontentloaded" });

    // Bước 1: Điền email & password
    await page.waitForSelector("input[name='email']", { timeout: 120000 });
    console.log("4. Tự động điền Email & Mật khẩu...");
    const emailInput = page.locator("input[name='email']");
    await emailInput.click();
    await emailInput.pressSequentially(mailData.email, { delay: 15 });

    const passInput = page.locator("input[name='password']");
    await passInput.click();
    await passInput.pressSequentially(mailData.password, { delay: 15 });
    
    await sleep(600);
    // Bấm nút Next để sang bước 2 (hoặc gõ Enter)
    await passInput.press("Enter");

    // Chờ chuyển sang Bước 2 (Username)
    await page.waitForSelector("input[name='username']", { timeout: 120000 });

    // Bước 2: Tự động điền Username (chữ và số)
    console.log("5. Tự động điền Username chuẩn & đồng ý Điều khoản...");
    const username = "vanta" + Date.now().toString().slice(-4) + Math.floor(Math.random() * 899 + 100);
    
    const usernameInput = page.locator("input[name='username']");
    await usernameInput.click();
    await usernameInput.pressSequentially(username, { delay: 15 });

    const fullnameInput = page.locator("input[name='fullname']");
    await fullnameInput.click();
    await fullnameInput.pressSequentially("Vanta Creator", { delay: 15 });

    const checkbox = await page.$("input[type='checkbox']");
    if (checkbox) await checkbox.check();

    // Hiện thông báo trạng thái nổi ngay trên giao diện Chrome
    await page.evaluate(() => {
      const banner = document.createElement("div");
      banner.id = "vanta-status-banner";
      banner.style = "position: fixed; top: 16px; left: 50%; transform: translateX(-50%); background: #0f172a; color: #38bdf8; border: 2px solid #0284c7; padding: 12px 24px; border-radius: 9999px; font-size: 14px; font-weight: bold; z-index: 999999; box-shadow: 0 10px 25px rgba(0,0,0,0.5); font-family: -apple-system, sans-serif;";
      banner.innerHTML = "🤖 [2Captcha AI] Đang giải câu đố ngầm (khoảng 60-90s)... Sẽ tự động bấm 'Create Account' ngay khi xong!";
      document.body.appendChild(banner);
    }).catch(() => {});

    // Chờ 2Captcha trả về kết quả
    console.log("👉 Đang chờ 2Captcha trả về token giải tự động...");
    const solution = await captchaPromise;

    await page.evaluate(() => {
      const b = document.getElementById("vanta-status-banner");
      if (b) {
        b.style.borderColor = "#10b981";
        b.style.color = "#34d399";
        b.innerHTML = "🎉 [2Captcha AI] Đã giải xong! Đang tự động bấm 'Create Account'...";
      }
    }).catch(() => {});

    console.log("👉 Đang tiêm token hCaptcha từ 2Captcha vào form...");
    await page.evaluate(({ token, respKey }) => {
      window.__inject2CaptchaToken(token, respKey);
    }, { token: solution.token, respKey: solution.respKey });

    console.log("👉 Đang tự động bấm 'Create Account' với Captcha đã giải 100%...");
    await page.click("button[type='submit']");

    // Chờ tài khoản gửi thành công
    let submitted = false;
    const startWait = Date.now();

    while ((Date.now() - startWait) < 60000) {
      try {
        const curUrl = page.url();
        if (!curUrl.endsWith("/join")) {
          submitted = true;
          break;
        }
        const content = await page.content().catch(() => "");
        if (content && (content.includes("Check your email") || content.includes("confirmation link") || content.includes("verification link") || content.includes("email_confirmation"))) {
          submitted = true;
          break;
        }
      } catch (err) {
        if (err.message && (err.message.includes("navigating") || err.message.includes("Navigation") || err.message.includes("execution context was destroyed"))) {
          submitted = true;
          break;
        }
      }
      await sleep(1500);
    }

    if (!submitted) {
      const errText = await page.$$eval(".text-red-500, [role='alert'], .text-error, form div.text-red-600, form p.text-red-500", els => els.map(e => e.innerText)).catch(() => []);
      const pageText = await page.innerText("form").catch(() => "");
      await page.screenshot({ path: path.join(os.tmpdir(), "hf_submit_failed.png") }).catch(() => {});
      console.log("   [Debug] Form content sau khi bấm submit:\n", pageText.slice(0, 500));
      console.log("   [Debug] Lỗi hiển thị trên form:", errText);
      throw new Error(`Không thể xác nhận chuyển trang sau khi bấm Create Account. Lỗi: ${JSON.stringify(errText)}`);
    }

    console.log("🎉 ĐÃ TỰ ĐỘNG VƯỢT CAPTCHA THÀNH CÔNG (0 thao tác thủ công)!");
    console.log("6. Đã gửi form thành công! Đang đón link kích hoạt từ email...");
    const verifyLink = await waitForGuerrillaVerification(mailData.sid);

    console.log("7. Đang kích hoạt tài khoản...");
    try {
      await page.goto(verifyLink, { waitUntil: "domcontentloaded", timeout: 30000 });
    } catch (e) {
      // Bỏ qua nếu trang chuyển hướng làm gián đoạn goto
    }
    await sleep(3000);

    console.log("8. Đang tự động tạo Access Token...");
    await page.goto("https://huggingface.co/settings/tokens/new", { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(2500);

    const tokenName = `vanta_pool_${Date.now()}`;
    console.log(`👉 Đang tự động điền Token Name: ${tokenName}...`);

    // Hàm bọc evaluate an toàn chống lỗi 'Execution context was destroyed' khi trang chuyển hướng
    const safeEval = async (fn, arg = null, fallback = null) => {
      try {
        return await page.evaluate(fn, arg);
      } catch (err) {
        if (err.message && (err.message.includes("destroyed") || err.message.includes("navigating") || err.message.includes("context"))) {
          await sleep(1500);
          try {
            return await page.evaluate(fn, arg);
          } catch {
            return fallback;
          }
        }
        return fallback;
      }
    };

    // Điền chính xác ô Token Name (bỏ qua search bar trên header)
    await safeEval((val) => {
      const formInputs = Array.from(document.querySelectorAll("main input, form input, [role='main'] input"));
      const allInputs = formInputs.length > 0 ? formInputs : Array.from(document.querySelectorAll("input"));
      
      const target = allInputs.find(i => {
        const ph = (i.placeholder || "").toLowerCase();
        const nm = (i.name || "").toLowerCase();
        const id = (i.id || "").toLowerCase();
        const lbl = i.labels ? Array.from(i.labels).map(l => l.textContent.toLowerCase()).join(" ") : "";
        return ph.includes("token") || ph.includes("name") || nm.includes("token") || nm.includes("name") || id.includes("token") || id.includes("name") || lbl.includes("token") || lbl.includes("name");
      }) || allInputs.find(i => i.type === "text" && !i.placeholder.toLowerCase().includes("search") && !i.placeholder.toLowerCase().includes("organization"));

      if (target) {
        target.focus();
        target.value = val;
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, tokenName);

    try {
      const loc = page.locator("main input[type='text'], form input[type='text']").first();
      if (await loc.count() > 0) {
        await loc.fill(tokenName).catch(() => {});
      }
    } catch {}

    // 1. Chọn mục "Fine-grained" nếu chưa chọn
    await safeEval(() => {
      const allEls = Array.from(document.querySelectorAll("label, button, input, div, span"));
      const fineGrainedEl = allEls.find(el => 
        el.textContent && el.textContent.trim().toLowerCase() === "fine-grained"
      );
      if (fineGrainedEl) fineGrainedEl.click();
    });

    await sleep(1000);

    // 2. Click chọn Preset "Full Access" (bắt buộc trước khi tạo token)
    console.log("👉 Đang click chọn preset 'Full Access'...");
    let fullAccessClicked = false;
    
    // Thử 1: Playwright locator bằng text chính xác
    try {
      const fullAccessBtn = page.getByText("Full Access", { exact: true })
        .or(page.locator("button:has-text('Full Access')"))
        .first();
      await fullAccessBtn.waitFor({ state: "visible", timeout: 8000 });
      await fullAccessBtn.click();
      fullAccessClicked = true;
      console.log("👉 Đã chọn preset 'Full Access' qua Playwright Locator!");
    } catch (e) {
      console.log("⚠️ Locator chờ timeout, chuyển sang click DOM trực tiếp...");
    }

    // Thử 2: Quét DOM và bắn full chuỗi mouse events
    if (!fullAccessClicked) {
      await safeEval(() => {
        const all = Array.from(document.querySelectorAll("button, [role='button'], div, span, label"));
        const btn = all.find(el => el.textContent && el.textContent.trim() === "Full Access") ||
                    all.find(el => el.textContent && el.textContent.trim().includes("Full Access"));
        if (btn) {
          const clickable = btn.closest("button") || btn.closest("[role='button']") || btn;
          clickable.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          clickable.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
          clickable.click();
        }
      });
      console.log("👉 Đã click preset 'Full Access' qua DOM event!");
    }

    // Đợi 2s để Hugging Face áp dụng preset và kích hoạt nút Create token
    await sleep(2000);

    // 3. Bấm chính xác nút "Create token" ở cuối form
    console.log("👉 Đang bấm nút 'Create token'...");
    let clicked = false;
    try {
      const btn = page.getByRole("button", { name: /^Create token$/i })
        .or(page.locator("button:has-text('Create token')"))
        .last();
      await btn.scrollIntoViewIfNeeded({ timeout: 5000 });
      await btn.click({ timeout: 5000 });
      clicked = true;
    } catch {
      clicked = await safeEval(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const btn = btns.find(b => b.textContent && b.textContent.trim().toLowerCase() === "create token");
        if (btn) {
          btn.scrollIntoView();
          btn.click();
          return true;
        }
        return false;
      }, null, false);
    }
    console.log(`👉 Trạng thái bấm 'Create token': ${clicked ? "Đã bấm thành công" : "Cần kiểm tra"}`);

    // Đợi 2.5s để trang submit và render modal token
    await sleep(2500);

    // 4. Chờ và trích xuất token hf_
    let tokenVal = "";
    const startTokenWait = Date.now();
    while ((Date.now() - startTokenWait) < 30000) {
      tokenVal = await safeEval(() => {
        const elements = Array.from(document.querySelectorAll("input, textarea, code, pre, span, div, p"));
        for (const el of elements) {
          const val = el.value || el.textContent || "";
          const m = val.match(/hf_[a-zA-Z0-9]{30,40}/);
          if (m) return m[0];
        }
        const m = document.body ? document.body.innerHTML.match(/hf_[a-zA-Z0-9]{30,40}/) : null;
        return m ? m[0] : "";
      }, null, "");

      if (tokenVal && tokenVal.startsWith("hf_")) break;
      await sleep(1500);
    }

    if (!tokenVal || !tokenVal.startsWith("hf_")) {
      const textPreview = await safeEval(() => document.body ? document.body.innerText.slice(0, 500) : "", "");
      console.log("   [DEBUG Token Form]:", textPreview.replace(/\n+/g, " "));
      await page.screenshot({ path: path.join(os.tmpdir(), "hf_token_fail.png") }).catch(() => {});
      throw new Error(`Token không hợp lệ. Đã lưu ảnh chụp giao diện tại ${path.join(os.tmpdir(), "hf_token_fail.png")}`);
    }

    console.log(`\n🎉 THÀNH CÔNG! TOKEN ĐÃ TẠO: ${tokenVal}`);
    try {
      insertAccount({
        token: tokenVal,
        email: mailData?.email || "",
        password: mailData?.password || "",
        username: username || "",
        token_name: tokenName || "",
        status: "active",
        notes: "Auto-farmed via Playwright & 2Captcha"
      });
      console.log(`✅ Đã tự động lưu vào DATABASE (tokens.db)`);
    } catch (dbErr) {
      console.error(`⚠️ Lỗi ghi Database: ${dbErr.message}`);
    }

    return tokenVal;

  } finally {
    await context.close();
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

// ==========================================
// 3. MAIN RUNNER
// ==========================================
async function main() {
  const args = process.argv.slice(2);
  let count = 5;

  for (const arg of args) {
    if (arg.startsWith("--count=")) {
      count = parseInt(arg.split("=")[1], 10) || 5;
    }
  }

  console.log(`=== BẮT ĐẦU TOOL TẠO BATCH ${count} TÀI KHOẢN HUGGING FACE ===`);
  const successTokens = [];

  for (let i = 1; i <= count; i++) {
    try {
      const token = await registerOneAccount(i, count);
      successTokens.push(token);
    } catch (err) {
      console.error(`❌ [${i}/${count}] Thất bại: ${err.message}`);
    }

    if (i < count) {
      console.log("Nghỉ 3 giây trước tài khoản tiếp theo...");
      await sleep(3000);
    }
  }

  console.log(`\n==============================================`);
  console.log(`🏁 HOÀN TẤT BATCH!`);
  console.log(`Đã tạo thành công: ${successTokens.length}/${count} token.`);
  console.log(`Tất cả token đã được nạp thẳng vào: ${TOKENS_FILE}`);
  console.log(`==============================================`);
}

main().catch(err => {
  console.error("Lỗi chương trình:", err);
  process.exit(1);
});
