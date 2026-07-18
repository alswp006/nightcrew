import { test, expect } from '@playwright/test';

// smoke 수준(§3.2): 렌더링 + 콘솔 에러 + 핵심 화면 도달만.
// 제목의 "scope: 설명" 규약이 error_signature(§4)의 scope가 된다.

test('main: 페이지가 렌더링되고 콘솔 에러가 없다', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));

  await page.goto('/');
  await expect(page.locator('h1')).toBeVisible();
  expect(errors).toEqual([]);
});

test('result: 핵심 화면에 도달한다', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#result')).toBeVisible();
});
