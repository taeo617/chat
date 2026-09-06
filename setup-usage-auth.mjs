/**
 * 최초 1회 실행: 브라우저 창이 열리면 claude.ai에 직접 로그인하세요.
 * 로그인이 완료되면 세션이 저장되어, 이후 서버가 자동으로 사용량을 가져올 수 있습니다.
 *
 * 실행: node setup-usage-auth.mjs
 */
import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const ROOT = dirname(fileURLToPath(import.meta.url));
const AUTH_FILE = join(ROOT, '.auth', 'claude-session.json');

await mkdir(join(ROOT, '.auth'), { recursive: true });

console.log('브라우저가 열립니다. claude.ai에 로그인해주세요...');
console.log('로그인 완료 후, 사용량 페이지(claude.ai/account/usage)가 보이면 이 터미널로 돌아와 Enter를 누르세요.\n');

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();

await page.goto('https://claude.ai/login');

/* Wait for user to press Enter in terminal */
await new Promise((resolve) => {
  process.stdin.once('data', resolve);
});

/* Save the session state (cookies + localStorage) */
await context.storageState({ path: AUTH_FILE });
console.log(`\n✅ 세션이 저장되었습니다: ${AUTH_FILE}`);
console.log('이제 서버가 자동으로 로그인된 세션을 사용해 사용량을 가져올 수 있습니다.');

await browser.close();
process.exit(0);
