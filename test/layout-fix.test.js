'use strict';
/*
 * Checks theme.js's pane layout fix against mock pages that reserve sidebar
 * space in different ways. Needs Playwright: `node test/layout-fix.test.js`.
 */
const assert = require('node:assert/strict');
const T = require('../theme.js');
const { chromium } = require('playwright');

const css = '.dframe-sidebar{display:none!important} body{margin:0} .wrap{min-height:100vh}';
const box = '<fieldset style="margin:40px auto;width:600px;height:80px"></fieldset>';
const PAGES = {
  'margin on the chat column':
    `<div class="wrap"><nav class="dframe-sidebar" style="position:fixed;width:288px"></nav>
     <main style="margin-left:288px">${box}</main></div>`,
  'padding on the parent':
    `<div class="wrap" style="padding-left:260px"><nav class="dframe-sidebar"></nav><main>${box}</main></div>`,
  'positioned column':
    `<div class="wrap" style="position:relative"><nav class="dframe-sidebar"></nav>
     <main style="position:absolute;left:300px;right:0;top:0">${box}</main></div>`,
  'empty spacer element':
    `<div class="wrap" style="display:flex"><nav class="dframe-sidebar"></nav><div style="width:288px;flex:none"></div>
     <main style="flex:1">${box}</main></div>`,
  'column sized to the remaining width':
    `<div class="wrap"><nav class="dframe-sidebar"></nav><main style="margin-left:288px;width:calc(100% - 288px)">${box}</main></div>`
};
const REAL_PANEL =
  `<div class="wrap" style="display:flex"><nav class="dframe-sidebar"></nav>
   <aside style="width:240px;flex:none;background:#ccc"><button>project files</button></aside>
   <main style="flex:1">${box}</main></div>`;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
  const boxCentreOffset = () => page.evaluate(() => {
    const r = document.querySelector('fieldset').getBoundingClientRect();
    return Math.round(r.left + r.width / 2 - innerWidth / 2);
  });
  const settle = () => page.waitForTimeout(120);
  let passed = 0;

  for (const [name, html] of Object.entries(PAGES)) {
    await page.setContent(`<style>${css}</style>${html}`);
    assert.notEqual(await boxCentreOffset(), 0, name + ': mock should start off-centre');
    await page.evaluate(T.paneScript({ hideClaudeSidebar: true }));
    await settle();
    assert.equal(await boxCentreOffset(), 0, name + ': message box should be centred');

    // Simulate claude.ai redrawing the column: the fix should hold.
    await page.evaluate(() => { const f = document.querySelector('fieldset'); f.replaceWith(f.cloneNode()); });
    await settle();
    assert.equal(await boxCentreOffset(), 0, name + ': stays centred after a redraw');

    // Turning the setting off restores claude.ai's own layout.
    await page.evaluate(T.paneScript({ hideClaudeSidebar: false }));
    await settle();
    if (name !== 'empty spacer element') {
      assert.notEqual(await boxCentreOffset(), 0, name + ': reverts when switched off');
    }
    passed++; console.log('ok', name);
  }

  await page.setContent(`<style>${css}</style>${REAL_PANEL}`);
  const before = await boxCentreOffset();
  await page.evaluate(T.paneScript({ hideClaudeSidebar: true }));
  await settle();
  assert.equal(await boxCentreOffset(), before, 'a real left panel must not be removed');
  assert.ok(await page.isVisible('aside'));
  passed++; console.log('ok leaves a real left-hand panel alone');

  await page.setContent(`<style>${css}</style>${PAGES['margin on the chat column']}`);
  await page.evaluate(T.paneScript({ hideClaudeSidebar: true }));
  await settle();
  const report = await page.evaluate(T.layoutReportScript());
  assert.match(report, /fixes applied: margin-left on <main/);
  passed++; console.log('ok layout report describes the fix');

  await browser.close();
  console.log(`\n${passed} layout checks passed`);
})().catch((err) => { console.error(err); process.exit(1); });
