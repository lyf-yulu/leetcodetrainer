/**
 * Real-browser end-to-end verification of leetcodetrainer.
 * Drives the installed Chrome (headless, via playwright-core — no browser
 * download) through the actual user flow: load problem -> edit -> run ->
 * custom-input debug -> submit -> progress overlay -> overlays/shortcuts.
 *
 * Optional dependency (the project itself stays zero-dep):
 *   mkdir -p /tmp/lct-e2e && cd /tmp/lct-e2e && npm init -y && npm i playwright-core
 *   ln -s /tmp/lct-e2e/node_modules tests/node_modules   # gitignored
 *   node tests/e2e-browser.mjs        # requires the server running on :8080
 * e2e-ai.mjs additionally requires config.json with a working AI key.
 */
import { chromium } from 'playwright-core';

const BASE = 'http://127.0.0.1:8080';
const errors = [];
let passed = 0;
const failures = [];

const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(page, fn, re, timeout = 45000, label = '') {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeout) {
    try {
      last = await fn();
      if (re.test(String(last ?? ''))) return last;
    } catch { /* element not ready yet */ }
    await sleep(250);
  }
  throw new Error(`timeout waiting ${re}${label ? ' (' + label + ')' : ''}; got: ${String(last).slice(0, 200)}`);
}

const waitText = (page, sel, re, timeout, label) =>
  waitFor(page, () => page.textContent(sel).catch(() => ''), re, timeout, label);
const waitEditor = (page, re, timeout, label) =>
  waitFor(page, () => page.evaluate(() => window.monaco?.editor?.getModels()[0]?.getValue() ?? ''), re, timeout, label);

const setEditor = (page, code) =>
  page.evaluate((c) => window.monaco.editor.getModels()[0].setValue(c), code);
const editorValue = (page) =>
  page.evaluate(() => window.monaco.editor.getModels()[0].getValue());

const PY_TWOSUM = `class Solution:
    def twoSum(self, nums, target):
        seen = {}
        for i, x in enumerate(nums):
            if target - x in seen:
                return [seen[target - x], i]
            seen[x] = i
        return []
`;

const PY_TWOSUM_PRINT = `class Solution:
    def twoSum(self, nums, target):
        print("LOG_MARKER")
        seen = {}
        for i, x in enumerate(nums):
            if target - x in seen:
                return [seen[target - x], i]
            seen[x] = i
        return []
`;

const PY_WRONG = `class Solution:
    def twoSum(self, nums, target):
        return [0, 0]
`;

const CPP_TWOSUM = `class Solution {
public:
  vector<int> twoSum(vector<int>& nums, int target) {
    unordered_map<int,int> seen;
    for (int i = 0; i < (int)nums.size(); i++) {
      if (seen.count(target - nums[i])) return {seen[target - nums[i]], i};
      seen[nums[i]] = i;
    }
    return {};
  }
};
`;

const CPP_TYPE_ERROR = `class Solution {
public:
  vector<int> twoSum(vector<int>& nums, int target) {
    std::string x = 42;
    return {};
  }
};
`;

const JAVA_TWOSUM = `class Solution {
  public int[] twoSum(int[] nums, int target) {
    HashMap<Integer,Integer> seen = new HashMap<>();
    for (int i = 0; i < nums.length; i++) {
      Integer j = seen.get(target - nums[i]);
      if (j != null) return new int[]{j, i};
      seen.put(nums[i], i);
    }
    return new int[]{};
  }
}
`;

const CPP_LRU = `class LRUCache {
  int cap;
  std::list<std::pair<int,int>> l;
  std::unordered_map<int, std::list<std::pair<int,int>>::iterator> m;
public:
  LRUCache(int capacity) : cap(capacity) {}
  int get(int key) {
    auto it = m.find(key);
    if (it == m.end()) return -1;
    l.splice(l.begin(), l, it->second);
    return it->second->second;
  }
  void put(int key, int value) {
    auto it = m.find(key);
    if (it != m.end()) { it->second->second = value; l.splice(l.begin(), l, it->second); return; }
    if ((int)l.size() == cap) { m.erase(l.back().first); l.pop_back(); }
    l.emplace_front(key, value);
    m[key] = l.begin();
  }
};
`;

async function test(name, fn, timeout) {
  try {
    await Promise.race([
      fn(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('test timeout')), timeout ?? 150000)),
    ]);
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  ✗ ${name}\n      ${String(err.message).split('\n').join('\n      ')}`);
  }
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
page.on('pageerror', (e) => {
  const first = (e.stack || '').split('\n').slice(0, 3).map((s) => s.trim()).join(' < ');
  errors.push(`pageerror: ${e.message} @ ${first}`);
});
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
});

console.log('\n1) 启动与加载\n');

await test('首页打开，环境徽章渲染，Pyodide 预热完成', async () => {
  await page.goto(BASE, { waitUntil: 'load' });
  await waitText(page, '#env-badges', /Python3/, 15000, 'badges');
  const badges = await page.textContent('#env-badges');
  ok(/C\+\+/.test(badges) && /Java/.test(badges) && /AI/.test(badges), `徽章不全: ${badges}`);
  // Warmup runs at boot; every Python test below needs the interpreter ready.
  // A fresh headless profile has no HTTP cache, so the ~10MB download can be
  // slow — wait for it rather than racing it.
  await waitText(page, '#run-status', /Python 就绪|Python ready/, 240000, 'pyodide warmup');
});

await test('加载 two-sum：题面 + Monaco 就绪 + 模板代码', async () => {
  await page.fill('#slug', 'two-sum');
  await page.click('#load');
  await waitText(page, '.p-title', /Two Sum/, 30000, 'title');
  await waitEditor(page, /def twoSum/, 30000, 'python template');
});

await test('中文题面：自动翻译渲染 + 语言切换', async () => {
  // translation is cached server-side, so zh renders on load; still wait for
  // CJK in case the first fetch is in flight
  await waitText(page, '.statement', /给定|数组/, 30000, 'zh statement');
  await waitText(page, '.p-title', /两数之和/, 30000, 'zh title');
  const btnText = await page.textContent('#btn-lang');
  ok(btnText === 'EN', `zh 视图下按钮应显示 EN，得到: ${btnText}`);
  await page.click('#btn-lang');
  await waitText(page, '.statement', /You are given an array|Given an array/, 10000, 'en statement');
  await page.click('#btn-lang');
  await waitText(page, '.statement', /给定|数组/, 10000, 'back to zh');
});

await test('题库：列表展示题号+题名，可搜索、点击加载', async () => {
  await page.click('#btn-list');
  await waitText(page, '#list-body', /Two Sum/, 30000, 'problem list loaded');
  const first = (await page.textContent('#list-body')) || '';
  ok(/1\.\s*Two Sum/.test(first), `列表应含 1. Two Sum，得到: ${first.slice(0, 200)}`);

  await page.fill('#list-search', 'lru');
  await waitText(page, '#list-body', /LRU Cache/, 5000, 'search lru');
  const filtered = (await page.textContent('#list-body')) || '';
  ok(!/Two Sum/.test(filtered), `搜索后不应再显示 Two Sum，得到: ${filtered.slice(0, 200)}`);

  await page.fill('#list-search', 'add two');
  await waitText(page, '#list-body', /Add Two Numbers/, 5000, 'search add two');
  await page.click('.pl-row[data-slug="add-two-numbers"]');
  await waitText(page, '.p-title', /Add Two Numbers/, 30000, 'loaded via list');
  const listShown = await page.$eval('#ov-list', (el) => el.classList.contains('show'));
  ok(!listShown, '加载题目后题库弹层应关闭');
  // load two-sum back for the following sections
  await page.fill('#slug', 'two-sum');
  await page.click('#load');
  await waitText(page, '.p-title', /Two Sum/, 30000, 'back to two-sum');
});

await test('顶栏智能解析：题号 / 题名 / 友好错误 / 会员题提示', async () => {
  await page.fill('#slug', '1');
  await page.click('#load');
  await waitText(page, '.p-title', /Two Sum/, 30000, 'by number');

  await page.fill('#slug', 'longest palindrome');
  await page.click('#load');
  await waitText(page, '.p-title', /Longest Palindrome/, 30000, 'by title');

  await page.fill('#slug', 'slug');
  await page.click('#load');
  await waitText(page, '#problem-pane', /没有找到题目/, 30000, 'friendly miss');

  await page.fill('#slug', 'binary-tree-upside-down');
  await page.click('#load');
  await waitText(page, '#problem-pane', /会员专享/, 30000, 'paid message');

  await page.fill('#slug', 'two-sum');
  await page.click('#load');
  await waitText(page, '.p-title', /Two Sum/, 30000, 'back to two-sum');
});

console.log('\n2) Python：运行示例 / 调试 / 日志\n');

await test('运行示例（无期望值）→ 已执行未判定 + 3 用例 + 输出可见', async () => {
  await setEditor(page, PY_TWOSUM);
  await page.click('#btn-run');
  await waitText(page, '.verdict', /已执行，未判定/, 90000, 'pyodide first run');
  const cases = await page.$$('.case');
  ok(cases.length === 3, `应 3 个用例，得到 ${cases.length}`);
  const first = (await page.textContent('#result-pane')) || '';
  ok(/\[0,1\]/.test(first), '用例输出应显示 [0,1]');
}, 180000);

await test('调试输入框：[[2,7,11,15],9] → 输出 [0,1]，不判对错', async () => {
  await page.fill('#custom-input', '[[2,7,11,15],9]');
  await page.click('#btn-custom');
  await waitText(page, '.verdict', /已执行，未判定/, 45000, 'custom py');
  const pane = (await page.textContent('#result-pane')) || '';
  ok(/\[0,1\]/.test(pane), `应显示输出 [0,1]，得到: ${pane.slice(0, 300)}`);
  ok(/调试完成/.test(await page.textContent('#run-status')), '状态应提示调试完成');
});

await test('调试：print 输出进入 log 字段', async () => {
  await setEditor(page, PY_TWOSUM_PRINT);
  await page.click('#btn-custom');
  await waitText(page, '.verdict', /已执行，未判定/, 45000, 'custom py print');
  const pane = (await page.textContent('#result-pane')) || '';
  ok(/LOG_MARKER/.test(pane), `log 应包含 LOG_MARKER，得到: ${pane.slice(0, 300)}`);
});

await test('调试：JSON 格式错误 → 明确弹窗提示', async () => {
  let dialog = null;
  page.once('dialog', (d) => { dialog = d.message(); d.dismiss(); });
  await page.fill('#custom-input', 'not json');
  await page.click('#btn-custom');
  await sleep(600);
  ok(dialog && /JSON 解析失败/.test(dialog), `应弹 JSON 错误，得到: ${dialog}`);
});

await test('调试：运行时异常 → 错误卡片带 traceback + AI 解析', async () => {
  await setEditor(page, `class Solution:\n    def twoSum(self, nums, target):\n        raise ValueError("boom")\n`);
  await page.fill('#custom-input', '[[2,7,11,15],9]');
  await page.click('#btn-custom');
  await waitText(page, '.verdict', /运行异常/, 45000, 'custom py error');
  const pane = (await page.textContent('#result-pane')) || '';
  ok(/boom/.test(pane), `traceback 应含 boom，得到: ${pane.slice(0, 400)}`);
  // 初学者场景：报错立即得到 AI 讲解，而非只有原始 traceback
  await waitText(page, '#result-pane', /含义：/, 60000, 'runtime AI coach');
  const coach = (await page.textContent('#result-pane')) || '';
  ok(/怎么修/.test(coach), `AI 卡片应含怎么修: ${coach.slice(-500)}`);
});

console.log('\n3) C++ / Java：切换语言 + 调试\n');

await test('切到 C++：模板 + 调试运行输出 [1,2]', async () => {
  await page.selectOption('#lang', 'cpp');
  await waitEditor(page, /vector<int> twoSum/, 15000, 'cpp template');
  await setEditor(page, CPP_TWOSUM);
  await page.fill('#custom-input', '[[3,2,4],6]');
  await page.click('#btn-custom');
  await waitText(page, '.verdict', /已执行，未判定/, 30000, 'custom cpp');
  const pane = (await page.textContent('#result-pane')) || '';
  ok(/\[1,2\]/.test(pane), `应显示 [1,2]，得到: ${pane.slice(0, 300)}`);
});

await test('切到 Java：模板 + 调试运行输出 [1,2]', async () => {
  await page.selectOption('#lang', 'java');
  await waitEditor(page, /int\[\] twoSum/, 15000, 'java template');
  await setEditor(page, JAVA_TWOSUM);
  await page.fill('#custom-input', '[[3,2,4],6]');
  await page.click('#btn-custom');
  await waitText(page, '.verdict', /已执行，未判定/, 30000, 'custom java');
  const pane = (await page.textContent('#result-pane')) || '';
  ok(/\[1,2\]/.test(pane), `应显示 [1,2]，得到: ${pane.slice(0, 300)}`);
});

await test('C++ 类型错误 → 编译错误卡片 + 行号映射 + AI 解析', async () => {
  await page.selectOption('#lang', 'cpp');
  await waitEditor(page, /vector<int> twoSum/, 15000, 'cpp template 2');
  await setEditor(page, CPP_TYPE_ERROR);
  await page.fill('#custom-input', '[[2,7,11,15],9]');
  await page.click('#btn-custom');
  await waitText(page, '.verdict', /编译错误/, 30000, 'cpp compile error');
  const pane = (await page.textContent('#result-pane')) || '';
  ok(/your code:4/.test(pane), `行号应映射到用户代码第 4 行，得到: ${pane.slice(0, 400)}`);
  // 编译错误也要有 AI 讲解
  await waitText(page, '#result-pane', /含义：/, 60000, 'compile AI coach');
  const coach = (await page.textContent('#result-pane')) || '';
  ok(/怎么修/.test(coach), `AI 卡片应含怎么修: ${coach.slice(-500)}`);
});

console.log('\n4) 提交判题 + 进度 + 无 AI 降级\n');

await test('注入期望值后：运行示例答错也得到 AI 诊断', async () => {
  await page.evaluate(() => {
    localStorage.setItem('lct:tests:two-sum', JSON.stringify([
      { input: [[2, 7, 11, 15], 9], expected: [0, 1] },
      { input: [[3, 2, 4], 6], expected: [1, 2] },
    ]));
  });
  await page.click('#load');
  await waitText(page, '.p-title', /Two Sum/, 30000, 'reload with cached tests');
  await waitEditor(page, /twoSum/, 15000, 'editor after reload');
  await page.selectOption('#lang', 'python3');
  await waitEditor(page, /def twoSum/, 15000, 'py template after lang switch');
  await setEditor(page, PY_WRONG);
  // 非提交的运行示例:答错 → 诊断卡立即出现
  await page.click('#btn-run');
  await waitText(page, '.verdict', /答案错误/, 60000, 'wrong run');
  await waitText(page, '#result-pane', /思路正确，实现有 bug|思路需要调整/, 90000, 'run diagnosis');
});

await test('错误答案提交 → 答案错误 + 进度记录「未通过」', async () => {
  await page.click('#btn-submit');
  await waitText(page, '.verdict', /答案错误/, 60000, 'wrong submit');
  await page.click('#btn-progress');
  await waitText(page, '#progress-body', /未通过/, 10000, 'progress failed row');
  const body = (await page.textContent('#progress-body')) || '';
  ok(/Two Sum/.test(body), '进度表应有 Two Sum 行');
  await page.keyboard.press('Escape');
  await sleep(400);
  const shown = await page.$eval('#ov-progress', (el) => el.classList.contains('show'));
  ok(!shown, 'Esc 应关闭进度面板');
});

await test('错误提交后 AI 诊断卡出现（思路判断）', async () => {
  await waitText(page, '#result-pane', /思路正确，实现有 bug|思路需要调整/, 120000, 'diagnosis card');
});

await test('正确答案提交 → 全部通过 + 进度更新为「勉强过」', async () => {
  await setEditor(page, PY_TWOSUM);
  await page.click('#btn-submit');
  await waitText(page, '.verdict', /全部通过/, 60000, 'pass submit');
  await page.click('#btn-progress');
  await waitText(page, '#progress-body', /勉强过/, 10000, 'progress shaky row');
  await page.keyboard.press('Escape');
  await sleep(200);
});

await test('无期望值提交 → AI 裁决后全部通过 + 点评', async () => {
  await page.evaluate(() => localStorage.removeItem('lct:tests:two-sum'));
  await page.click('#load');
  await waitText(page, '.p-title', /Two Sum/, 30000, 'reload no cached tests');
  await waitEditor(page, /twoSum/, 15000, 'editor ready');
  await setEditor(page, PY_TWOSUM);
  await page.click('#btn-submit');
  await waitText(page, '#result-pane', /AI 判定输出是否正确/, 60000, 'adjudication started');
  await waitText(page, '.verdict', /全部通过/, 120000, 'adjudicated pass');
  await waitText(page, '#result-pane', /AI 点评/, 120000, 'review after adjudication');
});

console.log('\n5) 系统设计题（lru-cache）web 全链路\n');

await test('lru-cache：加载 + C++ 调试运行输出正确序列', async () => {
  await page.fill('#slug', 'lru-cache');
  await page.click('#load');
  await waitText(page, '.p-title', /LRU Cache/, 30000, 'lru title');
  await page.selectOption('#lang', 'cpp');
  await waitEditor(page, /LRUCache/, 15000, 'lru cpp template');
  await setEditor(page, CPP_LRU);
  // ops: LRUCache(2) -> put(1,1) -> get(1) -> put(2,2) -> get(2)
  await page.fill('#custom-input', '[["LRUCache","put","get","put","get"],[[2],[1,1],[1],[2,2],[2]]]');
  await page.click('#btn-custom');
  await waitText(page, '.verdict', /已执行，未判定/, 30000, 'lru custom');
  const pane = (await page.textContent('#result-pane')) || '';
  ok(/\[null,null,1,null,2\]/.test(pane), `应显示 [null,null,1,null,2]，得到: ${pane.slice(0, 500)}`);
});

console.log('\n6) 页面错误检查\n');

await test('无未捕获页面异常（外部 CDN 加载失败除外）', async () => {
  const real = errors.filter((e) => !/Failed to load resource|net::ERR/.test(e));
  ok(real.length === 0, `页面错误: ${real.join(' | ')}`);
});

await browser.close();

console.log(`\n结果：${passed} 通过, ${failures.length} 失败\n`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.err.message.split('\n')[0]}`);
  process.exit(1);
}
