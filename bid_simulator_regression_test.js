const assert = require('assert');
const path = require('path');
const { chromium } = require('playwright');

const target = process.argv[2] || 'C:/Users/MLTZ/Downloads/bid_simulator.html';

async function withPage(fn) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await page.goto('file:///' + path.resolve(target).replace(/\\/g, '/'), { waitUntil: 'domcontentloaded', timeout: 10000 });
  page.setDefaultTimeout(3000);
  try {
    await fn(page, errors);
  } finally {
    await browser.close();
  }
}

async function setRows(page, rows) {
  const current = await page.locator('#bidders .bidder-row').count();
  for (let i = current; i < rows.length; i++) {
    await page.locator('#addBtn').click();
  }
  for (let i = current; i > rows.length; i--) {
    await page.locator('#bidders .bidder-row').nth(i - 1).locator('.btn-del').click();
  }
  for (let i = 0; i < rows.length; i++) {
    const row = page.locator('#bidders .bidder-row').nth(i);
    await row.locator('.name').fill(rows[i].name);
    await row.locator('.price').fill(String(rows[i].price));
  }
}

async function testRejectsZeroPrices() {
  await withPage(async page => {
    const dialogs = [];
    page.on('dialog', async dialog => {
      dialogs.push(dialog.message());
      await dialog.dismiss();
    });
    await setRows(page, [
      { name: 'A', price: 0 },
      { name: 'B', price: 10 },
    ]);
    await page.locator('#calcBtn').click();
    assert.ok(dialogs.some(message => message.includes('报价必须大于 0')));
    assert.strictEqual(await page.locator('#resultSection').evaluate(el => getComputedStyle(el).display), 'none');
  });
}

async function testEscapesUserNamesInRenderedHtml() {
  await withPage(async page => {
    await setRows(page, [
      { name: '<img src=x onerror="window.__xss=1">', price: 9 },
      { name: 'B', price: 10 },
    ]);
    await page.locator('#calcBtn').click();
    assert.strictEqual(await page.evaluate(() => window.__xss), undefined);
    assert.strictEqual(await page.locator('.score-card img').count(), 0);
  });
}

async function testDuplicateNamesKeepTheirOwnRisk() {
  await withPage(async page => {
    await setRows(page, [
      { name: '同名', price: 100 },
      { name: '同名', price: 1 },
    ]);
    await page.locator('#calcBtn').click();
    const firstCardText = await page.locator('.score-card').first().innerText();
    assert.ok(firstCardText.includes('重点审查'));
  });
}

async function testManualPressureRoundsCompareBAndC() {
  await withPage(async page => {
    await page.locator('#pressureA').selectOption({ index: 0 });
    await page.locator('#pressureB').selectOption({ index: 1 });
    await page.locator('#pressureC').selectOption({ index: 2 });
    await page.locator('#pressurePrice').fill('40');
    await page.locator('#addPressureBtn').click();

    assert.strictEqual(await page.locator('#pressureRows tr').count(), 1);
    const rowText = await page.locator('#pressureRows tr').first().innerText();
    assert.ok(rowText.includes('40.00'));
    assert.ok(rowText.includes('+3.33'));
    assert.ok(rowText.includes('投标人C'));
  });
}

async function testRuleExplanationIsVisible() {
  await withPage(async page => {
    const text = await page.locator('#ruleExplain').innerText();
    assert.ok(text.includes('最低价法'));
    assert.ok(text.includes('加权得分'));
    assert.ok(text.includes('低价审查'));
  });
}

async function testSavedHistoryClearsAfterRefresh() {
  await withPage(async page => {
    await page.locator('#calcBtn').click();
    await page.locator('#roundName').fill('temporary-round');
    await page.locator('#saveBtn').click();
    assert.strictEqual(await page.locator('.hist-item').count(), 1);

    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.strictEqual(await page.locator('.hist-item').count(), 0);
    const emptyText = await page.locator('#histList').innerText();
    assert.ok(emptyText.includes('暂无历史记录'));
  });
}

(async () => {
  await testRuleExplanationIsVisible();
  await testRejectsZeroPrices();
  await testEscapesUserNamesInRenderedHtml();
  await testDuplicateNamesKeepTheirOwnRisk();
  await testManualPressureRoundsCompareBAndC();
  await testSavedHistoryClearsAfterRefresh();
  console.log('regression tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
