const puppeteer = require('puppeteer');
const TelegramBot = require('node-telegram-bot-api');

const delay = ms => new Promise(res => setTimeout(res, ms));

/* =========================
   CONFIG (FROM ENV)
========================= */

const telegramToken = process.env.TELEGRAM_TOKEN;
if (!telegramToken) {
    console.error("❌ TELEGRAM_TOKEN is not set.");
    process.exit(1);
}

const CHECK_INTERVAL = Number(process.env.CHECK_INTERVAL) || 60000;

let telegramChatIds = (process.env.TELEGRAM_CHAT_IDS || "")
    .split(',')
    .map(id => id.trim())
    .filter(Boolean)
    .map(Number);

if (!telegramChatIds.length) {
    console.warn("⚠️ No TELEGRAM_CHAT_IDS configured.");
}

console.log("Loaded chat IDs:", telegramChatIds);

/* =========================
   TELEGRAM BOT
========================= */

const bot = new TelegramBot(telegramToken, { polling: true });

// Restart polling if it crashes
bot.on('polling_error', async (error) => {
    console.error('Polling error:', error.message || error);
    try {
        await bot.stopPolling();
        await delay(2000);
        await bot.startPolling();
    } catch (err) {
        console.error("Failed to restart polling:", err.message);
    }
});

/* =========================
   HELPERS
========================= */

async function sendToAll(message) {
    for (const id of telegramChatIds) {
        try {
            await bot.sendMessage(id, message);
        } catch (err) {
            console.error(`Failed to send to ${id}:`, err.message);
        }
    }
}

async function sendPhotoToAll(photoPath, options = {}) {
    for (const id of telegramChatIds) {
        try {
            await bot.sendPhoto(id, photoPath, options);
        } catch (err) {
            console.error(`Failed to send photo to ${id}:`, err.message);
        }
    }
}

/* =========================
   MAIN LOOP
========================= */

async function run() {
    while (true) {
        let browser;

        try {
            console.log("Checking website...");

            browser = await puppeteer.launch({
                headless: "new",
                args: [
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-gpu"
                ]
            });

            const page = await browser.newPage();
            await page.goto(TARGET_URL, {
                waitUntil: "networkidle2",
                timeout: 60000
            });

            await sendToAll("✅ Bot checked the website successfully.");

            console.log("Check complete.");
        } catch (error) {
            console.error("Main loop error:", error.message);
            await sendToAll(`❌ Error: ${error.message}`);
        } finally {
            if (browser) {
                try {
                    await browser.close();
                } catch {}
            }

            await delay(CHECK_INTERVAL);
        }
    }
}

run();