const puppeteer = require('puppeteer');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// =========================
// CONFIG
// =========================
const telegramToken = '7044372335:AAFh0yuQBNiAUYY80WDIZ1MihjzWLgLanJk';
const TARGET_URL = 'https://appointment.bmeia.gv.at/?Office=Bangkok';
const CALENDAR_SEARCH = 'Beg'; 
const CHECK_INTERVAL = 15000; // Increased for Railway stability

const isRailway = process.env.RAILWAY_ENVIRONMENT || process.env.PORT;
const usersPath = path.join(__dirname, 'users.json');

let users = {};
if (fs.existsSync(usersPath)) {
    users = JSON.parse(fs.readFileSync(usersPath));
}

let currentPage = null; 
const bot = new TelegramBot(telegramToken, { 
    polling: { params: { drop_pending_updates: true } } 
});
const delay = ms => new Promise(res => setTimeout(res, ms));

// Helper for logging to both Console and Telegram
async function superLog(message) {
    const timestamp = new Date().toLocaleTimeString();
    const msg = `[${timestamp}] ${message}`;
    console.log(msg);
    const adminId = Object.keys(users)[0];
    if (adminId) {
        await bot.sendMessage(adminId, `🛰 **LOG:** ${message}`).catch(() => {});
    }
}

// =========================
// TELEGRAM REPLY LISTENER
// =========================
bot.on('message', async (msg) => {
    const text = msg.text;
    if (!text || !currentPage) return;

    if (msg.reply_to_message && msg.reply_to_message.caption && msg.reply_to_message.caption.includes("FORM")) {
        try {
            const inputSelector = '#CaptchaText'; 
            const submitSelector = 'input[type="submit"][value="Next"], input[type="submit"][value="التالى"]';

            const exists = await currentPage.$(inputSelector);
            if (exists) {
                await superLog(`⌨️ Typing CAPTCHA: ${text}`);
                await currentPage.click(inputSelector);
                await currentPage.click(inputSelector, { clickCount: 3 });
                await currentPage.keyboard.press('Backspace');

                for (const char of text) {
                    await currentPage.type(inputSelector, char.toUpperCase(), { delay: 40 });
                }
                
                await delay(500); 
                await superLog("🖱 Auto-clicking Next button...");
                await currentPage.click(submitSelector);
            }
        } catch (e) {
            await superLog(`❌ Error in auto-submit: ${e.message}`);
        }
    }
});

async function waitAndClickNext(page, stepName) {
    const selector = 'input[type="submit"][value="Next"], input[type="submit"][value="التالى"]';
    try {
        await superLog(`Step: ${stepName} - Waiting for 'Next' button...`);
        await page.waitForSelector(selector, { visible: true, timeout: 15000 });
        
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
            page.click(selector)
        ]);
        await superLog(`Step: ${stepName} - ✅ Done.`);
        return true;
    } catch (e) {
        await superLog(`Step: ${stepName} - ❌ Failed: ${e.message}`);
        return false;
    }
}

// =========================
// MAIN RUNNER
// =========================
async function runFlow() {
    let browser;
    try {
        await superLog(`🚀 Starting Flow (Mode: ${isRailway ? 'Railway/Headless' : 'Local/Headed'})`);
        
        browser = await puppeteer.launch({
            headless: isRailway ? "new" : false, 
            defaultViewport: { width: 1280, height: 800 },
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        });

        currentPage = await browser.newPage();
        await superLog(`🌐 Navigating to BMEIA...`);
        await currentPage.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });

        await superLog(`🔎 Checking for Calendar dropdown...`);
        await currentPage.waitForSelector('#CalendarId', { timeout: 20000 });
        
        const masterValue = await currentPage.evaluate((search) => {
            const sel = document.querySelector('#CalendarId');
            const opt = Array.from(sel.options).find(o => o.textContent.toLowerCase().includes(search.toLowerCase()));
            return opt ? opt.value : null;
        }, CALENDAR_SEARCH);

        if (masterValue) {
            await superLog(`✅ Dropdown option found. Selecting...`);
            await currentPage.select('#CalendarId', masterValue);
        } else {
            throw new Error(`Could not find "${CALENDAR_SEARCH}" in dropdown.`);
        }

        // Navigate the 3 initial steps
        for (let i = 1; i <= 3; i++) {
            const success = await waitAndClickNext(currentPage, `Initial Click ${i}`);
            if (!success) throw new Error(`Failed at initial step ${i}`);
        }

        await superLog(`📡 Scanning for available radio slots...`);
        const radios = await currentPage.$$('input[type="radio"]');
        
        if (radios.length > 0) {
            await superLog(`✨ SLOT FOUND! ${radios.length} options available.`);
            await radios[0].click();
            await delay(800);
            await waitAndClickNext(currentPage, "Radio Selection Next");

            const firstUserKey = Object.keys(users)[0];
            if (firstUserKey) {
                await superLog(`📝 Filling form for user: ${firstUserKey}`);
                // [Your fillFormForUser function logic here]
                // ...
                await superLog(`📸 Capturing form and sending to Telegram...`);
                // [Your captureAndSendForm function logic here]
            }
        } else {
            await superLog('😴 No slots found. Closing browser and cooling down...');
            await browser.close();
            await delay(CHECK_INTERVAL);
            return runFlow();
        }

    } catch (err) {
        await superLog(`🚨 CRITICAL ERROR: ${err.message}`);
        if (browser) await browser.close();
        await superLog(`⏳ Waiting 30s before full restart to clear 409 conflict...`);
        await delay(30000); 
        runFlow();
    }
}

// Global Conflict Watcher
bot.on('polling_error', (err) => {
    if (err.code === 'ETELEGRAM' && err.message.includes('409')) {
        console.log("409 Conflict - Polling already active.");
    }
});

runFlow();