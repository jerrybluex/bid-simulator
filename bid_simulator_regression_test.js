const assert = require('assert');
const path = require('path');
const { chromium } = require('playwright');

const target = process.argv[2] || path.resolve(__dirname, 'bid_simulator.html');

async function withPage(fn) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await page.goto('file:///' + path.resolve(target).replace(/\\/g, '/'), { waitUntil: 'domcontentloaded', timeout: 15000 });
  page.setDefaultTimeout(5000);
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

async function reviewRows(page) {
  return page.locator('#reviewTable tbody tr').evaluateAll(trs =>
    trs.map(tr => {
      const tds = tr.querySelectorAll('td');
      return {
        name: tds[0].textContent.trim(),
        price: tds[1].textContent.trim(),
        trigger: tds[2].textContent.trim().replace(/\s+/g, ' '),
        risk: tds[3].textContent.trim()
      };
    })
  );
}

// ---- 参考版原有测试 ----

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
    assert.ok(dialogs.some(m => m.includes('报价必须大于 0')));
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
    assert.ok(firstCardText.includes('重点审查'), '同名低报价投标人应保留自己的风险标记');
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

// ---- 本次新增：针对线上问题 ----

// 回归：44/45/66/65.8 + 限价66.8，44 和 45 必须触发
async function testUserScenarioTriggersLowBidReview() {
  await withPage(async page => {
    await page.locator('#maxPrice').fill('66.8');
    await setRows(page, [
      { name: 'A', price: 44 },
      { name: 'B', price: 45 },
      { name: 'C', price: 66 },
      { name: 'D', price: 65.8 },
    ]);
    await page.locator('#calcBtn').click();

    const rows = await reviewRows(page);
    assert.strictEqual(rows.length, 4);
    assert.ok(rows[0].risk.includes('重点审查'), '44万 应触发重点审查，实际: ' + rows[0].risk);
    assert.ok(rows[1].risk.includes('重点审查'), '45万 应触发重点审查，实际: ' + rows[1].risk);
    assert.ok(rows[2].risk.includes('正常'), '66万 不应触发，实际: ' + rows[2].risk);
    assert.ok(rows[3].risk.includes('正常'), '65.8万 不应触发，实际: ' + rows[3].risk);

    const stats = await page.locator('.stat-box .val').allInnerTexts();
    assert.strictEqual(stats[0], '55.20', '均价');
    assert.strictEqual(stats[1], '45.00', '次低价');
    assert.strictEqual(stats[2], '44.00', '最低价');
    assert.strictEqual(stats[3], '2', '高风险数');
  });
}

// 触发线必须显式显示，且数值正确
async function testTriggerLinesAreVisibleAndCorrect() {
  await withPage(async page => {
    await page.locator('#maxPrice').fill('66.8');
    await setRows(page, [
      { name: 'A', price: 44 },
      { name: 'B', price: 45 },
      { name: 'C', price: 66 },
      { name: 'D', price: 65.8 },
    ]);
    await page.locator('#calcBtn').click();
    const box = await page.locator('#triggerBox').innerText();
    assert.ok(box.includes('48.58'), '触发线①应为 48.58，实际: ' + box);
    assert.ok(box.includes('42.75'), '触发线②应为 42.75，实际: ' + box);
    assert.ok(box.includes('46.76'), '触发线③应为 46.76，实际: ' + box);
  });
}

// 保存历史并能读回
async function testSaveAndReloadHistory() {
  await withPage(async page => {
    await page.locator('#calcBtn').click();
    await page.locator('#roundName').fill('测试轮次');
    await page.locator('#saveBtn').click();
    assert.strictEqual(await page.locator('.hist-item').count(), 1);
    const chipText = await page.locator('.hist-score-chip').first().innerText();
    assert.ok(chipText.includes('分'));
  });
}

// 加载历史能还原参数
async function testLoadHistoryRestoresInputs() {
  await withPage(async page => {
    await page.locator('#maxPrice').fill('66.8');
    await setRows(page, [
      { name: 'A', price: 44 },
      { name: 'B', price: 45 },
      { name: 'C', price: 66 },
      { name: 'D', price: 65.8 },
    ]);
    await page.locator('#calcBtn').click();
    await page.locator('#roundName').fill('可回溯轮次');
    await page.locator('#saveBtn').click();
    await page.locator('.btn-load').first().click();
    await page.waitForTimeout(500);
    assert.strictEqual(await page.locator('#maxPrice').inputValue(), '66.8');
    const prices = await page.locator('#bidders input.price').evaluateAll(ins => ins.map(i => i.value));
    assert.deepStrictEqual(prices, ['44', '45', '66', '65.8']);
  });
}

// 评标价偏离扣分法：≤5家取全部均值，>5家去极值均值，双向不对称扣分
async function testEvalPriceRuleWithFiveOrFewBidders() {
  await withPage(async page => {
    await page.locator('.rule-tab[data-rule="eval"]').click();
    await setRows(page, [
      { name: 'A', price: 40 },
      { name: 'B', price: 45 },
      { name: 'C', price: 50 },
      { name: 'D', price: 55 },
      { name: 'E', price: 60 },
    ]);
    await page.locator('#calcBtn').click();

    // Q = (40+45+50+55+60)/5 = 50
    const scores = await page.locator('.score-card .score-big').allInnerTexts();
    const byName = {};
    const names = await page.locator('.score-card .score-name').allInnerTexts();
    names.forEach((n, i) => { byName[n.trim()] = parseFloat(scores[i]); });

    assert.ok(Math.abs(byName['C'] - 30) < 0.0005, '报价等于Q应得30分，实际 ' + byName['C']);
    // A=40，低于Q 20%：30 - (10/50)*100*0.1 = 30 - 2 = 28
    assert.ok(Math.abs(byName['A'] - 28) < 0.0005, 'A 应得28分，实际 ' + byName['A']);
    // E=60，高于Q 20%：30 - (10/50)*100*0.2 = 30 - 4 = 26
    assert.ok(Math.abs(byName['E'] - 26) < 0.0005, 'E 应得26分，实际 ' + byName['E']);
    // B=45，低于10%：30 - (5/50)*100*0.1 = 29
    assert.ok(Math.abs(byName['B'] - 29) < 0.0005, 'B 应得29分，实际 ' + byName['B']);
    // D=55，高于10%：30 - (5/50)*100*0.2 = 28
    assert.ok(Math.abs(byName['D'] - 28) < 0.0005, 'D 应得28分，实际 ' + byName['D']);
  });
}

async function testEvalPriceRuleTrimsWhenMoreThanFiveBidders() {
  await withPage(async page => {
    await page.locator('.rule-tab[data-rule="eval"]').click();
    await setRows(page, [
      { name: 'A', price: 10 },
      { name: 'B', price: 20 },
      { name: 'C', price: 30 },
      { name: 'D', price: 40 },
      { name: 'E', price: 50 },
      { name: 'F', price: 60 },
      { name: 'G', price: 70 },
    ]);
    await page.locator('#calcBtn').click();

    // 6家：Q = (20+30+40+50+60)/5 = 40
    const scores = await page.locator('.score-card .score-big').allInnerTexts();
    const names = await page.locator('.score-card .score-name').allInnerTexts();
    const byName = {};
    names.forEach((n, i) => { byName[n.trim()] = parseFloat(scores[i]); });

    assert.ok(Math.abs(byName['D'] - 30) < 0.0005, 'D(=Q=40) 应得30分，实际 ' + byName['D']);
    // A=10，低于Q 75%：30 - (30/40)*100*0.1 = 30 - 7.5 = 22.5
    assert.ok(Math.abs(byName['A'] - 22.5) < 0.0005, 'A 应得22.5分，实际 ' + byName['A']);
    // G=70，高于Q 75%：30 - (30/40)*100*0.2 = 30 - 15 = 15
    assert.ok(Math.abs(byName['G'] - 15) < 0.0005, 'G 应得15分，实际 ' + byName['G']);

    // 元信息里应显示评标价 40
    const meta = await page.locator('#scoreMeta').innerText();
    assert.ok(meta.includes('40.000'), '元信息应显示评标价Q=40，实际: ' + meta);
    assert.ok(meta.includes('去掉一个最高和一个最低'), '应标明评标价口径');
  });
}

async function testEvalPriceScoreNeverNegativeAndKeepsThreeDecimals() {
  await withPage(async page => {
    await page.locator('.rule-tab[data-rule="eval"]').click();
    await setRows(page, [
      { name: 'A', price: 1 },
      { name: 'B', price: 100 },
    ]);
    await page.locator('#calcBtn').click();
    const scores = await page.locator('.score-card .score-big').allInnerTexts();
    scores.forEach(s => { assert.ok(parseFloat(s) >= 0, '得分不得为负: ' + s); });
    // A=1, Q=50.5: 30 - (49.5/50.5)*100*0.1 = 30 - 9.802 = 20.198
    const names = await page.locator('.score-card .score-name').allInnerTexts();
    const byName = {};
    names.forEach((n, i) => { byName[n.trim()] = scores[i]; });
    assert.ok(byName['A'].includes('20.198'), 'A 应显示3位小数 20.198，实际 ' + byName['A']);
  });
}

(async () => {
  const tests = [
    testRuleExplanationIsVisible,
    testRejectsZeroPrices,
    testEscapesUserNamesInRenderedHtml,
    testDuplicateNamesKeepTheirOwnRisk,
    testManualPressureRoundsCompareBAndC,
    testUserScenarioTriggersLowBidReview,
    testTriggerLinesAreVisibleAndCorrect,
    testSaveAndReloadHistory,
    testLoadHistoryRestoresInputs,
    testEvalPriceRuleWithFiveOrFewBidders,
    testEvalPriceRuleTrimsWhenMoreThanFiveBidders,
    testEvalPriceScoreNeverNegativeAndKeepsThreeDecimals,
  ];
  for (const t of tests) {
    await t();
    console.log('  ✓ ' + t.name);
  }
  console.log('\nregression tests passed (' + tests.length + ')');
})().catch(error => {
  console.error('FAILED:', error.message);
  process.exit(1);
});
