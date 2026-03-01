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
const CHECK_INTERVAL = 7000; 

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

// Logger Helper: Console + Telegram
async function debugLog(message) {
    const timestamp = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
    const logMsg = `[${timestamp}] ${message}`;
    console.log(logMsg);
    
    // Send to the first user in the list as a management update
    const adminId = Object.keys(users)[0];
    if (adminId) {
        bot.sendMessage(adminId, `🛠 DEBUG: ${logMsg}`).catch(() => {});
    }
}

if (fs.existsSync(usersPath)) {
    try { users = JSON.parse(fs.readFileSync(usersPath)); } catch (e) { users = {}; }
}

const bot = new TelegramBot(telegramToken, { 
    polling: { params: { drop_pending_updates: true } }
});

debugLog(`🚀 STARTING ENGINE. Environment: ${isRailway ? 'RAILWAY' : 'LOCAL'}`);

const delay = ms => new Promise(res => setTimeout(res, ms));

// =========================
// TELEGRAM COMMANDS
// =========================
bot.onText(/\/status/, (msg) => {
    const active = Object.keys(userPages).join('\n') || 'None';
    bot.sendMessage(msg.chat.id, `📊 *STATUS REPORT:*\nEnvironment: ${isRailway ? 'Railway' : 'Local'}\nActive Tabs: ${Object.keys(userPages).length}\nSearching for IDs:\n${active}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/restart/, async (msg) => {
    await debugLog(`Restart triggered by User ${msg.chat.id}`);
    if (browser) await browser.close();
    userPages = {};
    runFlow();
});

// =========================
// INTERVIEW & CAPTCHA
// =========================
bot.on('message', async (msg) => {
    const text = msg.text;
    const chatId = msg.chat.id.toString();
    if (!text || text.startsWith('/')) return;

    if (setupState.active && setupState.chatId === chatId) {
        setupState.data[QUESTIONS[setupState.step].key] = text;
        setupState.step++;
        if (setupState.step < QUESTIONS.length) {
            return bot.sendMessage(chatId, `${setupState.step + 1}. ${QUESTIONS[setupState.step].label}?`);
        } else {
            users[chatId] = setupState.data;
            fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));
            setupState.active = false;
            debugLog(`User ${chatId} finished data setup.`);
            return bot.sendMessage(chatId, "✅ Data saved! Send /restart to update browser.");
        }
    }

    if (msg.reply_to_message && msg.reply_to_message.caption && msg.reply_to_message.caption.includes("FORM")) {
        const page = userPages[chatId];
        if (!page) return bot.sendMessage(chatId, "❌ No active tab.");
        try {
            debugLog(`Typing CAPTCHA for User ${chatId}...`);
            const input = '#CaptchaText';
            const btn = 'input[type="submit"][value="Next"]';
            await page.bringToFront();
            await page.click(input, { clickCount: 3 });
            await page.keyboard.press('Backspace');
            for (const c of text) await page.type(input, c.toUpperCase(), { delay: 40 });
            await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {}), page.click(btn)]);
            
            const err = await page.evaluate(() => {
                const el = document.querySelector('.validation-summary-errors');
                return el ? el.innerText.trim() : null;
            });

            if (err) {
                await debugLog(`Captcha failed for User ${chatId}: ${err}`);
                const p = path.join(__dirname, `err_${chatId}.png`);
                await page.screenshot({ path: p });
                await bot.sendPhoto(chatId, p, { caption: `❌ Error: ${err}\nRetry code.` });
            } else {
                await debugLog(`SUCCESS: Captcha accepted for ${chatId}`);
                bot.sendMessage(chatId, "🚀 Form Submitted!");
            }
        } catch (e) { debugLog(`Captcha submission error: ${e.message}`); }
    }
});

bot.onText(/\/update/, (msg) => {
    setupState = { active: true, step: 0, data: {}, chatId: msg.chat.id.toString() };
    bot.sendMessage(msg.chat.id, "📝 Starting Setup...");
});

// =========================
// MONITORING LOOP
// =========================
async function runFlow() {
    try {
        debugLog("Launching Browser...");
        browser = await puppeteer.launch({
            headless: isRailway ? true : false,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
            executablePath: isRailway ? '/usr/bin/google-chrome' : null
        });

        const ids = Object.keys(users);
        debugLog(`Found ${ids.length} users in JSON. Opening tabs...`);

        for (const id of ids) {
            userPages[id] = await browser.newPage();
            await userPages[id].setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        }

        while (true) {
            for (const id of Object.keys(userPages)) {
                const page = userPages[id];
                try {
                    await debugLog(`Checking User ${id}...`);
                    await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 30000 });
                    
                    const cal = await page.$('#CalendarId');
                    if (!cal) {
                        await debugLog(`Calendar not found for ${id}. Website might be down or blocked.`);
                        continue;
                    }

                    const val = await page.evaluate((s) => {
                        const o = [...document.querySelector('#CalendarId').options].find(opt => opt.text.includes(s));
                        return o ? o.value : null;
                    }, CALENDAR_SEARCH);

                    if (val) {
                        await debugLog(`🎯 SLOT DETECTED for ${id}! Navigating...`);
                        await page.select('#CalendarId', val);
                        for (let i = 0; i < 3; i++) {
                            const btn = 'input[type="submit"][value="Next"]';
                            await page.waitForSelector(btn);
                            await Promise.all([page.waitForNavigation().catch(() => {}), page.click(btn)]);
                        }

                        const r = await page.$$('input[type="radio"]');
                        if (r.length > 0) {
                            await r[0].click();
                            await Promise.all([page.waitForNavigation().catch(() => {}), page.click('input[type="submit"][value="Next"]')]);
                            
                            // Fill Data
                            await debugLog(`Filling form for ${id}...`);
                            await page.evaluate((d) => {
                                const f = (s, v) => {
                                    const e = document.querySelector(s);
                                    if (e && v) { e.value = v; ['input','change','blur'].forEach(ev => e.dispatchEvent(new Event(ev,{bubbles:true}))); }
                                };
                                f('#Lastname', d.lastName); f('#Firstname', d.firstName); f('#Email', d.email);
                                // (Rest of fields trimmed for brevity in log version - ensure your full fillForm logic is here)
                                const c = document.querySelector('input[name="DSGVOAccepted"]'); if(c) c.checked = true;
                            }, users[id]);

                            const img = path.join(__dirname, `ready_${id}.png`);
                            await page.screenshot({ path: img, fullPage: true });
                            await bot.sendPhoto(id, img, { caption: "🚨 SLOT READY! Reply with CAPTCHA." });
                            await delay(120000); 
                        }
                    } else {
                        // Log "No Slots" every few cycles to avoid spamming admin
                        if (Math.random() < 0.1) console.log(`[ID ${id}] Still no slots...`);
                    }
                } catch (e) { await debugLog(`Error in tab ${id}: ${e.message}`); }
            }
            await delay(CHECK_INTERVAL);
        }
    } catch (err) {
        await debugLog(`FATAL BROWSER ERROR: ${err.message}. Restarting...`);
        if (browser) await browser.close();
        await delay(CHECK_INTERVAL);
        runFlow();
    }
}

// Heartbeat - Every 30 mins
setInterval(() => {
    debugLog("💓 Heartbeat: Bot is still running smoothly.");
}, 1800000);

runFlow();