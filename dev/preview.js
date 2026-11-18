'use strict';
/*
 * Opens the shell in Chromium with the preview stand-in and exercises it.
 * Usage: node dev/preview.js [out-dir]   (needs the playwright package)
 */
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');

(async () => {
  const out = process.argv[2] || path.join(__dirname, 'out');
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript({ path: path.join(__dirname, 'preview-mock.js') });
  await page.goto('file://' + path.join(__dirname, '..', 'shell', 'index.html'));
  await page.waitForTimeout(3200); // shell asks for chats after 2.5s

  const report = {};
  const layout = () => page.evaluate(() => window.__previewLayout.map((r) => [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]));
  report.initialLayout = await layout();
  report.sidebarRows = await page.locator('.chat-row').count();
  report.openBadges = await page.locator('.chat-row.is-open .badge').allTextContents();
  await page.screenshot({ path: path.join(out, 'shell-light.png') });

  await page.click('#btn-split');
  await page.waitForTimeout(200);
  report.afterSplit = await layout();
  report.splitDisabledWhenFull = await page.locator('#btn-split').isDisabled();

  await page.locator('.pane').nth(0).locator('[aria-label="Close pane"]').click();
  await page.waitForTimeout(200);
  report.afterClose = await layout();

  await page.click('.palette-tile:nth-child(4) .palette');
  await page.waitForTimeout(200);
  report.darkGround = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ground'));
  await page.screenshot({ path: path.join(out, 'shell-dark.png') });

  await page.fill('#pick-accent', '#2f6bff');
  await page.waitForTimeout(200);
  report.accentAfterPick = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent'));

  await page.click('#close-appearance');
  await page.waitForTimeout(200);
  report.afterDrawerClosed = await layout();

  await page.setViewportSize({ width: 760, height: 700 });
  await page.waitForTimeout(250);
  report.narrowLayout = await layout();
  report.bodyScrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);

  report.errors = errors;
  console.log(JSON.stringify(report, null, 1));
  await browser.close();
})();
