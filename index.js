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
const CHECK_INTERVAL = 15000; 

const isRailway = process.env.RAILWAY_ENVIRONMENT || process.env.PORT;
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

// Helper: Logs to Terminal AND Telegram
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
                await superLog(`⌨️ Typing CAPTCHA: ${text}...`);
                await currentPage.click(inputSelector);
                await currentPage.click(inputSelector, { clickCount: 3 });
                await currentPage.keyboard.press('Backspace');

                for (const char of text) {
                    await currentPage.type(inputSelector, char.toUpperCase(), { delay: 40 });
                }
                
                await delay(500); 
                await superLog("🖱 Auto-clicking Next button...");
                await currentPage.click(submitSelector);
                isWaitingForCaptcha = false; // Release the flow
            }
        } catch (e) {
            await superLog(`❌ Error in auto-submit: ${e.message}`);
        }
    }
});

// =========================
// BROWSER UTILITIES
// =========================
async function waitAndClickNext(page, stepName) {
    const selector = 'input[type="submit"][value="Next"], input[type="submit"][value="التالى"]';
    try {
        await page.waitForSelector(selector, { visible: true, timeout: 15000 });
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
            page.click(selector)
        ]);
        await superLog(`✅ Step ${stepName} completed.`);
        return true;
    } catch (e) {
        await superLog(`❌ Step ${stepName} failed.`);
        return false;
    }
}

async function fillFormForUser(page, userData) {
    await superLog(`📝 Filling form for ${userData.firstName}...`);
    await page.evaluate((data) => {
        const setVal = (sel, val) => {
            const el = document.querySelector(sel);
            if (el && val) {
                el.value = val;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }
        };
        setVal('#Lastname', data.lastName);
        setVal('#Firstname', data.firstName);
        setVal('#DateOfBirth', data.dob);
        setVal('#Email', data.email);
        setVal('#TraveldocumentNumber', data.passportNumber);
        const cb = document.querySelector('input[name="DSGVOAccepted"]');
        if (cb) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
    }, userData);
}

// =========================
// MAIN RUNNER
// =========================
async function runFlow() {
    let browser;
    try {
        await superLog(`🚀 Starting Flow (Mode: ${isRailway ? 'Railway' : 'Local'})`);

        // Find Chrome path on Railway
        let chromePath = null;
        if (isRailway) {
            try {
                chromePath = execSync('which google-chrome-stable || which google-chrome').toString().trim();
            } catch (e) {
                chromePath = '/usr/bin/google-chrome-stable';
            }
        }

        browser = await puppeteer.launch({
            headless: isRailway ? "new" : false, 
            executablePath: chromePath,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });

        currentPage = await browser.newPage();
        await currentPage.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });

        await currentPage.waitForSelector('#CalendarId');
        const masterValue = await currentPage.evaluate((search) => {
            const opt = [...document.querySelector('#CalendarId').options].find(o => o.text.includes(search));
            return opt ? opt.value : null;
        }, CALENDAR_SEARCH);

        if (masterValue) await currentPage.select('#CalendarId', masterValue);

        for (let i = 1; i <= 3; i++) {
            await waitAndClickNext(currentPage, i);
        }

        const radios = await currentPage.$$('input[type="radio"]');
        if (radios.length > 0) {
            await superLog(`✨ SLOT FOUND! Selecting...`);
            await radios[0].click();
            await delay(500);
            await waitAndClickNext(currentPage, "Radio Selection");

            const firstUserKey = Object.keys(users)[0];
            if (firstUserKey) {
                await fillFormForUser(currentPage, users[firstUserKey]);
                
                // Screenshot and Wait
                const screenshotPath = path.join(__dirname, 'form.png');
                await currentPage.screenshot({ path: screenshotPath, fullPage: true });
                await bot.sendPhoto(firstUserKey, screenshotPath, { caption: "🚨 FORM FILLED! Reply with CAPTCHA." });
                
                isWaitingForCaptcha = true;
                await superLog("⏳ Waiting for your Telegram reply...");
                
                // Infinite wait until CAPTCHA is handled to prevent script restart
                while (isWaitingForCaptcha) {
                    await delay(5000);
                }
            }
        } else {
            await superLog('😴 No slots. Retrying...');
            await browser.close();
            await delay(CHECK_INTERVAL);
            return runFlow();
        }

    } catch (err) {
        await superLog(`🚨 ERROR: ${err.message}`);
        if (browser) await browser.close();
        await delay(30000); 
        runFlow();
    }
}

// 409 Conflict Protection
bot.on('polling_error', (err) => { if (!err.message.includes('409')) console.error(err); });

runFlow();