const puppeteer = require('puppeteer');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

require('dotenv').config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TARGET_URL = 'https://appointment.bmeia.gv.at/?Office=Bangkok';
const CALENDAR_SEARCH = 'Beg';
const CHECK_INTERVAL = 45000;

const usersPath = path.join(__dirname, 'users.json');
let users = {};
if (fs.existsSync(usersPath)) {
    users = JSON.parse(fs.readFileSync(usersPath));
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const delay = ms => new Promise(res => setTimeout(res, ms));

async function superLog(msg) {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] ${msg}`);
}

// =========================
// Main check flow
// =========================
async function checkSlots() {
    let browser;
    try {
        browser = await puppeteer.launch({ headless: false }); // see browser
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 1200 });

        await superLog('Navigating to appointment page...');
        await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 90000 });

        // Calendar selection
        await page.waitForSelector('#CalendarId', { timeout: 30000 });
        const masterValue = await page.evaluate((search) => {
            const el = document.querySelector('#CalendarId');
            const opt = [...el.options].find(o => o.text.includes(search));
            return opt ? opt.value : null;
        }, CALENDAR_SEARCH);

        if (masterValue) await page.select('#CalendarId', masterValue);

        const nextSel = 'input[type="submit"][value="Next"], input[type="submit"][value="التالى"]';
        for (let i = 0; i < 4; i++) {
            await page.waitForSelector(nextSel, { timeout: 20000 });
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle2' }),
                page.click(nextSel)
            ]);
            await delay(1000);
        }

        // Check slots
        const pageText = await page.evaluate(() => document.body.innerText);
        const hasNoAppt = pageText.includes("no appointments available") || pageText.includes("لا توجد مواعيد متاحة");
        const radios = await page.$$('input[type="radio"]');

        if (radios.length > 0 && !hasNoAppt) {
            superLog('⚡ SLOT FOUND! Sending Telegram message...');
            const screenshotPath = path.join(__dirname, 'slot.png');
            await page.screenshot({ path: screenshotPath, fullPage: true });
            const userId = Object.keys(users)[0];
            if (userId) {
                await bot.sendPhoto(userId, screenshotPath, { caption: "🚨 SLOT AVAILABLE!" });
            }
        } else {
            superLog('No slots available.');
        }

    } catch (err) {
        superLog('ERROR: ' + err.message);
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

// =========================
// Loop
// =========================
async function main() {
    superLog('Bot started...');
    while (true) {
        await checkSlots();
        await delay(CHECK_INTERVAL);
    }
}

main();