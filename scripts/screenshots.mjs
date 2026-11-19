// Regenerates docs/*.png from the live demo. Exits non-zero on any console error.
// Uses a globally installed Playwright: npm i -g playwright (or run where it is available).
import { createRequire } from 'node:module';
import { server } from './serve.mjs';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require(require.resolve('playwright', { paths: [process.env.NODE_PATH || '', '/usr/lib/node_modules', '/usr/local/lib/node_modules'] })); }

await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await playwright.chromium.launch();
const errors = [];

async function shot(name, query, { width = 1440, height = 1000, device, clip, selector, scrollTo, fullPage = false } = {}) {
  const context = device ? await browser.newContext({ ...playwright.devices[device] }) : await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(base + query);
  await page.waitForFunction(() => window.__ready === true);
  await page.waitForTimeout(400);
  const path = `docs/${name}.png`;
  if (scrollTo) { await page.locator(scrollTo).evaluate((el) => el.scrollIntoView()); await page.waitForTimeout(200); }
  if (selector) await page.locator(selector).screenshot({ path });
  else await page.screenshot({ path, fullPage, clip });
  await context.close();
  console.log('saved', path);
}

await shot('overview', '?run=booking', { height: 1060 });
await shot('gas-emergency', '?run=gas', { selector: 'main' });
await shot('double-booking', '?script=' + encodeURIComponent('boiler service|LS6|Ann Lee|07700 900111|yes|tomorrow') + '&steal=1&then=yes', { selector: 'main' });
await shot('invented-price', '?liar=1&script=' + encodeURIComponent('how much is a boiler service'), { selector: '.phone' });
await shot('measured', '', { selector: 'section.proof' });
await shot('mobile', '?run=vulnerable', { device: 'iPhone 13', scrollTo: '.phone' });

await browser.close();
server.close();
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
