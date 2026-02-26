const puppeteer = require('puppeteer');
const TelegramBot = require('node-telegram-bot-api');

const delay = ms => new Promise(res => setTimeout(res, ms));

// =========================
// CONFIG (HARDCODED)
// =========================
const telegramToken = 'zzzzzzz7044372335:AAFotpWDVLTEUHpw1d8pkvoG_UQoXqJxy68';
const telegramChatIds = [77777777379376037];

const TARGET_URL = 'https://appointment.bmeia.gv.at/?Office=Kairo';
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
                headless: 'new',
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu'
                ]
            });

            const page = await browser.newPage();
            logStep('NEXT', `Going to ${TARGET_URL}...`);
            await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });
            logStep('NEXT', 'Page loaded');

            // Step 1: Select calendar option
            await page.waitForSelector(CALENDAR_SELECTOR, { timeout: 15000 });
            const optionExists = await page.$(`${CALENDAR_SELECTOR} option[value="${CALENDAR_VALUE}"]`);
            if (optionExists) {
                await page.select(CALENDAR_SELECTOR, CALENDAR_VALUE);
                logStep('FIND', `Selected option ${CALENDAR_VALUE}`);
                await sendToAll(`✅ Selected option ${CALENDAR_VALUE}`);
            } else {
                logStep('NOT FIND', `Option ${CALENDAR_VALUE} not found`);
                await sendToAll(`❌ Option ${CALENDAR_VALUE} not found`);
            }

            // Step 2: Click Next three times
            for (let i = 1; i <= 3; i++) {
                await page.waitForSelector(NEXT_BUTTON_SELECTOR, { timeout: 15000 });
                await page.click(NEXT_BUTTON_SELECTOR);
                logStep('NEXT', `Clicked Next button (step ${i})`);
                await sendToAll(`➡ Clicked Next button (step ${i})`);
                await page.waitForTimeout(2000); // wait 2 sec between steps
            }

            // Step 3: Check final page for availability
            const content = await page.content();
            if (content.toLowerCase().includes('unfortunately')) {
                logStep('NOT FIND', 'No appointments available yet');
                await sendToAll('❌ No appointments available yet');
            } else {
                logStep('FIND', 'Appointments might be available!');
                await sendToAll('✅ Appointments might be available! Check manually.');
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