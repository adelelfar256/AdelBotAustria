const puppeteer = require('puppeteer');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const os = require('os');

// =========================
// CONFIG & STATE
// =========================
const telegramToken = process.env.TELEGRAM_TOKEN || '7044372335:AAFh0yuQBNiAUYY80WDIZ1MihjzWLgLanJk';
const TARGET_URL = 'https://appointment.bmeia.gv.at/?Office=Bangkok';
const CALENDAR_SEARCH = 'Beg'; 
const CHECK_INTERVAL = 45000; 

const isRailway = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_STATIC_URL || process.env.PORT);
const usersPath = path.join(__dirname, 'users.json');

let users = {};
if (fs.existsSync(usersPath)) {
    try { users = JSON.parse(fs.readFileSync(usersPath)); } catch (e) { users = {}; }
}

let currentPage = null; 
let isWaitingForCaptcha = false;

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

async function sendErrorScreenshot(page, stepName) {
    try {
        const screenshotPath = path.join(__dirname, `error_${stepName}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        const adminId = Object.keys(users)[0];
        if (adminId) {
            await bot.sendPhoto(adminId, screenshotPath, { caption: `❌ Error at ${stepName}` });
        }
    } catch (e) {
        console.error("Could not take error screenshot", e.message);
    }
}

// =========================
// FORM FILLER
// =========================
async function fillFormForUser(page, d) {
    await superLog(`📝 [STEP 8] Filling form for ${d.firstName}...`);
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

            await superLog(`⌨️ [CAPTCHA] Typing: ${text}...`);
            await currentPage.click(inputSelector, { clickCount: 3 });
            await currentPage.keyboard.press('Backspace');

            for (const char of text) {
                await currentPage.type(inputSelector, char.toUpperCase(), { delay: 60 });
            }
            
            await superLog("🖱 [CAPTCHA] Submitting...");
            await Promise.all([
                currentPage.click(submitSelector),
                currentPage.waitForNavigation({ waitUntil: 'networkidle2', timeout: 35000 }).catch(() => {})
            ]);

            const hasCaptcha = await currentPage.$(inputSelector);
            if (hasCaptcha) {
                await superLog(`⚠️ [CAPTCHA] Wrong code.`);
                const screenshotPath = path.join(__dirname, 'retry.png');
                await currentPage.screenshot({ path: screenshotPath, fullPage: true });
                await bot.sendPhoto(msg.chat.id, screenshotPath, { caption: "🚨 WRONG CAPTCHA. Reply to this NEW image." });
            } else {
                await superLog("✅ [SUCCESS] Form submitted!");
                isWaitingForCaptcha = false;
            }
        } catch (e) {
            await superLog(`❌ [REPLY ERROR] ${e.message}`);
        }
    }
});

// =========================
// MAIN RUNNER
// =========================
async function runFlow() {
    let browser;
    try {
        // --- STEP 1: Launch ---
        let chromePath = undefined; 
        if (isRailway) {
            // Check multiple common Linux paths for Chrome
            const possiblePaths = [
                process.env.PUPPETEER_EXECUTABLE_PATH,
                '/usr/bin/google-chrome-stable',
                '/usr/bin/google-chrome',
                '/nix/var/nix/profiles/default/bin/google-chrome'
            ];
            for (const p of possiblePaths) {
                if (p && fs.existsSync(p)) { chromePath = p; break; }
            }
            await superLog(`🔍 [STEP 1] Using Chrome Path: ${chromePath || 'AUTO'}`);
        }

        browser = await puppeteer.launch({
            headless: isRailway ? "new" : false, 
            executablePath: chromePath,
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-zygote',
                ...(isRailway ? ['--single-process', '--js-flags="--max-old-space-size=256"'] : [])
            ]
        });

        // --- STEP 2: Page Setup ---
        await superLog(`📄 [STEP 2] Page Init...`);
        currentPage = await browser.newPage();
        await currentPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        await currentPage.setViewport({ width: 1280, height: 1200 });

        // --- STEP 3: Navigation ---
        await superLog(`🌐 [STEP 3] Navigating to BMEIA...`);
        await currentPage.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 90000 });

        // --- STEP 4: Calendar ---
        await superLog(`📅 [STEP 4] Calendar Selection...`);
        await currentPage.waitForSelector('#CalendarId', { timeout: 30000 });
        const masterValue = await currentPage.evaluate((search) => {
            const el = document.querySelector('#CalendarId');
            const opt = [...el.options].find(o => o.text.includes(search));
            return opt ? opt.value : null;
        }, CALENDAR_SEARCH);

        if (masterValue) {
            await currentPage.select('#CalendarId', masterValue);
            await delay(1000);
        }

        // --- STEP 5: Page Crawling ---
        for (let i = 1; i <= 3; i++) {
            const sel = 'input[type="submit"][value="Next"], input[type="submit"][value="التالى"]';
            await superLog(`🖱 [STEP 5] Clicking 'Next' (${i}/3)...`);
            await currentPage.waitForSelector(sel, { timeout: 20000 });
            await delay(2000); 
            
            try {
                await Promise.all([
                    currentPage.waitForNavigation({ waitUntil: 'networkidle2', timeout: 35000 }),
                    currentPage.click(sel)
                ]);
            } catch (navErr) {
                const stillOnOldPage = await currentPage.$(sel);
                if (stillOnOldPage) {
                    await sendErrorScreenshot(currentPage, `Click_Failed_${i}`);
                    throw new Error(`Detached at Next ${i}`);
                }
            }
        }

        // --- STEP 6: Slot Check ---
        await superLog(`🔍 [STEP 6] Checking for radio buttons...`);
        const pageText = await currentPage.evaluate(() => document.body.innerText);
        const hasNoApptMsg = pageText.includes("no appointments available") || pageText.includes("لا توجد مواعيد متاحة");
        const radios = await currentPage.$$('input[type="radio"]');

        if (radios.length > 0 && !hasNoApptMsg) {
            await superLog(`✨ [STEP 7] REAL SLOT FOUND!`);
            await radios[0].click();
            await delay(1000);
            
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
                await bot.sendPhoto(userId, screenshotPath, { caption: "🚨 SLOT! Reply with CAPTCHA." });
                
                isWaitingForCaptcha = true;
                const timeoutLimit = Date.now() + 300000; 
                while (isWaitingForCaptcha && Date.now() < timeoutLimit) { await delay(5000); }
                isWaitingForCaptcha = false;
            }
        } else {
            const reason = hasNoApptMsg ? "Page says 'No available'" : "No radio buttons";
            await superLog(`😴 [RESULT] No slots. (${reason})`);
        }

    } catch (err) {
        await superLog(`❌ [FATAL ERROR]: ${err.message}`);
        if (currentPage) await sendErrorScreenshot(currentPage, "Fatal_Crash");
    } finally {
        if (browser) {
            await superLog(`🧹 [CLEANUP] Closing browser...`);
            await browser.close().catch(() => {});
        }
        currentPage = null;
    }
}

async function main() {
    await superLog(`🤖 Bot Started (${isRailway ? 'RAILWAY' : 'LOCAL'})`);
    while (true) {
        if (!isWaitingForCaptcha) {
            await runFlow();
        }
        await delay(CHECK_INTERVAL);
    }
}

main();