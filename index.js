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
// TELEGRAM REPLY LISTENER
// =========================
bot.on('message', async (msg) => {
    const text = msg.text;
    if (!text || !currentPage) return;

    // Check if user is replying to the form photo
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
                await Promise.all([
                    currentPage.click(submitSelector),
                    currentPage.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {})
                ]);
                
                isWaitingForCaptcha = false; // RELEASE THE LOOP
                await superLog("✅ CAPTCHA submitted! Check the browser status.");
            }
        } catch (e) {
            await superLog(`❌ Error in auto-submit: ${e.message}`);
        }
    }
});

// =========================
// UTILITIES
// =========================
async function waitAndClickNext(page, stepName) {
    const selector = 'input[type="submit"][value="Next"], input[type="submit"][value="التالى"]';
    try {
        await page.waitForSelector(selector, { visible: true, timeout: 15000 });
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
            page.click(selector)
        ]);
        return true;
    } catch (e) {
        return false;
    }
}

// =========================
// MAIN RUNNER
// =========================
async function runFlow() {
    let browser;
    try {
        await superLog(`🚀 Starting Flow (Mode: ${isRailway ? 'Railway' : 'Local'})`);

        // DYNAMIC CHROME PATH FINDER
        let chromePath = null;
        if (isRailway) {
            const testPaths = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'];
            for (const p of testPaths) { if (fs.existsSync(p)) { chromePath = p; break; } }
            
            if (!chromePath) {
                try { chromePath = execSync('which google-chrome-stable || which google-chrome').toString().trim(); } 
                catch (e) { chromePath = '/usr/bin/google-chrome-stable'; }
            }
        }

        browser = await puppeteer.launch({
            headless: isRailway ? "new" : false, 
            executablePath: chromePath,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        });

        currentPage = await browser.newPage();
        await currentPage.setViewport({ width: 1280, height: 1000 });
        
        await superLog("🌐 Navigating to BMEIA...");
        await currentPage.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });

        await currentPage.waitForSelector('#CalendarId');
        const masterValue = await currentPage.evaluate((search) => {
            const opt = [...document.querySelector('#CalendarId').options].find(o => o.text.includes(search));
            return opt ? opt.value : null;
        }, CALENDAR_SEARCH);

        if (masterValue) {
            await currentPage.select('#CalendarId', masterValue);
            await superLog(`📅 Selected: ${CALENDAR_SEARCH}`);
        }

        for (let i = 1; i <= 3; i++) {
            await superLog(`Step ${i}/3: Clicking Next...`);
            await waitAndClickNext(currentPage, i);
        }

        const radios = await currentPage.$$('input[type="radio"]');
        if (radios.length > 0) {
            await superLog(`✨ SLOT FOUND! Selecting first available.`);
            await radios[0].click();
            await delay(500);
            await waitAndClickNext(currentPage, "Radio Selection");

            const userId = Object.keys(users)[0];
            if (userId) {
                // Fill basic data (simplified for reliability)
                await currentPage.evaluate((data) => {
                    const setV = (s, v) => { const e = document.querySelector(s); if(e && v) { e.value = v; e.dispatchEvent(new Event('input', {bubbles:true})); } };
                    setV('#Lastname', data.lastName);
                    setV('#Firstname', data.firstName);
                    setV('#DateOfBirth', data.dob);
                    const cb = document.querySelector('input[name="DSGVOAccepted"]');
                    if (cb) cb.checked = true;
                }, users[userId]);

                const screenshotPath = path.join(__dirname, 'form.png');
                await currentPage.screenshot({ path: screenshotPath, fullPage: true });
                await bot.sendPhoto(userId, screenshotPath, { caption: "🚨 FORM FILLED! Reply with CAPTCHA code." });
                
                isWaitingForCaptcha = true;
                await superLog("⏳ BOT IS WAITING for your reply. Flow paused.");
                
                while (isWaitingForCaptcha) {
                    await delay(5000); // Keeps the browser and session alive
                }
                
                await superLog("🏁 Process completed or moved past CAPTCHA.");
            }
        } else {
            await superLog('😴 No slots. Closing browser to save RAM.');
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

// 409 Conflict Protection
bot.on('polling_error', (err) => { if (!err.message.includes('409')) console.error(err); });

runFlow();