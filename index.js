const TelegramBot = require('node-telegram-bot-api');

// =========================
// CONFIG (HARDCODED)
// =========================

// Your Telegram bot token
const telegramToken = '7044372335:AAFotpWDVLTEUHpw1d8pkvoG_UQoXqJxy68';

// Your chat IDs (can be multiple)
const telegramChatIds = [7379376037];

// Interval in milliseconds (1 minute)
const INTERVAL = 60000;

// =========================
// TELEGRAM BOT
// =========================

const bot = new TelegramBot(telegramToken, { polling: true });

bot.on('polling_error', (error) => {
    console.error('Polling error:', error.message || error);
});

// =========================
// HELPER TO SEND MESSAGE
// =========================

async function sendToAll(message) {
    for (const id of telegramChatIds) {
        try {
            await bot.sendMessage(id, message);
            console.log(`Sent to ${id}: ${message}`);
        } catch (err) {
            console.error(`Failed to send to ${id}:`, err.message);
        }
    }
}

// =========================
// MAIN LOOP
// =========================

console.log("Bot started. Sending test messages every minute...");

setInterval(() => {
    const timestamp = new Date().toLocaleTimeString();
    sendToAll(`⏰ Test message at ${timestamp}`);
}, INTERVAL);