const puppeteer = require('puppeteer');
const TelegramBot = require('node-telegram-bot-api');

const delay = ms => new Promise(res => setTimeout(res, ms));

// =========================
// CONFIG (HARDCODED)
// =========================
const telegramToken = '7044372335:AAFotpWDVLTEUHpw1d8pkvoG_UQoXqJxy68';
const telegramChatIds = [7379376037];

const TARGET_URL = 'https://appointment.bmeia.gv.at/?Office=Kairo'; // replace with actual booking URL
const CHECK_INTERVAL = 60000; // 1 minute
const CALENDAR_VALUE = '44281520'; // Example: Bachelor student
const CALENDAR_SELECTOR = '#CalendarId';
const NEXT_BUTTON_SELECTOR = 'input[name="Command"][value="Next"]';

// =========================
// TELEGRAM BOT
// =========================
const bot = new TelegramBot(telegramToken, { polling: true });

bot.on('polling_error', (error) => {
    console.error('Polling error:', error.message || error);
});

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
    while (true) {
        let browser;
        try {
            logStep('NEXT', 'Starting new cycle...');

            browser = await puppeteer.launch({
                headless: "new",
                args: [
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-gpu"
                ]
            });

            const page = await browser.newPage();
            logStep('NEXT', `Going to ${TARGET_URL}...`);
            await page.goto(TARGET_URL, { waitUntil: "networkidle2", timeout: 60000 });
            logStep('NEXT', 'Page loaded');

            // Wait for the calendar dropdown
            await page.waitForSelector(CALENDAR_SELECTOR, { timeout: 5000 });
            logStep('FIND', `Dropdown ${CALENDAR_SELECTOR} found`);

            // Check if the desired option exists
            const optionExists = await page.$(`${CALENDAR_SELECTOR} option[value="${CALENDAR_VALUE}"]`);
            if (optionExists) {
                await page.select(CALENDAR_SELECTOR, CALENDAR_VALUE);
                logStep('FIND', `Selected option with value ${CALENDAR_VALUE}`);
                await sendToAll(`✅ Selected option with value ${CALENDAR_VALUE}`);
            } else {
                logStep('NOT FIND', `Option with value ${CALENDAR_VALUE} not found`);
                await sendToAll(`❌ Option with value ${CALENDAR_VALUE} not found`);
            }

            // Click Next
            const nextButton = await page.$(NEXT_BUTTON_SELECTOR);
            if (nextButton) {
                await nextButton.click();
                logStep('NEXT', 'Clicked Next button');
                await sendToAll(`➡ Clicked Next button`);
            } else {
                logStep('NOT FIND', 'Next button not found');
                await sendToAll(`❌ Next button not found`);
            }

            logStep('BACK', 'Closing browser for this cycle');
            await browser.close();
            logStep('NEXT', `Waiting ${CHECK_INTERVAL / 1000} seconds until next cycle...`);
        } catch (error) {
            logStep('ERROR', error.message);
            await sendToAll(`❌ Error: ${error.message}`);
            if (browser) {
                try { await browser.close(); } catch {}
            }
        } finally {
            await delay(CHECK_INTERVAL);
        }
    }
}

logStep('START', 'Bot started. Checking website every minute...');
run();