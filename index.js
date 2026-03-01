const puppeteer = require('puppeteer');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// =========================
// CONFIG & STATE
// =========================
const telegramToken = '7044372335:AAFh0yuQBNiAUYY80WDIZ1MihjzWLgLanJk';
const TARGET_URL = 'https://appointment.bmeia.gv.at/?Office=Bangkok';
const CALENDAR_SEARCH = 'Beg'; 
const CHECK_INTERVAL = 20000; 

const isRailway = process.env.RAILWAY_ENVIRONMENT || process.env.PORT;
const usersPath = path.join(__dirname, 'users.json');

let users = {};
if (fs.existsSync(usersPath)) {
    try { users = JSON.parse(fs.readFileSync(usersPath)); } catch (e) { users = {}; }
}

let currentPage = null; 
let isWaitingForCaptcha = false;

const bot = new TelegramBot(telegramToken, { polling: { params: { drop_pending_updates: true } } });
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
// FORM FILLER (Robust Version)
// =========================
async function fillFormForUser(page, data) {
    await superLog(`📝 Filling/Re-filling form for ${data.firstName}...`);
    await page.evaluate((d) => {
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

        setV('#Lastname', d.lastName);
        setV('#Firstname', d.firstName);
        setV('#LastnameAtBirth', d.lastNameAtBirth || d.lastName);
        setV('#DateOfBirth', d.dob);
        setV('#PlaceOfBirth', d.placeOfBirth);
        setV('#Postcode', d.postcode);
        setV('#City', d.city);
        setV('#Street', d.street);
        setV('#Telephone', d.telephone);
        setV('#Email', d.email);
        setV('#TraveldocumentNumber', d.passportNumber);
        setV('#TraveldocumentDateOfIssue', d.passportIssueDate);
        setV('#TraveldocumentValidUntil', d.passportValidUntil);

        sel('#CountryOfBirth', d.countryOfBirth); 
        sel('#Sex', d.sex); 
        sel('#Country', d.country);
        sel('#TraveldocumentIssuingAuthority', d.passportAuthority);
        sel('#NationalityAtBirth', d.nationalityAtBirth); 
        sel('#NationalityForApplication', d.actualNationality || d.nationalityAtBirth); 

        const cb = document.querySelector('input[name="DSGVOAccepted"]');
        if (cb) { cb.checked = true; cb.dispatchEvent(new Event('change', {bubbles:true})); }
    }, data);
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
                currentPage.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {})
            ]);

            // CHECK FOR ERRORS
            const errorBox = await currentPage.$('.validation-summary-errors, .alert-danger');
            const hasCaptcha = await currentPage.$(inputSelector);

            if (hasCaptcha && errorBox) {
                const errorMsg = await currentPage.evaluate(el => el.innerText, errorBox);
                await superLog(`⚠️ ERROR FOUND: ${errorMsg.split('\n')[0]}`);
                
                // RE-FILL IMMEDIATELY
                const userId = Object.keys(users)[0];
                await fillFormForUser(currentPage, users[userId]);
                
                const screenshotPath = path.join(__dirname, 'retry.png');
                await currentPage.screenshot({ path: screenshotPath, fullPage: true });
                await bot.sendPhoto(msg.chat.id, screenshotPath, { 
                    caption: "🚨 SITE REJECTED INPUT. I have re-filled the form. Reply to THIS photo with the NEW CAPTCHA." 
                });
            } else if (!hasCaptcha) {
                await superLog("✅ SUCCESS! Past the CAPTCHA page.");
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
        await superLog(`🚀 Starting Flow (Mode: ${isRailway ? 'Railway' : 'Local'})`);

        let chromePath = isRailway ? (fs.existsSync('/usr/bin/google-chrome-stable') ? '/usr/bin/google-chrome-stable' : '/usr/bin/google-chrome') : null;

        browser = await puppeteer.launch({
            headless: isRailway ? "new" : false,
            executablePath: chromePath,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        });

        currentPage = await browser.newPage();
        await currentPage.setViewport({ width: 1280, height: 1200 });
        await currentPage.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });

        await currentPage.waitForSelector('#CalendarId');
        const masterValue = await currentPage.evaluate((search) => {
            const opt = [...document.querySelector('#CalendarId').options].find(o => o.text.includes(search));
            return opt ? opt.value : null;
        }, CALENDAR_SEARCH);

        if (masterValue) await currentPage.select('#CalendarId', masterValue);

        for (let i = 1; i <= 3; i++) {
            const sel = 'input[type="submit"][value="Next"], input[type="submit"][value="التالى"]';
            await currentPage.waitForSelector(sel);
            await Promise.all([currentPage.waitForNavigation({ waitUntil: 'networkidle2' }), currentPage.click(sel)]);
        }

        const radios = await currentPage.$$('input[type="radio"]');
        if (radios.length > 0) {
            await superLog(`✨ SLOT FOUND! Selecting...`);
            await radios[0].click();
            await delay(500);
            
            const nextSel = 'input[type="submit"][value="Next"], input[type="submit"][value="التالى"]';
            await Promise.all([currentPage.waitForNavigation({ waitUntil: 'networkidle2' }), currentPage.click(nextSel)]);

            const userId = Object.keys(users)[0];
            if (userId) {
                await fillFormForUser(currentPage, users[userId]);
                
                const screenshotPath = path.join(__dirname, 'form.png');
                await currentPage.screenshot({ path: screenshotPath, fullPage: true });
                await bot.sendPhoto(userId, screenshotPath, { caption: "🚨 FORM FILLED! Reply to this photo with the CAPTCHA." });
                
                isWaitingForCaptcha = true;
                while (isWaitingForCaptcha) { await delay(5000); }
                
                // Final Check
                await superLog("🏁 Flow released. Current URL: " + currentPage.url());
                const finalSnap = path.join(__dirname, 'final.png');
                await currentPage.screenshot({ path: finalSnap, fullPage: true });
                await bot.sendPhoto(userId, finalSnap, { caption: "✅ Final Status Screenshot." });
                
                await delay(60000); // Wait 1 min for you to see it
                await browser.close();
            }
        } else {
            await superLog('😴 No slots. Cooling down...');
            await browser.close();
            await delay(CHECK_INTERVAL);
            return runFlow();
        }

    } catch (err) {
        await superLog(`🚨 ERROR: ${err.message}`);
        if (browser) await browser.close().catch(() => {});
        await delay(30000); 
        runFlow();
    }
}

runFlow();