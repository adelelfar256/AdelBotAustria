const puppeteer = require('puppeteer');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// =========================
// CONFIG
// =========================
const telegramToken = '7044372335:AAFh0yuQBNiAUYY80WDIZ1MihjzWLgLanJk';
const TARGET_URL = 'https://appointment.bmeia.gv.at/?Office=Bangkok';
const CALENDAR_SEARCH = 'Beg'; 
const CHECK_INTERVAL = 5000; 

const usersPath = path.join(__dirname, 'users.json');
let users = {};
if (fs.existsSync(usersPath)) {
    users = JSON.parse(fs.readFileSync(usersPath));
}

let currentPage = null; 
const bot = new TelegramBot(telegramToken, { polling: true });
const delay = ms => new Promise(res => setTimeout(res, ms));

// =========================
// TELEGRAM REPLY LISTENER (FIXED: Types & Clicks Next)
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
                // 1. Clear and Focus
                await currentPage.click(inputSelector);
                await currentPage.click(inputSelector, { clickCount: 3 });
                await currentPage.keyboard.press('Backspace');

                // 2. Type the CAPTCHA code
                for (const char of text) {
                    await currentPage.type(inputSelector, char.toUpperCase(), { delay: 40 });
                }
                console.log(`✅ CAPTCHA [${text}] typed.`);

                // 3. THE FIX: CLICK NEXT AUTOMATICALLY
                await delay(500); // Brief pause to ensure site registers input
                console.log('[INFO] Auto-clicking Next button...');
                await currentPage.click(submitSelector);
                
                await bot.sendMessage(msg.chat.id, "🚀 Code typed and 'Next' clicked!");
            }
        } catch (e) {
            console.error('❌ Error in auto-submit flow:', e.message);
        }
    }
});

// =========================
// FORM CAPTURE (Full Page)
// =========================
async function captureAndSendForm(page, chatId) {
    console.log('[INFO] Waiting 2 seconds before screenshot...');
    await delay(2000); 

    try {
        const screenshotPath = path.join(__dirname, 'form_filled.png');
        await page.screenshot({ path: screenshotPath, fullPage: true });

        await bot.sendPhoto(chatId, screenshotPath, { 
            caption: "🚨 FORM FILLED! Reply to this photo with the CAPTCHA code to type it and click Next automatically." 
        });
        
        console.log('✅ Screenshot of filled form sent to Telegram.');
    } catch (e) {
        console.error('❌ Screenshot failed:', e.message);
    }
}

async function waitAndClickNext(page) {
    const selector = 'input[type="submit"][value="Next"], input[type="submit"][value="التالى"]';
    try {
        await page.waitForSelector(selector, { visible: true, timeout: 10000 });
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
            page.click(selector)
        ]);
        return true;
    } catch (e) {
        return false;
    }
}

async function fillFormForUser(page, userData) {
    console.log('[INFO] Filling form fields...');
    await page.evaluate((data) => {
        const setVal = (sel, val) => {
            const el = document.querySelector(sel);
            if (el && val) {
                el.value = val;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }
        };

        const select = (sel, txt) => {
            const s = document.querySelector(sel);
            if (!s || !txt) return;
            const opt = [...s.options].find(o => 
                o.text.toLowerCase().trim() === txt.toLowerCase().trim() ||
                o.text.toLowerCase().includes(txt.toLowerCase().trim())
            );
            if (opt) { 
                s.value = opt.value; 
                s.dispatchEvent(new Event('change', { bubbles: true })); 
            }
        };

        // Text Inputs (Fixed #Firstname typo)
        setVal('#Lastname', data.lastName);
        setVal('#Firstname', data.firstName);
        setVal('#LastnameAtBirth', data.lastNameAtBirth);
        setVal('#DateOfBirth', data.dob);
        setVal('#PlaceOfBirth', data.placeOfBirth);
        setVal('#Postcode', data.postcode);
        setVal('#City', data.city);
        setVal('#Street', data.street);
        setVal('#Telephone', data.telephone);
        setVal('#Email', data.email);
        setVal('#TraveldocumentNumber', data.passportNumber);
        setVal('#TraveldocumentDateOfIssue', data.passportIssueDate);
        setVal('#TraveldocumentValidUntil', data.passportValidUntil);

        // Dropdowns
        select('#CountryOfBirth', data.countryOfBirth); 
        select('#Sex', data.sex); 
        select('#Country', data.country);
        select('#TraveldocumentIssuingAuthority', data.passportAuthority);
        select('#NationalityAtBirth', data.nationalityAtBirth); 
        select('#NationalityForApplication', data.actualNationality); 

        // Checkbox
        const cb = document.querySelector('input[name="DSGVOAccepted"]');
        if (cb) { 
            cb.checked = true; 
            cb.dispatchEvent(new Event('change', { bubbles: true })); 
        }
    }, userData);
}

// =========================
// MAIN RUNNER
// =========================
async function runFlow() {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: false,
            defaultViewport: null,
            args: ['--no-sandbox', '--start-maximized']
        });

        currentPage = await browser.newPage();
        await currentPage.goto(TARGET_URL, { waitUntil: 'networkidle2' });

        await currentPage.waitForSelector('#CalendarId');
        const masterValue = await currentPage.evaluate((search) => {
            const sel = document.querySelector('#CalendarId');
            const opt = Array.from(sel.options).find(o => o.textContent.toLowerCase().includes(search.toLowerCase()));
            return opt ? opt.value : null;
        }, CALENDAR_SEARCH);
        if (masterValue) await currentPage.select('#CalendarId', masterValue);

        for (let i = 1; i <= 3; i++) {
            await waitAndClickNext(currentPage);
        }

        const radios = await currentPage.$$('input[type="radio"]');
        if (radios.length > 0) {
            console.log('[FOUND] Slot found! Filling form...');
            await radios[0].click();
            await delay(500);
            await waitAndClickNext(currentPage);

            const firstUserKey = Object.keys(users)[0];
            if (firstUserKey) {
                await fillFormForUser(currentPage, users[firstUserKey]);
                await captureAndSendForm(currentPage, firstUserKey);
                console.log('✅ Form ready. Send CAPTCHA response in Telegram to auto-submit.');
            }
        } else {
            console.log('❌ No slots. Retrying...');
            await browser.close();
            await delay(3000);
            return runFlow();
        }

    } catch (err) {
        console.error('[CRITICAL RESTART]', err.message);
        if (browser) await browser.close();
        await delay(CHECK_INTERVAL);
        runFlow();
    }
}

runFlow();