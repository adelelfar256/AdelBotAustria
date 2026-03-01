const puppeteer = require('puppeteer-core'); // use core for cloud
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const delay = ms => new Promise(res => setTimeout(res, ms));

// =========================
// CONFIG
// =========================
const telegramToken = '7044372335:AAEXrhJfADVi4nme9oo8ktJcb_6Yqeltp7E';
const USERS_FILE = path.join(__dirname, 'users.json');

const TARGET_URL = 'https://appointment.bmeia.gv.at/?Office=Kairo';
const CHECK_INTERVAL = 10000;
const CALENDAR_VALUE = '44281520';
const CALENDAR_SELECTOR = '#CalendarId';
const NEXT_BUTTON_SELECTOR = 'input[name="Command"][value="Next"]';
const BACK_BUTTON_SELECTOR = 'input[name="Command"][value="Back"]';

// =========================
// USERS STORAGE (JSON)
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
// TELEGRAM BOT
// =========================
const bot = new TelegramBot(telegramToken, { polling: true });

bot.on('polling_error', err => console.error('Telegram polling error:', err.message));

// /start command
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;

    if (!users.has(chatId)) {
        users.add(chatId);
        saveUsers();
        console.log(`New user registered: ${chatId}`);
    }

    bot.sendMessage(chatId, "✅ You are now subscribed to appointment alerts.");
});

// /stop command
bot.onText(/\/stop/, (msg) => {
    const chatId = msg.chat.id;

    if (users.has(chatId)) {
        users.delete(chatId);
        saveUsers();
        bot.sendMessage(chatId, "❌ You have been unsubscribed.");
    }
});

// Send to all registered users
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
// LOGGING
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
                executablePath: '/usr/bin/chromium-browser', // Render / Railway Chromium
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
            });

            const page = await browser.newPage();
            await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });
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
                    await page.waitForSelector(NEXT_BUTTON_SELECTOR, { timeout: 15000 });
                    await page.click(NEXT_BUTTON_SELECTOR);
                    logStep('NEXT', `Clicked Next (${i}/${nextClicks})`);
                    await delay(2000);
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

                const backButton = await page.$(BACK_BUTTON_SELECTOR);
                if (!backButton) throw new Error('Back button not found');

                await backButton.click();
                logStep('BACK', 'Restarting flow...');
                await delay(2000);

                firstRun = false;
            }

        } catch (err) {
            logStep('ERROR', err.message);
            await sendToAll(`❌ Error: ${err.message} — restarting flow`);

            if (browser) {
                try { await browser.close(); } catch {}
            }

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