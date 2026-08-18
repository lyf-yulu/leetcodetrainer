/**
 * Browser E2E for the AI-coach paths (requires config.json with a working key):
 *   补全用例 -> 错误提交得到诊断 -> 错题本落笔记 -> 正确提交得到点评 -> 追问
 */
import { chromium } from 'playwright-core';

const BASE = 'http://127.0.0.1:8080';
let passed = 0;
const failures = [];

const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(page, fn, re, timeout = 120000, label = '') {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeout) {
    try {
      last = await fn();
      if (re.test(String(last ?? ''))) return last;
    } catch { /* not ready */ }
    await sleep(400);
  }
  throw new Error(`timeout waiting ${re}${label ? ' (' + label + ')' : ''}; got: ${String(last).slice(0, 300)}`);
}

const waitText = (page, sel, re, timeout, label) =>
  waitFor(page, () => page.textContent(sel).catch(() => ''), re, timeout, label);
const waitEditor = (page, re, timeout, label) =>
  waitFor(page, () => page.evaluate(() => window.monaco?.editor?.getModels()[0]?.getValue() ?? ''), re, timeout, label);
const setEditor = (page, code) =>
  page.evaluate((c) => window.monaco.editor.getModels()[0].setValue(c), code);

async function test(name, fn, timeout = 240000) {
  try {
    await Promise.race([
      fn(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('test timeout')), timeout)),
    ]);
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  ✗ ${name}\n      ${String(err.message).split('\n').join('\n      ')}`);
  }
}

const PY_WRONG = `class Solution:
    def twoSum(self, nums, target):
        return [0, 0]
`;

const PY_GOOD = `class Solution:
    def twoSum(self, nums, target):
        seen = {}
        for i, x in enumerate(nums):
            if target - x in seen:
                return [seen[target - x], i]
            seen[x] = i
        return []
`;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 600)));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 300));
});
page.on('requestfailed', (r) => console.log('[requestfailed]', r.url(), r.failure()?.errorText));

// Instrument /api/ai traffic for the diagnosis path.
let aiCalls = 0;
await page.route('**/api/ai', async (route) => {
  const req = route.request();
  let tag = '';
  try {
    const b = JSON.parse(req.postData());
    tag = (b.messages?.[b.messages.length - 1]?.content || '').slice(0, 50).replace(/\n/g, ' ');
  } catch { tag = '?'; }
  aiCalls++;
  const n = aiCalls;
  console.log(`>>> ai#${n} (json=${JSON.parse(req.postData()).responseFormat ? 1 : 0}): ${tag}`);
  const t0 = Date.now();
  try {
    const resp = await route.fetch();
    const text = await resp.text();
    console.log(`<<< ai#${n} HTTP ${resp.status()} in ${Date.now() - t0}ms: ${text.slice(0, 120).replace(/\n/g, ' ')}`);
    await route.fulfill({ response: resp, body: text });
  } catch (err) {
    console.log(`<<< ai#${n} FAILED: ${err.message.slice(0, 150)}`);
    await route.continue();
  }
});

await test('补全用例：AI 生成期望值，状态提示「用例就绪」', async () => {
  await page.goto(BASE, { waitUntil: 'load' });
  await page.fill('#slug', 'two-sum');
  await page.click('#load');
  await waitText(page, '.p-title', /Two Sum/, 30000, 'title');
  await waitEditor(page, /def twoSum/, 30000, 'template');
  await page.click('#btn-gen-tests');
  await waitText(page, '#run-status', /用例就绪/, 180000, 'AI testcase gen');
  const status = await page.textContent('#run-status');
  const m = status.match(/用例就绪：(\d+) 个（(\d+) 个有期望值）/);
  ok(m && Number(m[1]) > 0 && Number(m[2]) === Number(m[1]), `期望值应全部生成: ${status}`);
});

await test('错误提交 → AI 诊断卡片（思路判断 + 错因，内容为中文）', async () => {
  await setEditor(page, PY_WRONG);
  await page.click('#btn-submit');
  await waitText(page, '.verdict', /答案错误/, 60000, 'wrong verdict');
  // wait for the FINAL diagnosis header, not the loading text
  await waitText(page, '#result-pane', /思路正确，实现有 bug|思路需要调整/, 120000, 'AI diagnosis');
  const slot = (await page.textContent('#coach-slot')) || '';
  ok(/[一-鿿]{4,}/.test(slot), `教练卡内容应为中文: ${slot.slice(0, 200)}`);
  ok(!/\bThe (function|code|solution)\b/i.test(slot), `不应出现英文正文: ${slot.slice(0, 200)}`);
}, 300000);

await test('错题本：失败自动落一条笔记', async () => {
  // the note is written right after the diagnosis renders — give it a moment
  await waitFor(page, async () => {
    const d = await page.evaluate(() => fetch('/api/state/notes').then((r) => r.json()));
    return Object.keys(d).length ? 'has-note' : '';
  }, /has-note/, 30000, 'note persisted');
  try {
    await page.click('#btn-notes');
    await waitText(page, '#notes-body', /教训|触发场景/, 20000, 'note content');
    const notes = (await page.textContent('#notes-body')) || '';
    ok(/Two Sum/.test(notes), `笔记应关联 Two Sum: ${notes.slice(0, 300)}`);
  } finally {
    // always close the overlay, even on assertion failure, so later tests run
    await page.evaluate(() => document.querySelectorAll('.overlay.show').forEach((o) => o.classList.remove('show')));
    await sleep(300);
  }
});

await test('正确提交 → 全部通过 + AI 点评（复杂度分析）', async () => {
  // Decouple the review path from AI test-data quality: swap in deterministic
  // expected values (the AI-generated set can contain a multi-answer edge case
  // without the multipleValid flag, which no correct solution can guarantee
  // to satisfy). The AI generation path itself is validated above.
  await page.evaluate(() => {
    localStorage.setItem('lct:tests:two-sum', JSON.stringify([
      { input: [[2, 7, 11, 15], 9], expected: [0, 1], orderInsensitive: true },
      { input: [[3, 2, 4], 6], expected: [1, 2], orderInsensitive: true },
      { input: [[3, 3], 6], expected: [0, 1], orderInsensitive: true },
    ]));
  });
  await page.click('#load');
  await waitText(page, '.p-title', /Two Sum/, 30000, 'reload deterministic');
  await waitEditor(page, /twoSum/, 30000, 'editor ready');
  await setEditor(page, PY_GOOD);
  await page.click('#btn-submit');
  await waitText(page, '.verdict', /全部通过/, 60000, 'pass verdict');
  await waitText(page, '#result-pane', /AI 点评/, 120000, 'AI review');
  const pane = (await page.textContent('#result-pane')) || '';
  ok(/复杂度|时间/.test(pane), `点评应含复杂度: ${pane.slice(0, 300)}`);
});

await test('追问：聊天框得到 AI 回复', async () => {
  await page.fill('#chat-input', '我的解法时间复杂度是多少?一句话');
  await page.click('#chat-send');
  await waitFor(page, async () => {
    const msgs = await page.$$eval('#chat-log .msg.ai', (els) => els.map((e) => e.textContent));
    return msgs.join('\n');
  }, /O\(/, 120000, 'chat answer');
  console.log('      AI 回复摘录:', (await page.$$eval('#chat-log .msg.ai', (els) => els.map((e) => e.textContent))).pop().slice(0, 80));
});

await test('进度面板：AI 判定后记录正确', async () => {
  await page.click('#btn-progress');
  await waitText(page, '#progress-body', /Two Sum/, 10000, 'progress row');
  const body = (await page.textContent('#progress-body')) || '';
  ok(/勉强过|已通过|已掌握/.test(body), `进度应有通过态: ${body.slice(0, 300)}`);
});

await browser.close();

console.log(`\n结果：${passed} 通过, ${failures.length} 失败\n`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.err.message.split('\n')[0]}`);
  process.exit(1);
}
