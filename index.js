require('dotenv').config();

const puppeteer = require('puppeteer');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');

// =========================
// CONFIG
// =========================
const telegramToken = process.env.TELEGRAM_TOKEN;

if (!telegramToken) {
    throw new Error("❌ TELEGRAM_TOKEN is missing!");
}

// ✅ IMPORTANT: use Render-installed Chrome OR fallback
const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath();

const TARGET_URL = 'https://appointment.bmeia.gv.at/?Office=Bangkok';
const CALENDAR_SEARCH = 'Beg';
const CHECK_INTERVAL = 45000;

// ✅ YOUR TELEGRAM ID
let users = {
    "7379376037": {
        firstName: "a",
        lastName: "a",
        lastNameAtBirth: "a",
        dob: "01.01.1998",
        placeOfBirth: "b",
        countryOfBirth: "b",
        sex: "b",
        street: "b",
        postcode: "b",
        city: "b",
        country: "b",
        telephone: "b",
        email: "b",
        passportNumber: "b",
        passportIssueDate: "01.01.2020",
        passportValidUntil: "01.01.2030",
        passportAuthority: "b",
        nationalityAtBirth: "b",
        actualNationality: "b"
    }
};

let currentPage = null;
let isWaitingForCaptcha = false;

// =========================
// TELEGRAM BOT
// =========================
const bot = new TelegramBot(telegramToken, {
    polling: { params: { drop_pending_updates: true } }
});

// ✅ FIX 409 ERROR
bot.on("polling_error", (err) => {
    console.log("Polling error:", err.message);

    if (err.message.includes("409")) {
        console.log("⚠️ Another instance is running. Ignore.");
    }
});

const delay = ms => new Promise(res => setTimeout(res, ms));

// =========================
// LOGGING
// =========================
async function superLog(message) {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] ${message}`);

    const adminId = Object.keys(users)[0];
    if (adminId) {
        await bot.sendMessage(adminId, `🛰 ${message}`).catch(() => {});
    }
}

// =========================
// ERROR SCREENSHOT
// =========================
async function sendErrorScreenshot(page, stepName) {
    try {
        const screenshotPath = path.join(__dirname, `error_${stepName}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });

        const adminId = Object.keys(users)[0];
        if (adminId) {
            await bot.sendPhoto(adminId, screenshotPath, {
                caption: `❌ Error at ${stepName}`
            });
        }
    } catch (e) {
        console.error("Screenshot failed:", e.message);
    }
}

// =========================
// FORM FILL
// =========================
async function fillFormForUser(page, d) {
    await superLog(`📝 Filling form`);

    await page.evaluate((data) => {
        const setV = (s, v) => {
            const e = document.querySelector(s);
            if (e && v) {
                e.value = v;
                e.dispatchEvent(new Event('input', { bubbles: true }));
                e.dispatchEvent(new Event('change', { bubbles: true }));
            }
        };

        const sel = (s, t) => {
            const el = document.querySelector(s);
            if (!el || !t) return;
            const opt = [...el.options].find(o =>
                o.text.toLowerCase().includes(t.toLowerCase())
            );
            if (opt) {
                el.value = opt.value;
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }
        };

        setV('#Lastname', data.lastName);
        setV('#Firstname', data.firstName);
        setV('#LastnameAtBirth', data.lastNameAtBirth);
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

        const cb = document.querySelector('input[name="DSGVOAccepted"]');
        if (cb) cb.checked = true;

    }, d);
}

// =========================
// CAPTCHA HANDLER
// =========================
bot.on('message', async (msg) => {
    if (!msg.text || !currentPage || !isWaitingForCaptcha) return;

    try {
        const inputSelector = '#CaptchaText';
        const submitSelector = 'input[type="submit"]';

        await currentPage.click(inputSelector, { clickCount: 3 });
        await currentPage.keyboard.press('Backspace');

        for (const char of msg.text) {
            await currentPage.type(inputSelector, char.toUpperCase(), { delay: 50 });
        }

        await Promise.all([
            currentPage.click(submitSelector),
            currentPage.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {})
        ]);

        const stillCaptcha = await currentPage.$(inputSelector);

        if (stillCaptcha) {
            await superLog("❌ Wrong CAPTCHA");
        } else {
            await superLog("✅ SUCCESS BOOKED");
            isWaitingForCaptcha = false;
        }

    } catch (e) {
        await superLog(`CAPTCHA ERROR: ${e.message}`);
    }
});

// =========================
// MAIN FLOW
// =========================
async function runFlow() {
    let browser;

    try {
       const browser = await puppeteer.launch({
    headless: "new",
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
    ]
});

        currentPage = await browser.newPage();

        await currentPage.goto(TARGET_URL, {
            waitUntil: 'networkidle2',
            timeout: 90000
        });

        await currentPage.waitForSelector('#CalendarId');

        const value = await currentPage.evaluate((search) => {
            const el = document.querySelector('#CalendarId');
            const opt = [...el.options].find(o => o.text.includes(search));
            return opt ? opt.value : null;
        }, CALENDAR_SEARCH);

        if (value) {
            await currentPage.select('#CalendarId', value);
            await delay(1000);
        }

        for (let i = 0; i < 3; i++) {
            await Promise.all([
                currentPage.waitForNavigation({ waitUntil: 'networkidle2' }),
                currentPage.click('input[type="submit"]')
            ]);
        }

        const radios = await currentPage.$$('input[type="radio"]');
        const text = await currentPage.evaluate(() => document.body.innerText);

        if (radios.length > 0 && !text.includes("no appointments")) {
            await superLog("🔥 SLOT FOUND");

            await radios[0].click();

            await Promise.all([
                currentPage.waitForNavigation({ waitUntil: 'networkidle2' }),
                currentPage.click('input[type="submit"]')
            ]);

            const userId = Object.keys(users)[0];

            await fillFormForUser(currentPage, users[userId]);

            const screenshotPath = path.join(__dirname, 'slot.png');
            await currentPage.screenshot({ path: screenshotPath });

            await bot.sendPhoto(userId, screenshotPath, {
                caption: "🚨 SLOT FOUND! Send CAPTCHA"
            });

            isWaitingForCaptcha = true;

            const timeout = Date.now() + 300000;
            while (isWaitingForCaptcha && Date.now() < timeout) {
                await delay(3000);
            }

            isWaitingForCaptcha = false;

        } else {
            await superLog("😴 No slots");
        }

    } catch (err) {
        await superLog(`❌ ERROR: ${err.message}`);
        if (currentPage) await sendErrorScreenshot(currentPage, "crash");
    } finally {
        if (browser) await browser.close().catch(() => {});
        currentPage = null;
    }
}

// =========================
// LOOP
// =========================
async function main() {
    await superLog("🤖 Bot started");

    const loop = async () => {
        try {
            if (!isWaitingForCaptcha) {
                await runFlow();
            }
        } catch (e) {
            await superLog(`🔥 LOOP ERROR: ${e.message}`);
        }
        setTimeout(loop, CHECK_INTERVAL);
    };

    loop();
}

// =========================
// GLOBAL ERROR HANDLING
// =========================
process.on('unhandledRejection', err => console.error('Unhandled:', err));
process.on('uncaughtException', err => console.error('Uncaught:', err));

// =========================
// START
// =========================
main();