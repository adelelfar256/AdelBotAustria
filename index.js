const puppeteer = require('puppeteer');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const delay = ms => new Promise(res => setTimeout(res, ms));

const telegramToken = '7044372335:AAFotpWDVLTEUHpw1d8pkvoG_UQoXqJxy68';
const telegramChatId = 7379376037;
const bot = new TelegramBot(telegramToken, { polling: true });

async function run() {

  while (true) {
    try {
      const browser = await puppeteer.launch({ headless: 'new',  args: ['--no-sandbox', '--disable-gpu'], slowMo: 50 });
      await startBooking(browser);
    } catch (error) {
      await bot.sendMessage(telegramChatId, `❌ Error occurred: ${error.message}\n🔁 Restarting...`);
    }
    await delay(3000);
  }
}

async function checkUnfortunately(page) {
  const bodyText = await page.evaluate(() => document.body.innerText.toLowerCase());
  return bodyText.includes('unfortunately');
}

async function loopUntilNoUnfortunately(page) {
  while (true) {
    const hasUnfortunately = await checkUnfortunately(page);
    if (!hasUnfortunately) break;

    const buttons = await page.$$('input[type="submit"]');
    const backBtn = await Promise.all(buttons.map(async btn => {
      const value = await (await btn.getProperty('value')).jsonValue();
      return (value === 'Back' || value === 'السابق') ? btn : null;
    }));

    const back = backBtn.find(b => b !== null);
    if (back) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle0' }),
        back.click()
      ]);
    } else {
      return;
    }

    for (let i = 0; i < 2; i++) {
      const nextClicked = await clickNextButton(page);
      if (!nextClicked) return;
    }
  }
}

async function clickNextButton(page) {
  const nextButtonSelector = 'input[type="submit"]';
  await page.waitForSelector(nextButtonSelector, { visible: true });
  const buttons = await page.$$(nextButtonSelector);
  for (const btn of buttons) {
    const val = await (await btn.getProperty('value')).jsonValue();
    if (val === 'Next' || val === 'التالى') {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle0' }),
        btn.click()
      ]);
      return true;
    }
  }
  return false;
}

async function startBooking(browser) {
  const page = await browser.newPage();
  await page.goto('https://appointment.bmeia.gv.at/?Office=Bangkok', { waitUntil: 'networkidle0' });

  await page.waitForSelector('tbody tr:nth-child(2) td select');
  const masterValue = await page.evaluate(() => {
    const select = document.querySelector('tbody tr:nth-child(2) td select');
    const found = Array.from(select.options).find(opt => opt.textContent.toLowerCase().includes('beg'));
    return found ? found.value : null;
  });
  if (!masterValue) throw new Error('No matching dropdown option found');
  await page.select('tbody tr:nth-child(2) td select', masterValue);

  for (let i = 0; i < 3; i++) {
    const ok = await clickNextButton(page);
    if (!ok) throw new Error(`Next not found at step ${i + 1}`);
    await loopUntilNoUnfortunately(page);
  }

  await page.waitForSelector('input[type="radio"]');
  const radios = await page.$$('input[type="radio"]');
  if (!radios.length) throw new Error('No radios found');
  await radios[0].click();
  await clickNextButton(page);
  await loopUntilNoUnfortunately(page);

  while (true) {
    await handleCaptchaAndForm(page);
    const result = await checkForResult(page, browser);
    if (result === 'success') return;
    if (result === 'restart') return;
  }
}

async function handleCaptchaAndForm(page) {
  await page.evaluate(() => (document.body.style.zoom = '0.5'));
  await delay(500);

  const captchaDiv = await page.$('#Captcha_CaptchaImageDiv');
  if (!captchaDiv) throw new Error('CAPTCHA div not found');
  const imgPath = path.resolve(__dirname, 'captcha.png');
  await captchaDiv.screenshot({ path: imgPath });

  const sentMsg = await bot.sendPhoto(telegramChatId, imgPath, {
    caption: '🧩 CAPTCHA image. Please reply with the solution.'
  });

  return new Promise((resolve) => {
    const listener = async (msg) => {
      if (
        msg.chat.id === telegramChatId &&
        msg.reply_to_message &&
        msg.reply_to_message.message_id === sentMsg.message_id
      ) {
        const captchaText = msg.text.trim();
        bot.removeListener('message', listener);
        await fillForm(page, captchaText);
        resolve();
      }
    };
    bot.on('message', listener);
  });
}

async function fillForm(page, captchaText) {
  await page.evaluate((captcha) => {
    function setVal(sel, val) {
      const el = document.querySelector(sel);
      if (el) {
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    function selectByText(sel, text) {
      const selEl = document.querySelector(sel);
      if (!selEl) return;
      const match = [...selEl.options].find(o => o.text.trim().toLowerCase() === text.toLowerCase());
      if (match) {
        selEl.value = match.value;
        selEl.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    function checkBox(id) {
      const box = document.getElementById(id);
      if (box && !box.checked) box.click();
    }

    setVal('#Lastname', 'Elfar');
    setVal('#Firstname', 'Adel');
    setVal('#DateOfBirth', '09/25/1997');
    setVal('#TraveldocumentNumber', 'A31763698');
    selectByText('#Sex', 'Male');

    setVal('#Street', 'Fareed Semeika');
    setVal('#Postcode', '11757');
    setVal('#City', 'Cairo');
    selectByText('#Country', 'Egypt');

    setVal('#Telephone', '+201126445146');
    setVal('#Email', 'adelessam256@gmail.com');

    setVal('#LastnameAtBirth', 'Adel Essam Abdelmonem Elfar');
    selectByText('#NationalityAtBirth', 'Egypt');
    selectByText('#CountryOfBirth', 'Egypt');
    setVal('#PlaceOfBirth', 'Cairo');
    selectByText('#NationalityForApplication', 'Egypt');

    setVal('#TraveldocumentDateOfIssue', '10/16/2022');
    setVal('#TraveldocumentValidUntil', '10/15/2029');
    selectByText('#TraveldocumentIssuingAuthority', 'Egypt');

    setVal('#CaptchaText', captcha);
    checkBox('DSGVOAccepted');
  }, captchaText);

  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('input[type="submit"]')];
    const nextBtn = btns.find(btn => btn.value === 'Next' || btn.value === 'التالى');
    if (nextBtn) nextBtn.click();
  });
}

async function checkForResult(page, browser) {
  await delay(3000);
  const content = await page.content();
  const lower = content.toLowerCase();

  if (lower.includes('unfortunately') || /relocate|alocate/i.test(content)) {
   // await bot.sendMessage(telegramChatId, '🔁 Got "unfortunately" or relocation. Restarting...');
    await page.close();
    await browser.close();
    return 'restart';
  }
  if (/captcha/i.test(content) && /does not match/i.test(content)) {
    await bot.sendMessage(telegramChatId, '❌ Wrong CAPTCHA. Retrying...');
    return 'retry';
  }
  if (/The following information is missing or erroneous/i.test(content)) {
    await bot.sendMessage(telegramChatId, '⚠️ Form error. Restarting...');
    await page.close();
    await browser.close();
    return 'restart';
  }

  await bot.sendMessage(telegramChatId, '✅ Booked successfully!');
  await browser.close();
  process.exit(0);
}

run();
