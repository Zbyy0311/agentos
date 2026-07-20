import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test, expect } from '@playwright/test';

test('workspace shell renders without browser or network errors', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() >= 500) errors.push(`${response.status()} ${response.url()}`); });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toBeVisible();
  const screenshotDirectory = resolve(process.cwd(), '.agentos', 'acceptance', 'collaboration-workbench');
  mkdirSync(screenshotDirectory, { recursive: true });
  await page.screenshot({
    path: join(screenshotDirectory, `${testInfo.project.name}.png`),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
