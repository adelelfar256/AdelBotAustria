const puppeteer = require('puppeteer'); // Puppeteer with bundled Chromium
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// =========================
// CONFIG
// =========================
const TELEGRAM_TOKEN = '7044372335:AAEXrhJfADVi4nme9oo8ktJcb_6Yqeltp7E'; // ← replace with your bot token
const USERS_FILE = path.join(__dirname, 'users.json');

const TARGET_URL = 'https://appointment.bmeia.gv.at/?Office=Kairo';
const CHECK_INTERVAL = 10000; // 10 seconds for testing
const CALENDAR_VALUE = '44281520';
const CALENDAR_SELECTOR = '#CalendarId';
const NEXT_BUTTON_SELECTOR = 'input[name="Command"][value="Next"]';
const BACK_BUTTON_SELECTOR = 'input[name="Command"][value="Back"]';

// =========================
// DELAY HELPER
// =========================
const delay = ms => new Promise(res => setTimeout(res, ms));

// =========================
// USERS STORAGE
// =========================
let users = new Set();
if (fs.existsSync(USERS_FILE)) {
    const data = JSON.parse(fs.readFileSync(USERS_FILE));
    users = new Set(data);
}

function saveUsers() {
    fs.writeFileSync(USERS_FILE, JSON.stringify([...users]));
}

// =========================
// TELEGRAM BOT (POLLING LOCAL)
// =========================
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Suppress 409 Conflict errors
bot.on('polling_error', (err) => {
    if (err.code === 'ETELEGRAM' && err.response?.body?.error_code === 409) {
        return; // ignore 409 errors
    }
    console.error('[polling_error]', err);
});

// Commands
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    if (!users.has(chatId)) {
        users.add(chatId);
        saveUsers();
        console.log(`New user registered: ${chatId}`);
    }
    bot.sendMessage(chatId, "✅ You are now subscribed to appointment alerts.");
});

bot.onText(/\/stop/, (msg) => {
    const chatId = msg.chat.id;
    if (users.has(chatId)) {
        users.delete(chatId);
        saveUsers();
        bot.sendMessage(chatId, "❌ You have been unsubscribed.");
    }
});

async function sendToAll(message) {
    for (const id of users) {
        try {
            await bot.sendMessage(id, message);
            console.log(`[TELEGRAM] Sent to ${id}`);
        } catch (err) {
            console.error(`[TELEGRAM] Failed to send to ${id}:`, err.message);
        }
    }
}

// =========================
// LOG HELPER
// =========================
function logStep(step, extra = '') {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] [${step}] ${extra}`);
}

// =========================
// PUPPETEER FLOW
// =========================
async function runFlow() {
    while (true) {
        let browser;
        try {
            logStep('START', 'Launching Puppeteer...');
            browser = await puppeteer.launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--disable-extensions',
                    '--window-size=1920,1080'
                ]
            });

            const page = await browser.newPage();
            await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 120000 });
            logStep('PAGE', 'Page loaded');

            await page.waitForSelector(CALENDAR_SELECTOR, { timeout: 20000 });
            const optionExists = await page.$(`${CALENDAR_SELECTOR} option[value="${CALENDAR_VALUE}"]`);
            if (!optionExists) throw new Error(`Calendar option ${CALENDAR_VALUE} not found`);

            await page.select(CALENDAR_SELECTOR, CALENDAR_VALUE);
            logStep('SELECT', 'Calendar selected');

            let lastAvailable = false;
            let firstRun = true;

            while (true) {
                const nextClicks = firstRun ? 3 : 2;

                for (let i = 1; i <= nextClicks; i++) {
                    try {
                        await page.waitForSelector(NEXT_BUTTON_SELECTOR, { timeout: 20000 });
                        await page.click(NEXT_BUTTON_SELECTOR);
                        logStep('NEXT', `Clicked Next (${i}/${nextClicks})`);
                        await delay(2000);
                    } catch {
                        logStep('WARN', 'Next button not found, retrying in 5s');
                        await delay(5000);
                    }
                }

                const content = await page.content();
                if (content.toLowerCase().includes('unfortunately')) {
                    logStep('STATUS', 'No appointments available');
                    lastAvailable = false;
                } else {
                    logStep('STATUS', 'Appointments might be available!');
                    if (!lastAvailable) {
                        await sendToAll('✅ Appointments might be available! Check manually.');
                        lastAvailable = true;
                    }
                }

                try {
                    const backButton = await page.$(BACK_BUTTON_SELECTOR);
                    if (backButton) {
                        await backButton.click();
                        logStep('BACK', 'Restarting flow...');
                        await delay(2000);
                    }
                } catch {
                    logStep('WARN', 'Back button not found, will retry flow');
                }

                firstRun = false;
            }

        } catch (err) {
            logStep('ERROR', err.message); // only log locally
            // do NOT send errors to Telegram
            if (browser) try { await browser.close(); } catch {}
            logStep('WAIT', `Retrying in ${CHECK_INTERVAL / 1000}s`);
            await delay(CHECK_INTERVAL);
        }
    }
}

// =========================
// START BOT & FLOW
// =========================
logStep('BOT', 'Bot started...');
runFlow();