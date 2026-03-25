const puppeteer = require('puppeteer');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// =========================
// CONFIG & STATE
// =========================
const telegramToken = process.env.TELEGRAM_TOKEN || '7044372335:AAFh0yuQBNiAUYY80WDIZ1MihjzWLgLanJk';
const TARGET_URL = 'https://appointment.bmeia.gv.at/?Office=Bangkok';
const CALENDAR_SEARCH = 'Beg'; 
const CHECK_INTERVAL = 30000; // Increased slightly for stability

const usersPath = path.join(__dirname, 'users.json');

let users = {};
if (fs.existsSync(usersPath)) {
    try { users = JSON.parse(fs.readFileSync(usersPath)); } catch (e) { users = {}; }
}

let currentPage = null; 
let isWaitingForCaptcha = false;

// Polling with conflict protection
const bot = new TelegramBot(telegramToken, { 
    polling: { params: { drop_pending_updates: true } } 
});

const delay = ms => new Promise(res => setTimeout(res, ms));

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
// FORM FILLER
// =========================
async function fillFormForUser(page, d) {
    await superLog(`📝 Filling form for ${d.firstName}...`);
    await page.evaluate((data) => {
        const setV = (s, v) => { 
            const e = document.querySelector(s); 
            if(e && v) { e.value = v; e.dispatchEvent(new Event('input', {bubbles:true})); e.dispatchEvent(new Event('change', {bubbles:true})); } 
        };
        const sel = (s, t) => {
            const el = document.querySelector(s);
            if (!el || !t) return;
            const opt = [...el.options].find(o => o.text.toLowerCase().includes(t.toLowerCase()));
            if (opt) { el.value = opt.value; el.dispatchEvent(new Event('change', {bubbles:true})); }
        };

        setV('#Lastname', data.lastName);
        setV('#Firstname', data.firstName);
        setV('#LastnameAtBirth', data.lastNameAtBirth || data.lastName);
        setV('#DateOfBirth', data.dob);
        setV('#PlaceOfBirth', data.placeOfBirth);
        setV('#Postcode', data.postcode);
        setV('#City', data.city);
        setV('#Street', data.street);
        setV('#Telephone', data.telephone);
        setV('#Email', data.email);
        setV('#TraveldocumentNumber', data.passportNumber);
        setV('#TraveldocumentDateOfIssue', data.passportIssueDate);
        setV('#TraveldocumentValidUntil', data.passportValidUntil);

        sel('#CountryOfBirth', data.countryOfBirth); 
        sel('#Sex', data.sex); 
        sel('#Country', data.country);
        sel('#TraveldocumentIssuingAuthority', data.passportAuthority);
        sel('#NationalityAtBirth', data.nationalityAtBirth); 
        sel('#NationalityForApplication', data.actualNationality || data.nationalityAtBirth); 

        const cb = document.querySelector('input[name="DSGVOAccepted"]');
        if (cb) { cb.checked = true; cb.dispatchEvent(new Event('change', {bubbles:true})); }
    }, d);
}

// =========================
// TELEGRAM REPLY LISTENER
// =========================
bot.on('message', async (msg) => {
    const text = msg.text;
    if (!text || !currentPage || !isWaitingForCaptcha) return;

    if (msg.reply_to_message && msg.reply_to_message.caption && msg.reply_to_message.caption.includes("CAPTCHA")) {
        try {
            const inputSelector = '#CaptchaText'; 
            const submitSelector = 'input[type="submit"][value="Next"], input[type="submit"][value="التالى"]';

            await superLog(`⌨️ Typing CAPTCHA: ${text}...`);
            await currentPage.click(inputSelector, { clickCount: 3 });
            await currentPage.keyboard.press('Backspace');

            for (const char of text) {
                await currentPage.type(inputSelector, char.toUpperCase(), { delay: 30 });
            }
            
            await superLog("🖱 Submitting...");
            await Promise.all([
                currentPage.click(submitSelector),
                currentPage.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {})
            ]);

            const hasCaptcha = await currentPage.$(inputSelector);

            if (hasCaptcha) {
                await superLog(`⚠️ Error detected. Re-filling form...`);
                const userId = Object.keys(users)[0];
                await fillFormForUser(currentPage, users[userId]);
                
                const screenshotPath = path.join(__dirname, 'retry.png');
                await currentPage.screenshot({ path: screenshotPath, fullPage: true });
                await bot.sendPhoto(msg.chat.id, screenshotPath, { 
                    caption: "🚨 ERROR! Fields re-filled. Reply with the NEW CAPTCHA." 
                });
            } else {
                await superLog("✅ SUCCESS! Form submitted.");
                isWaitingForCaptcha = false;
            }
        } catch (e) {
            await superLog(`❌ Reply Error: ${e.message}`);
        }
    }
});

// =========================
// MAIN RUNNER
// =========================
async function runFlow() {
    let browser;
    try {
        await superLog(`🚀 Starting session...`);

        browser = await puppeteer.launch({
            headless: "new",
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage', 
                '--disable-gpu',
                '--single-process',
                '--no-zygote'
            ]
        });

        currentPage = await browser.newPage();
        // Crucial for bypassing some basic bot filters
        await currentPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');
        await currentPage.setViewport({ width: 1280, height: 1200 });

        await currentPage.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 90000 });

        await currentPage.waitForSelector('#CalendarId', { timeout: 30000 });
        const masterValue = await currentPage.evaluate((search) => {
            const opt = [...document.querySelector('#CalendarId').options].find(o => o.text.includes(search));
            return opt ? opt.value : null;
        }, CALENDAR_SEARCH);

        if (masterValue) await currentPage.select('#CalendarId', masterValue);

        for (let i = 1; i <= 3; i++) {
            const sel = 'input[type="submit"][value="Next"], input[type="submit"][value="التالى"]';
            await currentPage.waitForSelector(sel, { timeout: 20000 });
            await Promise.all([
                currentPage.waitForNavigation({ waitUntil: 'networkidle2' }), 
                currentPage.click(sel)
            ]);
        }

        const radios = await currentPage.$$('input[type="radio"]');
        if (radios.length > 0) {
            await superLog(`✨ SLOT FOUND!`);
            await radios[0].click();
            await delay(500);
            
            const nextSel = 'input[type="submit"][value="Next"], input[type="submit"][value="التالى"]';
            await Promise.all([
                currentPage.waitForNavigation({ waitUntil: 'networkidle2' }), 
                currentPage.click(nextSel)
            ]);

            const userId = Object.keys(users)[0];
            if (userId) {
                await fillFormForUser(currentPage, users[userId]);
                
                const screenshotPath = path.join(__dirname, 'form.png');
                await currentPage.screenshot({ path: screenshotPath, fullPage: true });
                await bot.sendPhoto(userId, screenshotPath, { caption: "🚨 FORM FILLED! Reply with CAPTCHA." });
                
                isWaitingForCaptcha = true;
                // Keep the browser open while waiting for the human to reply via Telegram
                const startTime = Date.now();
                while (isWaitingForCaptcha && (Date.now() - startTime < 300000)) { 
                    await delay(5000); 
                }
                
                await superLog("🏁 Session finished.");
            }
        } else {
            await superLog('😴 No slots.');
        }

    } catch (err) {
        await superLog(`🚨 ERROR: ${err.message}`);
    } finally {
        if (browser) await browser.close().catch(() => {});
        currentPage = null;
    }
}

// Master loop to prevent stack overflow/recursion issues
async function main() {
    await superLog("🤖 Bot Started on Railway");
    while (true) {
        if (!isWaitingForCaptcha) {
            await runFlow();
        }
        await delay(CHECK_INTERVAL);
    }
}

main();