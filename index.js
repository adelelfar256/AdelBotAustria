const puppeteer = require('puppeteer');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// =========================
// CONFIG
// =========================
const telegramToken = '7044372335:AAEXrhJfADVi4nme9oo8ktJcb_6Yqeltp7E';
const TARGET_URL = 'https://appointment.bmeia.gv.at/?Office=Bangkok';
const CALENDAR_SEARCH = 'Beg'; 
const CHECK_INTERVAL = 6000; 

// Detection for Railway Environment
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

if (fs.existsSync(usersPath)) {
    try { users = JSON.parse(fs.readFileSync(usersPath)); } catch (e) { users = {}; }
}

const bot = new TelegramBot(telegramToken, { polling: true });
const delay = ms => new Promise(res => setTimeout(res, ms));

// =========================
// COMMANDS
// =========================
bot.onText(/\/help/, (msg) => {
    const helpText = "📖 *Bot Guide:*\n\n" +
        "/update - Add/Change your data step-by-step\n" +
        "/restart - Force restart the browser tabs\n" +
        "/status - See which users are currently searching\n" +
        "Reply to a form photo with the CAPTCHA to submit.";
    bot.sendMessage(msg.chat.id, helpText, { parse_mode: 'Markdown' });
});

bot.onText(/\/status/, (msg) => {
    const active = Object.keys(userPages).join('\n') || 'None';
    bot.sendMessage(msg.chat.id, `📊 *Active Tabs:*\n${active}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/restart/, async (msg) => {
    bot.sendMessage(msg.chat.id, "🔄 Restarting browser engine...");
    if (browser) await browser.close();
    userPages = {};
    runFlow();
});

// =========================
// TELEGRAM MESSAGE HANDLER
// =========================
bot.on('message', async (msg) => {
    const text = msg.text;
    const chatId = msg.chat.id.toString();
    if (!text || text.startsWith('/')) return;

    // 1. Data Setup Interview
    if (setupState.active && setupState.chatId === chatId) {
        setupState.data[QUESTIONS[setupState.step].key] = text;
        setupState.step++;
        if (setupState.step < QUESTIONS.length) {
            const next = QUESTIONS[setupState.step];
            return bot.sendMessage(chatId, `${setupState.step + 1}. ${next.label} ${next.hint || ''}?`);
        } else {
            users[chatId] = setupState.data;
            fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));
            setupState.active = false;
            return bot.sendMessage(chatId, "✅ Data saved! Send /restart to start your search.");
        }
    }

    // 2. CAPTCHA Processing
    if (msg.reply_to_message && msg.reply_to_message.caption && msg.reply_to_message.caption.includes("FORM")) {
        const page = userPages[chatId];
        if (!page) return bot.sendMessage(chatId, "❌ No active tab found. Try /restart.");

        try {
            const input = '#CaptchaText';
            const btn = 'input[type="submit"][value="Next"], input[type="submit"][value="التالى"]';

            await page.bringToFront();
            await page.click(input, { clickCount: 3 });
            await page.keyboard.press('Backspace');
            for (const c of text) await page.type(input, c.toUpperCase(), { delay: 40 });
            
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {}),
                page.click(btn)
            ]);

            const err = await page.evaluate(() => {
                const el = document.querySelector('.validation-summary-errors');
                return el ? el.innerText.trim() : null;
            });

            if (err) {
                const p = path.join(__dirname, `err_${chatId}.png`);
                await page.screenshot({ path: p });
                await bot.sendPhoto(chatId, p, { caption: `❌ Error:\n${err}\n\nType new code.` });
            } else {
                await bot.sendMessage(chatId, "🚀 Submitted! Check email for confirmation.");
            }
        } catch (e) { bot.sendMessage(chatId, "⚠️ Browser Error. Try /restart."); }
    }
});

bot.onText(/\/update/, (msg) => {
    setupState = { active: true, step: 0, data: {}, chatId: msg.chat.id.toString() };
    bot.sendMessage(msg.chat.id, `📝 Setup Started.\n\n1. ${QUESTIONS[0].label}?`);
});

// =========================
// BROWSER HELPERS
// =========================
async function fillFormForUser(page, data) {
    await page.evaluate((d) => {
        const f = (s, v) => {
            const e = document.querySelector(s);
            if (e && v) { e.value = v; ['input','change','blur'].forEach(ev => e.dispatchEvent(new Event(ev,{bubbles:true}))); }
        };
        const s = (sel, t) => {
            const e = document.querySelector(sel);
            if (!e || !t) return;
            const o = [...e.options].find(opt => opt.text.toLowerCase().includes(t.toLowerCase().trim()));
            if (o) { e.value = o.value; e.dispatchEvent(new Event('change',{bubbles:true})); }
        };
        f('#Lastname', d.lastName); f('#Firstname', d.firstName); f('#LastnameAtBirth', d.lastNameAtBirth);
        f('#DateOfBirth', d.dob); f('#PlaceOfBirth', d.placeOfBirth); f('#Postcode', d.postcode);
        f('#City', d.city); f('#Street', d.street); f('#Telephone', d.telephone); f('#Email', d.email);
        f('#TraveldocumentNumber', d.passportNumber); f('#TraveldocumentDateOfIssue', d.passportIssueDate);
        f('#TraveldocumentValidUntil', d.passportValidUntil); s('#CountryOfBirth', d.countryOfBirth);
        s('#Sex', d.sex); s('#Country', d.country); s('#TraveldocumentIssuingAuthority', d.passportAuthority);
        s('#NationalityAtBirth', d.nationalityAtBirth); s('#NationalityForApplication', d.actualNationality);
        const c = document.querySelector('input[name="DSGVOAccepted"]'); if(c) { c.checked = true; c.dispatchEvent(new Event('change')); }
    }, data);
}

async function runFlow() {
    try {
        browser = await puppeteer.launch({
            headless: isRailway ? true : false,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
            executablePath: isRailway ? '/usr/bin/google-chrome' : null
        });

        for (const id of Object.keys(users)) {
            userPages[id] = await browser.newPage();
            await userPages[id].setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        }

        while (true) {
            for (const id of Object.keys(userPages)) {
                const page = userPages[id];
                try {
                    await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
                    const cal = await page.$('#CalendarId');
                    if (cal) {
                        const val = await page.evaluate((s) => {
                            const o = [...document.querySelector('#CalendarId').options].find(opt => opt.text.includes(s));
                            return o ? o.value : null;
                        }, CALENDAR_SEARCH);
                        
                        if (val) {
                            await page.select('#CalendarId', val);
                            for (let i = 0; i < 3; i++) {
                                const btn = 'input[type="submit"][value="Next"], input[type="submit"][value="التالى"]';
                                await page.waitForSelector(btn);
                                await Promise.all([page.waitForNavigation().catch(() => {}), page.click(btn)]);
                            }

                            const r = await page.$$('input[type="radio"]');
                            if (r.length > 0) {
                                await r[0].click();
                                const btn = 'input[type="submit"][value="Next"], input[type="submit"][value="التالى"]';
                                await Promise.all([page.waitForNavigation().catch(() => {}), page.click(btn)]);
                                
                                await fillFormForUser(page, users[id]);
                                const img = path.join(__dirname, `ready_${id}.png`);
                                await page.screenshot({ path: img, fullPage: true });
                                await bot.sendPhoto(id, img, { caption: "🚨 SLOT FOUND! Reply with CAPTCHA." });
                                await delay(120000); 
                            }
                        }
                    }
                } catch (e) { console.log(`Error in tab ${id}`); }
            }
            await delay(CHECK_INTERVAL);
        }
    } catch (err) {
        if (browser) await browser.close();
        await delay(CHECK_INTERVAL);
        runFlow();
    }
}

runFlow();