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
    users = JSON.parse(fs.readFileSync(usersPath));
}

const bot = new TelegramBot(telegramToken, { polling: true });
const delay = ms => new Promise(res => setTimeout(res, ms));

// =========================
// COMMANDS
// =========================
bot.onText(/\/help/, (msg) => {
    bot.sendMessage(msg.chat.id, "📖 *Commands:*\n/update - Set your info\n/restart - Fix/Start search\n/status - See active tabs", { parse_mode: 'Markdown' });
});

bot.onText(/\/status/, (msg) => {
    const activeIds = Object.keys(userPages).join('\n');
    bot.sendMessage(msg.chat.id, `📊 *Status:*\nActive Tabs for IDs:\n${activeIds || 'None'}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/restart/, async (msg) => {
    await bot.sendMessage(msg.chat.id, "🔄 Restarting... please wait.");
    if (browser) await browser.close();
    userPages = {}; // Clear old tab references
    runFlow();
});

// =========================
// THE TELEGRAM LISTENER (FIXED CAPTCHA)
// =========================
bot.on('message', async (msg) => {
    const text = msg.text;
    const chatId = msg.chat.id.toString();
    if (!text || text.startsWith('/')) return;

    // 1. Setup Wizard
    if (setupState.active && setupState.chatId === chatId) {
        setupState.data[QUESTIONS[setupState.step].key] = text;
        setupState.step++;
        if (setupState.step < QUESTIONS.length) {
            return bot.sendMessage(chatId, `${setupState.step + 1}. ${QUESTIONS[setupState.step].label} ${QUESTIONS[setupState.step].hint || ''}?`);
        } else {
            users[chatId] = setupState.data;
            fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));
            setupState.active = false;
            return bot.sendMessage(chatId, "✅ Data saved! Use /restart to open your personal tab.");
        }
    }

    // 2. CAPTCHA REPLY (FIXED LOGIC)
    if (msg.reply_to_message && msg.reply_to_message.caption && msg.reply_to_message.caption.includes("FORM")) {
        const myPage = userPages[chatId];
        
        if (!myPage || myPage.isClosed()) {
            return bot.sendMessage(chatId, "❌ Your browser tab is lost. Send /restart to fix it.");
        }

        try {
            console.log(`[ACTION] User ${chatId} sent CAPTCHA. Typing...`);
            const inputSelector = '#CaptchaText';
            const submitSelector = 'input[type="submit"][value="Next"], input[type="submit"][value="التالى"]';

            // Bring tab to front
            await myPage.bringToFront();
            
            // Focus and Clear
            await myPage.waitForSelector(inputSelector, { visible: true });
            await myPage.click(inputSelector, { clickCount: 3 });
            await myPage.keyboard.press('Backspace');

            // Type code
            for (const char of text) {
                await myPage.type(inputSelector, char.toUpperCase(), { delay: 50 });
            }
            
            // Auto-click Next
            await Promise.all([
                myPage.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}),
                myPage.click(submitSelector)
            ]);

            // Check for Errors
            const errorText = await myPage.evaluate(() => {
                const el = document.querySelector('.validation-summary-errors');
                return el ? el.innerText.trim() : null;
            });

            if (errorText) {
                const errImg = path.join(__dirname, `err_${chatId}.png`);
                await myPage.screenshot({ path: errImg });
                await bot.sendPhoto(chatId, errImg, { caption: `❌ REJECTED:\n${errorText}\n\nType the new code.` });
            } else {
                await bot.sendMessage(chatId, "🚀 SUCCESS! If the page changed, you are booked. Check your email.");
            }
        } catch (e) {
            console.error(e);
            bot.sendMessage(chatId, "⚠️ Browser error while typing. Try /restart.");
        }
    }
});

bot.onText(/\/update/, (msg) => {
    setupState = { active: true, step: 0, data: {}, chatId: msg.chat.id.toString() };
    bot.sendMessage(msg.chat.id, `📝 Setup Started.\n\n1. ${QUESTIONS[0].label}?`);
});

// =========================
// RE-USEABLE HELPERS
// =========================
async function fillFormForUser(page, userData) {
    await page.evaluate((data) => {
        const set = (s, v) => {
            const el = document.querySelector(s);
            if (el && v) {
                el.value = v;
                ['input', 'change', 'blur'].forEach(e => el.dispatchEvent(new Event(e, { bubbles: true })));
            }
        };
        const sel = (s, t) => {
            const el = document.querySelector(s);
            if (!el || !t) return;
            const opt = [...el.options].find(o => o.text.toLowerCase().includes(t.toLowerCase().trim()));
            if (opt) { el.value = opt.value; el.dispatchEvent(new Event('change', { bubbles: true })); }
        };

        set('#Lastname', data.lastName); set('#Firstname', data.firstName);
        set('#LastnameAtBirth', data.lastNameAtBirth); set('#DateOfBirth', data.dob);
        set('#PlaceOfBirth', data.placeOfBirth); set('#Postcode', data.postcode);
        set('#City', data.city); set('#Street', data.street);
        set('#Telephone', data.telephone); set('#Email', data.email);
        set('#TraveldocumentNumber', data.passportNumber);
        set('#TraveldocumentDateOfIssue', data.passportIssueDate);
        set('#TraveldocumentValidUntil', data.passportValidUntil);
        sel('#CountryOfBirth', data.countryOfBirth); sel('#Sex', data.sex);
        sel('#Country', data.country); sel('#TraveldocumentIssuingAuthority', data.passportAuthority);
        sel('#NationalityAtBirth', data.nationalityAtBirth); sel('#NationalityForApplication', data.actualNationality);
        const cb = document.querySelector('input[name="DSGVOAccepted"]');
        if (cb) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
    }, userData);
}

async function waitAndClickNext(page) {
    const btn = 'input[type="submit"][value="Next"], input[type="submit"][value="التالى"]';
    try {
        await page.waitForSelector(btn, { timeout: 4000 });
        await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {}), page.click(btn)]);
        return true;
    } catch { return false; }
}

// =========================
// RUNNER
// =========================
async function runFlow() {
    browser = await puppeteer.launch({ headless: false, args: ['--no-sandbox', '--start-maximized'] });
    
    // Open tabs for everyone
    for (const id of Object.keys(users)) {
        userPages[id] = await browser.newPage();
    }

    while (true) {
        for (const id of Object.keys(userPages)) {
            const page = userPages[id];
            try {
                if (page.isClosed()) continue;
                await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
                
                const cal = await page.$('#CalendarId');
                if (cal) {
                    const val = await page.evaluate((s) => {
                        const o = [...document.querySelector('#CalendarId').options].find(opt => opt.text.includes(s));
                        return o ? o.value : null;
                    }, CALENDAR_SEARCH);

                    if (val) {
                        await page.select('#CalendarId', val);
                        for (let i = 0; i < 3; i++) await waitAndClickNext(page);

                        const radios = await page.$$('input[type="radio"]');
                        if (radios.length > 0) {
                            await radios[0].click(); // First user takes first slot, etc.
                            await waitAndClickNext(page);
                            await fillFormForUser(page, users[id]);
                            
                            const imgPath = path.join(__dirname, `ready_${id}.png`);
                            await page.screenshot({ path: imgPath, fullPage: true });
                            await bot.sendPhoto(id, imgPath, { caption: "🚨 FORM FILLED! REPLY to this with CAPTCHA code." });
                            
                            await delay(120000); // Wait 2 mins for user to reply
                        }
                    }
                }
            } catch (err) { console.log(`Error in user ${id} tab.`); }
        }
        await delay(CHECK_INTERVAL);
    }
}

runFlow();