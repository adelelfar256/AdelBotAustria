const puppeteer = require('puppeteer');
const TelegramBot = require('node-telegram-bot-api');

const delay = ms => new Promise(res => setTimeout(res, ms));

// =========================
// CONFIG
// =========================
const telegramToken = '7044372335:AAFotpWDVLTEUHpw1d8pkvoG_UQoXqJxy68';
const telegramChatIds = [7379376037];

const TARGET_URL = 'https://appointment.bmeia.gv.at/?Office=Kairo';
const CHECK_INTERVAL = 10000; // 10s between loops for testing
const CALENDAR_VALUE = '44281520'; 
const CALENDAR_SELECTOR = '#CalendarId';
const NEXT_BUTTON_SELECTOR = 'input[name="Command"][value="Next"]';
const BACK_BUTTON_SELECTOR = 'input[name="Command"][value="Back"]';

// =========================
// TELEGRAM BOT
// =========================
const bot = new TelegramBot(telegramToken, { polling: true });
bot.on('polling_error', err => console.error('Telegram polling error:', err.message));

async function sendToAll(message) {
    for (const id of telegramChatIds) {
        try {
            await bot.sendMessage(id, message);
            console.log(`[TELEGRAM] Sent to ${id}: ${message}`);
        } catch (err) {
            console.error(`[TELEGRAM] Failed to send to ${id}:`, err.message);
        }
    }
}

// =========================
// LOG HELPER
// =========================
function logStep(step, extra = '') {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] [${step}] ${extra}`);
}

// =========================
// MAIN LOOP
// =========================
async function run() {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: 'new', // visible browser
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });

        const page = await browser.newPage();
        await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        logStep('NEXT', 'Page loaded');

        // Step 1: Select calendar option once
        await page.waitForSelector(CALENDAR_SELECTOR, { timeout: 15000 });
        const optionExists = await page.$(`${CALENDAR_SELECTOR} option[value="${CALENDAR_VALUE}"]`);
        if (optionExists) {
            await page.select(CALENDAR_SELECTOR, CALENDAR_VALUE);
            logStep('FIND', `Selected option ${CALENDAR_VALUE}`);
        } else {
            logStep('NOT FIND', `Option ${CALENDAR_VALUE} not found`);
        }

        let lastAvailable = false; // track if we already alerted

        // =========================
        // Main appointment checking loop
        // =========================
        while (true) {
            try {
                // Click Next → Next → Next
                for (let i = 1; i <= 3; i++) {
                    await page.waitForSelector(NEXT_BUTTON_SELECTOR, { timeout: 15000 });
                    await page.click(NEXT_BUTTON_SELECTOR);
                    logStep('NEXT', `Clicked Next button (step ${i})`);
                    await delay(2000);
                }

                // Check final page for availability
                const content = await page.content();
                if (content.toLowerCase().includes('unfortunately')) {
                    logStep('NOT FIND', 'No appointments available yet');
                    lastAvailable = false; // reset flag
                } else {
                    logStep('FIND', 'Appointments might be available!');
                    if (!lastAvailable) {
                        // Only send Telegram once per new availability
                        await sendToAll('✅ Appointments might be available! Check manually.');
                        lastAvailable = true;
                    }
                }

                // Click Back to restart loop
                await page.waitForSelector(BACK_BUTTON_SELECTOR, { timeout: 15000 });
                await page.click(BACK_BUTTON_SELECTOR);
                logStep('BACK', 'Clicked Back button to restart flow');
                await delay(2000);

            } catch (err) {
                logStep('ERROR', err.message);
                await delay(CHECK_INTERVAL);
            }
        }

    } catch (error) {
        logStep('ERROR', error.message);
        if (browser) try { await browser.close(); } catch {}
    }
}

logStep('START', 'Bot started. Looping through appointments...');
run();