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

// Load chat IDs from ENV (comma separated)
let telegramChatIds = [];

if (process.env.TELEGRAM_CHAT_IDS) {
    telegramChatIds = process.env.TELEGRAM_CHAT_IDS
        .split(',')
        .map(id => id.trim())
        .filter(Boolean)
        .map(id => Number(id));
}

console.log("Loaded chat IDs:", telegramChatIds);

/* =========================
   TELEGRAM BOT
========================= */

const bot = new TelegramBot(telegramToken, { polling: true });

// Auto-restart polling if error
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

// Auto-subscribe new users
bot.on('message', (msg) => {
    const chatId = msg.chat.id;

    if (!telegramChatIds.includes(chatId)) {
        telegramChatIds.push(chatId);
        bot.sendMessage(chatId, "✅ You are now subscribed.");
        console.log("New subscriber:", chatId);
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
            browser = await puppeteer.launch({
                headless: "new",
                args: ["--no-sandbox", "--disable-setuid-sandbox"]
            });

            const page = await browser.newPage();

            // Example target (replace with your booking URL)
            await page.goto('https://example.com', {
                waitUntil: 'networkidle0'
            });

            await sendToAll("✅ Bot checked the website successfully.");

            await browser.close();
        } catch (error) {
            console.error("Main loop error:", error.message);
        } finally {
            if (browser) {
                try {
                    await browser.close();
                } catch {}
            }

            // Wait before next cycle
            await delay(60000); // 1 minute
        }
    }
}

run();