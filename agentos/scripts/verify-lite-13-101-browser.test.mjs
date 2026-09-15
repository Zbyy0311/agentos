import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { test } from 'node:test';
import { chromium } from '../apps/web/node_modules/@playwright/test/index.mjs';

const URL = 'http://127.0.0.1:3125/workspace/browser-fixture-ws/runtime';
const TARGET_ID = 'conv_01M2H0DCGDH5CQNP1KYTFZR537';
const SCREENSHOT = 'C:\\Users\\Administrator\\AppData\\Local\\Temp\\agentos-lite-13-101-qa\\wide-after.png';

let browser;
let page;
let selected;
let inspectorText = '';
const requestFailures = [];
const expectedAborts = [];

test.before(async () => {
  mkdirSync('C:\\Users\\Administrator\\AppData\\Local\\Temp\\agentos-lite-13-101-qa', { recursive: true });
  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
  page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('console', message => {
    if (message.type() === 'error') requestFailures.push(`console:${message.text()}`);
  });
  page.on('pageerror', error => requestFailures.push(`page:${error.message}`));
  page.on('requestfailed', request => {
    const errorText = request.failure()?.errorText ?? '';
    if (errorText === 'net::ERR_ABORTED') expectedAborts.push(request.url());
    else requestFailures.push(`request:${request.url()}:${errorText}`);
  });
  page.on('response', response => {
    if (response.status() >= 500) requestFailures.push(`http:${response.status()} ${response.url()}`);
  });

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 10_000 });
  const buttons = page.locator('section[data-column=conversations] button[data-conversation]');
  await buttons.first().waitFor({ state: 'visible', timeout: 10_000 });
  const conversations = await buttons.evaluateAll(items => items.map((button, index) => ({
    index,
    id: button.getAttribute('data-conversation'),
    text: button.innerText,
  })));
  selected = conversations.find(item => item.id === TARGET_ID);
  if (selected === undefined) throw new Error('target conversation not found');
  await buttons.nth(selected.index).dispatchEvent('click');

  const inspector = page.locator('section[aria-label="Inspector"] section[aria-label="Run Inspector"]');
  await inspector.waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForFunction(() => document.querySelector('section[aria-label="Inspector"] section[aria-label="Run Inspector"]')?.textContent?.toLocaleLowerCase().includes('compaction'), undefined, { timeout: 10_000 });
  inspectorText = await inspector.innerText();
  await page.screenshot({ path: SCREENSHOT, fullPage: false });
});

test.after(async () => {
  console.log(`browser screenshot=${SCREENSHOT}`);
  console.log(`browser expected-aborts=${expectedAborts.length}`);
  await browser?.close();
});

test('LITE-13-101 browser page identity and selected conversation', async () => {
  assert.equal(await page.title(), 'AgentOS');
  assert.equal(page.url(), URL);
  assert.equal(selected?.id, TARGET_ID);
});

test('LITE-13-101 browser renders the Run Inspector compaction section', () => {
  assert.match(inspectorText, /COMPACTION/);
  assert.match(inspectorText, /adopted by/i);
});

test('LITE-13-101 browser explains trigger policy and budget', () => {
  assert.match(inspectorText, /policy\s+lite-v1/i);
  assert.match(inspectorText, /trigger\s+1872\s+\/\s+2000\s+tokens/i);
  assert.match(inspectorText, /budget source\s+lite-v1-fallback/i);
  assert.match(inspectorText, /estimator\s+lite-v1-chars4/i);
});

test('LITE-13-101 browser explains source summary attempts and adoption snapshots', () => {
  assert.match(inspectorText, /source\s+3 messages\s+·\s+msg_/i);
  assert.match(inspectorText, /summary\s+用户提供了三条历史消息/iu);
  assert.match(inspectorText, /attempts\s+1/i);
  assert.match(inspectorText, /adopted by\s+snapshot\s+snapshot_/i);
});

test('LITE-13-101 browser has no unexplained application errors', () => {
  assert.deepEqual(requestFailures, []);
});
