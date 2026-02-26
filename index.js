const puppeteer = require('puppeteer');
const TelegramBot = require('node-telegram-bot-api');

const delay = ms => new Promise(res => setTimeout(res, ms));

// =========================
// CONFIG
// =========================
const telegramToken = '7044372335:AAFotpWDVLTEUHpw1d8pkvoG_UQoXqJxy68';
const telegramChatIds = [7379376037];

const TARGET_URL = 'https://appointment.bmeia.gv.at/?Office=Kairo';
const CHECK_INTERVAL = 10000; // 10s for testing
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
// FULL FLOW FUNCTION
// =========================
async function runFlow() {
    while (true) {
        let browser;
        try {
            logStep('START', 'Starting new flow...');
            browser = await puppeteer.launch({
                headless: 'new',
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
            });

            const page = await browser.newPage();
            await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });
            logStep('NEXT', 'Page loaded');

            // Select calendar option
            await page.waitForSelector(CALENDAR_SELECTOR, { timeout: 20000 });
            const optionExists = await page.$(`${CALENDAR_SELECTOR} option[value="${CALENDAR_VALUE}"]`);
            if (optionExists) {
                await page.select(CALENDAR_SELECTOR, CALENDAR_VALUE);
                logStep('FIND', `Selected option ${CALENDAR_VALUE}`);
            } else {
                throw new Error(`Calendar option ${CALENDAR_VALUE} not found`);
            }

            let lastAvailable = false;
            let firstRun = true;

            // =========================
            // Inner loop for flow steps
            // =========================
            while (true) {
                try {
                    // Determine how many Next clicks
                    const nextClicks = firstRun ? 3 : 2;
                    for (let i = 1; i <= nextClicks; i++) {
                        await page.waitForSelector(NEXT_BUTTON_SELECTOR, { timeout: 15000 });
                        await page.click(NEXT_BUTTON_SELECTOR);
                        logStep('NEXT', `Clicked Next button (step ${i} of ${nextClicks})`);
                        await delay(2000);
                    }

                    // Check page content
                    const content = await page.content();
                    if (content.toLowerCase().includes('unfortunately')) {
                        logStep('NOT FIND', 'No appointments available yet');
                        lastAvailable = false;
                    } else {
                        logStep('FIND', 'Appointments might be available!');
                        if (!lastAvailable) {
                            await sendToAll('✅ Appointments might be available! Check manually.');
                            lastAvailable = true;
                        }
                    }

                    // Click Back to restart flow
                    const backButton = await page.$(BACK_BUTTON_SELECTOR);
                    if (backButton) {
                        await backButton.click();
                        logStep('BACK', 'Clicked Back button to restart flow');
                        await delay(2000);
                    } else {
                        throw new Error('Back button not found, restarting flow');
                    }

                    firstRun = false;

                } catch (innerErr) {
                    // Any error in the inner loop triggers a full restart
                    throw innerErr;
                }
            }

        } catch (err) {
            logStep('ERROR', err.message);
            await sendToAll(`❌ Error: ${err.message} — restarting entire flow`);
            if (browser) {
                try { await browser.close(); } catch {}
            }
            logStep('NEXT', `Waiting ${CHECK_INTERVAL / 1000}s before restarting flow...`);
            await delay(CHECK_INTERVAL);
        }
    }
}

// =========================
// START BOT
// =========================
logStep('START', 'Bot started. Looping through appointments...');
runFlow();