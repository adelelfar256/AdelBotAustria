const puppeteer = require('puppeteer');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const delay = ms => new Promise(res => setTimeout(res, ms));

// --- Hardcoded configs ---
const TELEGRAM_TOKEN = '7044372335:AAFotpWDVLTEUHpw1d8pkvoG_UQoXqJxy68';
const TELEGRAM_CHAT_IDS_FILE = 'chat_ids.json';
const APPOINTMENT_URL = 'https://appointment.bmeia.gv.at/?Office=Bangkok';

let telegramChatIds = [];
if (fs.existsSync(TELEGRAM_CHAT_IDS_FILE)) {
    try {
        telegramChatIds = JSON.parse(fs.readFileSync(TELEGRAM_CHAT_IDS_FILE, 'utf8'));
    } catch (err) {
        console.error('Failed to read chat IDs:', err.message);
    }
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Save chat IDs
function saveChatIds() {
    fs.writeFileSync(TELEGRAM_CHAT_IDS_FILE, JSON.stringify(telegramChatIds, null, 2));
}

// Listen for new subscribers
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    if (!telegramChatIds.includes(chatId)) {
        telegramChatIds.push(chatId);
        saveChatIds();
        bot.sendMessage(chatId, `✅ You are now subscribed to appointment updates!`);
        console.log(`New subscriber: ${chatId}`);
    }
});

// Send message to all subscribers
async function sendToAll(message) {
    for (const id of telegramChatIds) {
        try {
            await bot.sendMessage(id, message);
        } catch (err) {
            console.error(`Failed to send message to ${id}:`, err.message);
        }
    }
}

// --- Puppeteer logic ---
async function run() {
    while (true) {
        let browser;
        try {
            browser = await puppeteer.launch({
                headless: true,
                args: ['--no-sandbox', '--disable-gpu']
            });

            const page = await browser.newPage();
            await page.goto(APPOINTMENT_URL, { waitUntil: 'networkidle0' });

            // --- Select the right option (like "bachelor") ---
            await page.waitForSelector('tbody tr:nth-child(2) td select');
            const masterValue = await page.evaluate(() => {
                const select = document.querySelector('tbody tr:nth-child(2) td select');
                const found = Array.from(select.options)
                    .find(opt => opt.textContent.toLowerCase().includes('Bachelor')); // change "bachelor" if needed
                return found ? found.value : null;
            });

            if (!masterValue) {
                console.log('No matching dropdown option found.');
                await browser.close();
                await delay(60 * 1000); // wait 1 min before retry
                continue;
            }

            await page.select('tbody tr:nth-child(2) td select', masterValue);

            // --- Click Next a few times, handle "unfortunately" ---
            const clickNext = async () => {
                const buttons = await page.$$('input[type="submit"]');
                for (const btn of buttons) {
                    const val = await (await btn.getProperty('value')).jsonValue();
                    if (val.toLowerCase() === 'next' || val === 'التالى') {
                        await Promise.all([
                            page.waitForNavigation({ waitUntil: 'networkidle0' }),
                            btn.click()
                        ]);
                        return true;
                    }
                }
                return false;
            };

            const loopUntilNoUnfortunately = async () => {
                while (true) {
                    const bodyText = await page.evaluate(() => document.body.innerText.toLowerCase());
                    if (!bodyText.includes('unfortunately')) break;
                    const nextClicked = await clickNext();
                    if (!nextClicked) break;
                }
            };

            for (let i = 0; i < 3; i++) {
                const ok = await clickNext();
                if (!ok) break;
                await loopUntilNoUnfortunately();
            }

            // --- Check for radio buttons (appointment availability) ---
            await page.waitForSelector('input[type="radio"]', { timeout: 5000 }).catch(() => null);
            const radios = await page.$$('input[type="radio"]');
            if (radios.length > 0) {
                await sendToAll(`📅 Appointment available! Check: ${APPOINTMENT_URL}`);
                console.log('✅ Appointment available, message sent!');
            } else {
                console.log('No appointments available yet.');
            }

        } catch (err) {
            console.error('Error during run:', err.message);
        } finally {
            if (browser) await browser.close();
        }

        // Wait before next check
        await delay(60 * 1000); // 1 minute
    }
}

// Start the bot
run();