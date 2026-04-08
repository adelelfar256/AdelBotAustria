const puppeteer = require('puppeteer');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// =========================
// CONFIG
// =========================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TARGET_URL = 'https://appointment.bmeia.gv.at/?Office=Bangkok';
const CALENDAR_SEARCH = 'Beg';
const CHECK_INTERVAL = 5000;

const usersPath = path.join(__dirname, 'users.json');
let users = {};
if (fs.existsSync(usersPath)) {
    users = JSON.parse(fs.readFileSync(usersPath));
}

// =========================
// TELEGRAM BOT
// =========================
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const delay = ms => new Promise(res => setTimeout(res, ms));

async function superLog(msg) {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] ${msg}`);
}

// =========================
// HELPERS
// =========================
function waitForCaptcha(chatId) {
    return new Promise((resolve) => {
        const listener = (msg) => {
            if (msg.chat.id.toString() === chatId.toString() && msg.text) {
                bot.removeListener('message', listener);
                resolve(msg.text.trim());
            }
        };
        bot.on('message', listener);
    });
}

async function clickNext(page) {
    const nextSel = 'input[type="submit"][value="Next"], input[type="submit"][value="التالى"], input[type="submit"][value="Weiter"]';
    await page.waitForSelector(nextSel, { timeout: 15000 });
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
        page.click(nextSel)
    ]);
    await delay(1000);
}

// =========================
// MAIN CHECK FUNCTION
// =========================
async function checkSlots() {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: process.env.RENDER ? "new" : false,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 1200 });

        await superLog('Navigating to appointment page...');
        await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 90000 });

        // Calendar selection
        await page.waitForSelector('#CalendarId', { timeout: 30000 });
        const masterValue = await page.evaluate((search) => {
            const el = document.querySelector('#CalendarId');
            if (!el) return null;
            const opt = [...el.options].find(o => o.text.includes(search));
            return opt ? opt.value : null;
        }, CALENDAR_SEARCH);

        if (masterValue) {
            await page.select('#CalendarId', masterValue);
            await delay(1000);
        }

        // Click Next 3 times
        superLog('Clicking Next 3 times...');
        for (let i = 0; i < 3; i++) {
            await clickNext(page);
        }

        // Check for slots in a loop
        let slotFound = false;
        while (!slotFound) {
            superLog('Checking if slots are available...');
            const bodyText = await page.evaluate(() => document.body.innerText.toLowerCase());

            if (!bodyText.includes('unfortunately')) {
                superLog('⚡ SLOT FOUND! No "unfortunately" detected.');
                const radios = await page.$$('input[type="radio"]');
                
                if (radios.length > 0) {
                    slotFound = true;
                    superLog('Selecting the first slot...');
                    await radios[0].click();
                    await delay(500);

                    // Click Next to proceed to the form
                    await clickNext(page);

                    superLog('Filling out the form...');
                    const formFields = {
                        'input[name*="LastName" i], input[id*="LastName" i]': 'Doe',
                        'input[name*="FirstName" i], input[id*="FirstName" i]': 'John',
                        'input[name*="DateOfBirth" i], input[id*="DateOfBirth" i], input[name*="BirthDate" i]': '3/15/2016',
                        'input[name*="Passport" i], input[id*="Passport" i]': 'A12345678',
                        'input[name*="Street" i], input[id*="Street" i]': '123 Main St',
                        'input[name*="Zip" i], input[id*="Zip" i], input[name*="City" i]': '1010 Vienna',
                        'input[name*="Phone" i], input[id*="Phone" i], input[name*="Tel" i]': '+1234567890',
                        'input[name*="Email" i], input[id*="Email" i]': 'john.doe@example.com',
                        'input[name*="BirthName" i], input[id*="BirthName" i]': 'Doe',
                        'input[name*="BirthPlace" i], input[id*="BirthPlace" i]': 'Vienna',
                        'input[name*="PassportIssueDate" i], input[id*="PassportIssueDate" i], input[name*="IssueDate" i]': '3/15/2016',
                        'input[name*="PassportValidUntil" i], input[id*="PassportValidUntil" i], input[name*="ValidUntil" i]': '3/15/2026'
                    };

                    const selectFields = {
                        'select[name*="Sex" i], select[id*="Sex" i]': '1', // Often 1=Male, 2=Female
                        'select[name*="Country" i], select[id*="Country" i]': 'AT', 
                        'select[name*="NationalityAtBirth" i], select[id*="NationalityAtBirth" i]': 'AT',
                        'select[name*="BirthCountry" i], select[id*="BirthCountry" i], select[name*="CountryOfBirth" i]': 'AT',
                        'select[name*="ActualNationality" i], select[id*="ActualNationality" i], select[name*="Nationality" i]': 'AT',
                        'select[name*="PassportAuthority" i], select[id*="PassportAuthority" i], select[name*="Authority" i]': 'Vienna'
                    };

                    // Text inputs
                    for (const [sel, val] of Object.entries(formFields)) {
                        const el = await page.$(sel).catch(() => null);
                        if (el) {
                            await el.click({ clickCount: 3 }).catch(() => {});
                            await el.type(val).catch(() => {});
                        }
                    }

                    // Select inputs (try exact value, then fallback)
                    for (const [sel, val] of Object.entries(selectFields)) {
                        const el = await page.$(sel).catch(() => null);
                        if (el) {
                            try {
                                await page.select(sel, val);
                            } catch (e) {
                                await page.evaluate((selector) => {
                                    const select = document.querySelector(selector);
                                    if(select && select.options.length > 1) {
                                        select.value = select.options[1].value;
                                        select.dispatchEvent(new Event('change'));
                                    }
                                }, sel).catch(() => {});
                            }
                        }
                    }

                    // Consent checkbox
                    const checkboxSel = 'input[type="checkbox"]';
                    const checkboxes = await page.$$(checkboxSel);
                    if (checkboxes.length > 0) {
                        for (const cb of checkboxes) {
                            await cb.click().catch(() => {});
                        }
                    }

                    const screenshotPath = path.join(__dirname, 'captcha_request.png');
                    await page.screenshot({ path: screenshotPath, fullPage: true });

                    const userId = Object.keys(users)[0]; // Sending to the first registered user
                    if (userId) {
                        await bot.sendPhoto(userId, screenshotPath, { caption: "🚨 SLOT AVAILABLE! Form is filled.\n\nPlease reply with the CAPTCHA text:" });

                        superLog('Waiting for CAPTCHA from user...');
                        const captchaText = await waitForCaptcha(userId);
                        superLog(`Received CAPTCHA: ${captchaText}. Typing character by character...`);

                        const captchaInputSelector = 'input[name*="captcha" i], input[id*="captcha" i]';
                        const captchaEl = await page.$(captchaInputSelector).catch(() => null);

                        if (captchaEl) {
                            // Type character by character with 150ms delay
                            await captchaEl.type(captchaText, { delay: 150 });
                        } else {
                            superLog('⚠️ Could not find CAPTCHA input field! Cannot fill captcha.');
                        }

                        // Final Submit
                        await clickNext(page);
                        superLog('Appointment form submitted!');
                        await bot.sendMessage(userId, `✅ Form submitted with CAPTCHA: ${captchaText}`);

                        // Optional: Take a screenshot of the result page
                        await delay(5000);
                        const resultScreenshotPath = path.join(__dirname, 'result.png');
                        await page.screenshot({ path: resultScreenshotPath, fullPage: true });
                        await bot.sendPhoto(userId, resultScreenshotPath, { caption: "Submission Result" });

                        superLog('Form submitted successfully. Keeping the browser window open indefinitely...');
                        await new Promise(() => {}); // Pause execution indefinitely to keep browser open
                    } else {
                        superLog('No user ID found in users.json to send the CAPTCHA to.');
                    }
                } else {
                    superLog('No radios found despite no "unfortunately", retrying...');
                    await delay(1000);
                }
            } else {
                superLog('No appointments available ("unfortunately" found). Clicking Back then Next 2 times...');
                const backSel = 'input[type="submit"][value="Back"], input[type="submit"][value="السابق"], input[type="submit"][value="Zurück"]';
                
                const backBtn = await page.$(backSel);
                if (backBtn) {
                    await Promise.all([
                        page.waitForNavigation({ waitUntil: 'networkidle2' }),
                        backBtn.click()
                    ]);
                    await delay(1000);
                    
                    // Click next 2 times
                    for (let i = 0; i < 2; i++) {
                        await clickNext(page);
                    }
                } else {
                    superLog('Could not find the "Back" button. Refreshing page by ending current attempt...');
                    break; // Break the while loop to restart checkSlots entirely
                }
            }
        }

    } catch (err) {
        superLog('ERROR: ' + err.message);
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

// =========================
// MAIN LOOP
// =========================
async function main() {
    superLog('Bot started...');
    while (true) {
        await checkSlots();
        await delay(CHECK_INTERVAL);
    }
}

main();