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
const CHECK_INTERVAL = 10000; // Increased to 10s for stability

const isRailway = process.env.RAILWAY_ENVIRONMENT || process.env.PORT;
const usersPath = path.join(__dirname, 'users.json');

let users = {};
let setupState = { active: false, step: 0, data: {}, chatId: null };
let userPages = {}; 
let browser = null;

const QUESTIONS = [
    { key: 'firstName', label: 'First Name' },
    { key: 'lastName', label: 'Last Name' },
    { key: 'lastNameAtBirth', label: 'Last Name at Birth' },
    { key: 'dob', label: 'Date of Birth', hint: '(e.g. 3/15/2016)' },
    { key: 'placeOfBirth', label: 'Place of Birth (City)' },
    { key: 'countryOfBirth', label: 'Country of Birth', hint: '(e.g. Egypt)' },
    { key: 'sex', label: 'Sex (Male/Female)' },
    { key: 'street', label: 'Street' },
    { key: 'postcode', label: 'Postcode' },
    { key: 'city', label: 'City' },
    { key: 'country', label: 'Current Country', hint: '(e.g. Egypt)' },
    { key: 'telephone', label: 'Telephone Number' },
    { key: 'email', label: 'Email Address' },
    { key: 'passportNumber', label: 'Passport Number' },
    { key: 'passportIssueDate', label: 'Passport Issue Date', hint: '(e.g. 3/15/2016)' },
    { key: 'passportValidUntil', label: 'Passport Expiry Date', hint: '(e.g. 3/15/2016)' },
    { key: 'passportAuthority', label: 'Passport Issuing Authority' },
    { key: 'nationalityAtBirth', label: 'Nationality at Birth', hint: '(e.g. Egypt)' },
    { key: 'actualNationality', label: 'Current Nationality', hint: '(e.g. Egypt)' }
];

async function debugLog(message) {
    const logMsg = `[${new Date().toISOString()}] ${message}`;
    console.log(logMsg);
    const adminId = Object.keys(users)[0];
    if (adminId) bot.sendMessage(adminId, `🛠 DEBUG: ${logMsg}`).catch(() => {});
}

if (fs.existsSync(usersPath)) {
    try { users = JSON.parse(fs.readFileSync(usersPath)); } catch (e) { users = {}; }
}

const bot = new TelegramBot(telegramToken, { 
    polling: { params: { drop_pending_updates: true } }
});

// 409 CONFLICT PROTECTOR: If we get a conflict, wait and stop
bot.on('polling_error', async (err) => {
    if (err.code === 'ETELEGRAM' && err.message.includes('409')) {
        console.error("🚨 409 CONFLICT: Another bot is running. Sleeping 60s...");
        // Do not crash, just wait for the other instance to potentially die
    }
});

const delay = ms => new Promise(res => setTimeout(res, ms));

// =========================
// TELEGRAM COMMANDS
// =========================
bot.onText(/\/status/, (msg) => {
    bot.sendMessage(msg.chat.id, `📊 *Status:*\nActive Tabs: ${Object.keys(userPages).length}`);
});

bot.onText(/\/restart/, async (msg) => {
    await debugLog("Manual restart triggered.");
    process.exit(0); // Railway will restart the container cleanly
});

// =========================
// BROWSER LOGIC
// =========================
async function runFlow() {
    try {
        await debugLog("Attempting to launch browser...");
        
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
            // No hardcoded executablePath! nixpacks handles this.
        });

        await debugLog("✅ Browser Launched!");

        for (const id of Object.keys(users)) {
            userPages[id] = await browser.newPage();
            await userPages[id].setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        }

        while (true) {
            for (const id of Object.keys(userPages)) {
                try {
                    const page = userPages[id];
                    await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });
                    
                    const cal = await page.$('#CalendarId');
                    if (cal) {
                        const val = await page.evaluate((s) => {
                            const o = [...document.querySelector('#CalendarId').options].find(opt => opt.text.includes(s));
                            return o ? o.value : null;
                        }, CALENDAR_SEARCH);

                        if (val) {
                            await debugLog(`🎯 Found slot for ${id}`);
                            // ... insert your clicking and form filling logic here ...
                        }
                    }
                } catch (e) { console.log(`Tab error: ${e.message}`); }
            }
            await delay(CHECK_INTERVAL);
        }
    } catch (err) {
        await debugLog(`FATAL ERROR: ${err.message}. Waiting 60s before restart.`);
        if (browser) await browser.close().catch(() => {});
        await delay(60000); // CRITICAL: This prevents the 409 Loop
        runFlow();
    }
}

runFlow();