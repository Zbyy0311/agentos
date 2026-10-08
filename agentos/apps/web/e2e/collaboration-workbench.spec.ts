import { test, expect } from '@playwright/test';

test('workspace shell renders without browser or network errors', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() >= 500) errors.push(`${response.status()} ${response.url()}`); });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
    } else if (request.method() === 'GET' && path === '/api/workspaces') {
      await route.fulfill({ json: { workspaces: [] }, headers: { 'Access-Control-Allow-Origin': '*' } });
    } else {
      errors.push(`Unexpected fixture request: ${request.method()} ${path}`);
      await route.fulfill({ status: 400, json: { error: 'fixture rejects business API traffic' } });
    }
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/$/);
  await expect(page).toHaveTitle('AgentOS');
  await expect(page.locator('[data-signal-home]')).toBeVisible();
  await expect(page.getByRole('heading', { name: '把每个项目，整理成一个可以工作的空间。' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '还没有工作区' })).toBeVisible();
  await expect(page.locator('nextjs-portal')).toHaveCount(0);
  await page.getByRole('button', { name: '新建工作区' }).click();
  await expect(page.getByRole('heading', { name: '建立一个新的工作区' })).toBeVisible();
  await expect(page.getByRole('button', { name: '创建工作区', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('heading', { name: '建立一个新的工作区' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('home.png'), fullPage: false });
  expect(errors).toEqual([]);
});
