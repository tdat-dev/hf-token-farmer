# 🌾 HF Token Farmer (Hugging Face & ZeroGPU Token Generator)

An autonomous, 100% hands-off batch creator for Hugging Face accounts and ZeroGPU Full Access API tokens. Powered by **Playwright**, **2Captcha hCaptcha REST API Solver**, **Guerrilla Mail API**, and a real-time web monitoring dashboard. Runs seamlessly on local macOS as well as **pure headless Ubuntu Linux servers (24/7)** using **Xvfb (Virtual Framebuffer)** or **Docker**.

---

## ⚡ Features

- **100% Automated hCaptcha Solving**: Directly calls the 2Captcha REST API (`HCaptchaTaskProxyless`, cost ~$0.00299/token). Zero manual captcha clicking required.
- **Disposable Email Lifecycle**: Leverages Guerrilla Mail to receive verification links and confirm accounts autonomously without burner phone numbers.
- **Full Access Token Extraction**: Configures and generates Hugging Face API tokens with `Full Access` scope, saving them directly to `tokens.txt`.
- **Headless Linux Support (Xvfb)**: Simulates a physical 1280x800 display buffer on headless Linux servers to bypass Cloudflare and browser integrity filters.
- **Real-time Web Dashboard**: Visual monitoring interface on port `3333` with real-time log streaming via Server-Sent Events (SSE).
- **Docker & Docker-Compose Ready**: One-command deployment on any Linux VPS with automatic crash recovery (`restart: always`).

---

## 🚀 Quick Start (Local macOS)

### 1. Installation
```bash
git clone https://github.com/tdat-dev/hf-token-farmer.git
cd hf-token-farmer
npm install
```

### 2. Configure Environment
```bash
cp .env.example .env
```
Edit `.env` and set your 2Captcha API key:
```env
TWOCAPTCHA_API_KEY=your_2captcha_api_key_here
PORT=3333
```

### 3. Generate Tokens via CLI
```bash
node auto_reg_hf.js --count=5
```

### 4. Or Use Web Dashboard
```bash
node dashboard.js
```
Open **[http://localhost:3333](http://localhost:3333)** in your browser, enter the desired batch count, and click **BẮT ĐẦU TẠO BATCH**.

---

## 🐧 Running 24/7 on Headless Ubuntu Linux VM (No GUI)

On headless Linux servers (AWS, DigitalOcean, Hetzner, Linode, etc.), Cloudflare blocks standard headless browsers. We use **Xvfb** to run a real Google Chrome instance inside a virtual frame buffer.

### Option A: Docker Compose (Recommended)

1. **Install Docker**:
   ```bash
   sudo apt update && sudo apt install -y docker.io docker-compose
   ```
2. **Start the 24/7 container**:
   ```bash
   docker-compose up -d --build
   ```
3. **Access Dashboard**:
   Navigate to `http://<YOUR_SERVER_IP>:3333` in your browser.
4. **Trigger token farming via CLI**:
   ```bash
   docker exec -it vanta-token-farmer node auto_reg_hf.js --count=10
   ```
   Tokens are automatically persisted to `./tokens.txt` on your host machine.

---

### Option B: Native Ubuntu Server with PM2 & Xvfb

1. **Install Dependencies & Google Chrome**:
   ```bash
   sudo apt update && sudo apt install -y xvfb curl wget libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 libasound2 fonts-liberation
   wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
   sudo apt install -y ./google-chrome-stable_current_amd64.deb && rm google-chrome-stable_current_amd64.deb
   ```

2. **Install Node.js 20 & PM2**:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt install -y nodejs
   sudo npm install -g pm2
   npm install
   ```

3. **Start Dashboard 24/7**:
   ```bash
   pm2 start dashboard.js --name "hf-dashboard"
   ```

4. **Run Token Generation in Background via Xvfb**:
   ```bash
   pm2 start --name "hf-farmer" "xvfb-run -a node auto_reg_hf.js --count=50"
   ```

5. **Persist across server reboots**:
   ```bash
   pm2 startup
   pm2 save
   ```

---

## 🛡 Security & Best Practices

- `tokens.txt` and `.env` are strictly excluded in `.gitignore` to prevent secret leaks.
- Always use proxy rotations if generating hundreds of accounts consecutively to avoid temporary IP rate limits from Guerrilla Mail or Hugging Face.

---

## 📄 License

MIT © [tdat-dev](https://github.com/tdat-dev)
