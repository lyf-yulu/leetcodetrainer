/**
 * End-to-end verification of the judge harnesses.
 *
 * For each language the full pipeline is exercised:
 *   metaData -> driver codegen -> compile (C++/Java) -> run -> sentinel parse -> judge
 *
 * Python runs under the system `python3`: the generated driver is stdlib-only, so
 * it behaves the same as under Pyodide (the WASM path is exercised in-browser).
 *
 * Zero dependencies, no test framework. Run:
 *   node tests/harness.test.mjs
 * A language whose toolchain is missing is skipped with a note, not failed.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  build, parseExamples, parseOutput, remapTrace, remapCompilerErrors,
  isSystemDesign, linesPerTest,
} from '../public/harness.mjs';
import { buildCpp, cppType } from '../public/harness-cpp.mjs';
import { buildJava, javaType, helperFor } from '../public/harness-java.mjs';
import { compare, judge } from '../public/judge.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- helpers

function run(cmd, args, { cwd, stdin = '', timeout = 30_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ code: -1, stdout: '', stderr: String(err), timedOut: false });
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      resolve({ code: null, stdout, stderr, timedOut: true });
    }, timeout);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err), timedOut: false });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: false });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

async function which(cmd) {
  const r = await run('/usr/bin/which', [cmd]);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Finds a working javac/java: $JAVA_HOME, brew's openjdk cellar, then plain PATH. */
async function resolveJava() {
  if (process.env.JAVA_HOME) {
    const javac = path.join(process.env.JAVA_HOME, 'bin', 'javac');
    if (await which(javac)) return { javac, java: path.join(process.env.JAVA_HOME, 'bin', 'java') };
  }
  const brew = await which('brew');
  if (brew) {
    const r = await run(brew, ['--prefix', 'openjdk']);
    if (r.code === 0 && r.stdout.trim()) {
      const javac = path.join(r.stdout.trim(), 'bin', 'javac');
      if (await which(javac)) return { javac, java: path.join(r.stdout.trim(), 'bin', 'java') };
    }
  }
  const probe = await run('javac', ['-version']);
  if (probe.code === 0 && !/unable to locate a java runtime/i.test(probe.stderr)) {
    return { javac: 'javac', java: 'java' };
  }
  return null;
}

/** Runs one problem end-to-end for one language. */
async function runProblem(lang, meta, userCode, tests, jc) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lctest-'));
  try {
    if (lang === 'python3') {
      const src = build('python3', meta, userCode, tests);
      await fs.writeFile(path.join(dir, 'main.py'), src);
      const r = await run('python3', ['main.py'], { cwd: dir });
      return { stdout: r.stdout, stderr: r.stderr, compileError: null, timedOut: r.timedOut };
    }
    if (lang === 'cpp') {
      const src = buildCpp(meta, userCode);
      await fs.writeFile(path.join(dir, 'main.cpp'), src);
      const b = await run('c++', ['-std=c++17', '-O2', '-o', 'prog', 'main.cpp'], { cwd: dir, timeout: 60_000 });
      if (b.code !== 0) return { compileError: b.stderr || b.stdout };
      const r = await run(path.join(dir, 'prog'), [], { cwd: dir, stdin: JSON.stringify(tests) });
      return { stdout: r.stdout, stderr: r.stderr, compileError: null, timedOut: r.timedOut };
    }
    if (lang === 'java') {
      const src = buildJava(meta, userCode);
      await fs.writeFile(path.join(dir, 'Main.java'), src);
      const b = await run(jc.javac, ['Main.java'], { cwd: dir, timeout: 60_000 });
      if (b.code !== 0) return { compileError: b.stderr || b.stdout };
      const r = await run(jc.java, ['-Xss64m', '-cp', dir, 'Main'], { cwd: dir, stdin: JSON.stringify(tests) });
      return { stdout: r.stdout, stderr: r.stderr, compileError: null, timedOut: r.timedOut };
    }
    throw new Error(`unknown language ${lang}`);
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------- report

let passed = 0;
let skipped = 0;
const failures = [];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  ✗ ${name}\n      ${String(err.message).split('\n').join('\n      ')}`);
  }
}

function skip(name, why) {
  skipped++;
  console.log(`  – ${name} (跳过：${why})`);
}

// ---------------------------------------------------------------- fixtures

const problemsDir = path.join(ROOT, '..', 'data', 'problems');
const twoSum = JSON.parse(await fs.readFile(path.join(problemsDir, 'two-sum.json'), 'utf8'));
const lru = JSON.parse(await fs.readFile(path.join(problemsDir, 'lru-cache.json'), 'utf8'));

// Fabricated metaData for shapes the cache doesn't cover.
const listMeta = {
  name: 'addTwoNumbers',
  params: [{ name: 'l1', type: 'ListNode' }, { name: 'l2', type: 'ListNode' }],
  return: { type: 'ListNode' },
};
const voidMeta = {
  name: 'rotate',
  params: [{ name: 'nums', type: 'integer[]' }, { name: 'k', type: 'integer' }],
  return: { type: 'void' },
};

const twoSumTests = [
  { input: [[2, 7, 11, 15], 9], expected: [0, 1] },
  { input: [[3, 2, 4], 6], expected: [1, 2] },
  { input: [[3, 3], 6], expected: [0, 1] },
];

const [lruCase] = parseExamples(lru.meta, lru.exampleTestcases);
lruCase.expected = [null, null, null, 1, null, -1, null, -1, 3, 4];
const lruTests = [lruCase];

const listTests = [
  { input: [[2, 4, 3], [5, 6, 4]], expected: [7, 0, 8] },
  { input: [[9, 9, 9, 9], [9, 9, 9, 9, 9, 9, 9]], expected: [8, 9, 9, 9, 0, 0, 0, 1] },
];

const voidTests = [
  { input: [[1, 2, 3, 4, 5, 6, 7], 3], expected: [5, 6, 7, 1, 2, 3, 4] },
  { input: [[-1, -100, 3, 99], 2], expected: [3, 99, -1, -100] },
];

// ---------------------------------------------------------------- solutions

const twoSumSol = {
  python3: `class Solution:
    def twoSum(self, nums, target):
        seen = {}
        for i, x in enumerate(nums):
            if target - x in seen:
                return [seen[target - x], i]
            seen[x] = i
        return []
`,
  cpp: `class Solution {
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
`,
  java: `class Solution {
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
`,
};

const lruSol = {
  python3: `class LRUCache:
    def __init__(self, capacity: int):
        self.cap = capacity
        self.d = {}

    def get(self, key: int) -> int:
        if key not in self.d:
            return -1
        v = self.d.pop(key)
        self.d[key] = v
        return v

    def put(self, key: int, value: int) -> None:
        self.d.pop(key, None)
        self.d[key] = value
        if len(self.d) > self.cap:
            self.d.pop(next(iter(self.d)))
`,
  cpp: `class LRUCache {
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
`,
  java: `class LRUCache {
  private final int cap;
  private final LinkedHashMap<Integer,Integer> m = new LinkedHashMap<>(16, 0.75f, true);
  LRUCache(int capacity) { cap = capacity; }
  int get(int key) { return m.getOrDefault(key, -1); }
  void put(int key, int value) {
    m.put(key, value);
    if (m.size() > cap) m.remove(m.keySet().iterator().next());
  }
}
`,
};

const listSol = {
  python3: `class Solution:
    def addTwoNumbers(self, l1, l2):
        dummy = ListNode(0)
        cur = dummy
        carry = 0
        while l1 or l2 or carry:
            s = (l1.val if l1 else 0) + (l2.val if l2 else 0) + carry
            carry = s // 10
            cur.next = ListNode(s % 10)
            cur = cur.next
            l1 = l1.next if l1 else None
            l2 = l2.next if l2 else None
        return dummy.next
`,
  cpp: `class Solution {
public:
  ListNode* addTwoNumbers(ListNode* l1, ListNode* l2) {
    ListNode dummy(0);
    ListNode* cur = &dummy;
    int carry = 0;
    while (l1 || l2 || carry) {
      int s = (l1 ? l1->val : 0) + (l2 ? l2->val : 0) + carry;
      carry = s / 10;
      cur->next = new ListNode(s % 10);
      cur = cur->next;
      if (l1) l1 = l1->next;
      if (l2) l2 = l2->next;
    }
    return dummy.next;
  }
};
`,
  java: `class Solution {
  public ListNode addTwoNumbers(ListNode l1, ListNode l2) {
    ListNode dummy = new ListNode(0), cur = dummy;
    int carry = 0;
    while (l1 != null || l2 != null || carry != 0) {
      int s = (l1 != null ? l1.val : 0) + (l2 != null ? l2.val : 0) + carry;
      carry = s / 10;
      cur.next = new ListNode(s % 10);
      cur = cur.next;
      if (l1 != null) l1 = l1.next;
      if (l2 != null) l2 = l2.next;
    }
    return dummy.next;
  }
}
`,
};

const voidSol = {
  python3: `class Solution:
    def rotate(self, nums, k):
        k %= len(nums)
        nums[:] = nums[-k:] + nums[:-k]
`,
  cpp: `class Solution {
public:
  void rotate(vector<int>& nums, int k) {
    k %= nums.size();
    std::reverse(nums.begin(), nums.end());
    std::reverse(nums.begin(), nums.begin() + k);
    std::reverse(nums.begin() + k, nums.end());
  }
};
`,
  java: `class Solution {
  public void rotate(int[] nums, int k) {
    k %= nums.length;
    int[] tmp = new int[nums.length];
    for (int i = 0; i < nums.length; i++) tmp[(i + k) % nums.length] = nums[i];
    System.arraycopy(tmp, 0, nums, 0, nums.length);
  }
}
`,
};

// Variants for the error/log/design-wrong-answer paths.
const twoSumThrows = {
  python3: `class Solution:
    def twoSum(self, nums, target):
        raise ValueError("boom")
`,
  cpp: `class Solution {
public:
  vector<int> twoSum(vector<int>& nums, int target) {
    throw std::runtime_error("boom");
  }
};
`,
  java: `class Solution {
  public int[] twoSum(int[] nums, int target) {
    throw new RuntimeException("boom");
  }
}
`,
};

const twoSumLogs = {
  python3: `class Solution:
    def twoSum(self, nums, target):
        print("LOG_MARKER")
        seen = {}
        for i, x in enumerate(nums):
            if target - x in seen:
                return [seen[target - x], i]
            seen[x] = i
        return []
`,
  cpp: `class Solution {
public:
  vector<int> twoSum(vector<int>& nums, int target) {
    std::cout << "LOG_MARKER" << std::endl;
    unordered_map<int,int> seen;
    for (int i = 0; i < (int)nums.size(); i++) {
      if (seen.count(target - nums[i])) return {seen[target - nums[i]], i};
      seen[nums[i]] = i;
    }
    return {};
  }
};
`,
  java: `class Solution {
  public int[] twoSum(int[] nums, int target) {
    System.out.println("LOG_MARKER");
    HashMap<Integer,Integer> seen = new HashMap<>();
    for (int i = 0; i < nums.length; i++) {
      Integer j = seen.get(target - nums[i]);
      if (j != null) return new int[]{j, i};
      seen.put(nums[i], i);
    }
    return new int[]{};
  }
}
`,
};

const lruWrong = {
  python3: `class LRUCache:
    def __init__(self, capacity: int):
        self.cap = capacity
        self.d = {}
    def get(self, key: int) -> int:
        return self.d.get(key, 0)
    def put(self, key: int, value: int) -> None:
        self.d[key] = value
        if len(self.d) > self.cap:
            self.d.pop(next(iter(self.d)))
`,
  cpp: `class LRUCache {
  int cap;
  std::unordered_map<int,int> m;
  std::list<int> order;
public:
  LRUCache(int capacity) : cap(capacity) {}
  int get(int key) {
    return m.count(key) ? m[key] : 0;
  }
  void put(int key, int value) {
    if (!m.count(key) && (int)m.size() == cap) { m.erase(order.back()); order.pop_back(); }
    if (m.count(key)) order.remove(key);
    order.push_front(key);
    m[key] = value;
  }
};
`,
  java: `class LRUCache {
  private final int cap;
  private final LinkedHashMap<Integer,Integer> m = new LinkedHashMap<>(16, 0.75f, true);
  LRUCache(int capacity) { cap = capacity; }
  int get(int key) { return m.getOrDefault(key, 0); }
  void put(int key, int value) {
    m.put(key, value);
    if (m.size() > cap) m.remove(m.keySet().iterator().next());
  }
}
`,
};

// ---------------------------------------------------------------- suites

console.log('\n1) 场景：metaData → codegen → 运行 → 判题（每语言）\n');

const SCENARIOS = [
  { name: 'two-sum：普通函数 integer[] → integer[]', meta: twoSum.meta, tests: twoSumTests, sol: twoSumSol },
  { name: 'lru-cache：系统设计（classname + 方法序列）', meta: lru.meta, tests: lruTests, sol: lruSol },
  { name: 'add-two-numbers：ListNode 进出（构造 metaData）', meta: listMeta, tests: listTests, sol: listSol },
  { name: 'rotate：void 返回，修改第一个参数（构造 metaData）', meta: voidMeta, tests: voidTests, sol: voidSol },
];

const LANGS = ['python3', 'cpp', 'java'];

const pythonOk = Boolean(await which('python3'));
const cppOk = Boolean(await which('c++'));
const jc = await resolveJava();

for (const s of SCENARIOS) {
  for (const lang of LANGS) {
    const label = `${s.name} · ${lang}`;
    if (lang === 'python3' && !pythonOk) { skip(label, '本机无 python3'); continue; }
    if (lang === 'cpp' && !cppOk) { skip(label, '本机无 c++'); continue; }
    if (lang === 'java' && !jc) { skip(label, '本机无 JDK（brew install openjdk）'); continue; }

    await test(label, async () => {
      const res = await runProblem(lang, s.meta, s.sol[lang], s.tests, jc);
      assert(!res.timedOut, '执行超时');
      if (res.compileError) throw new Error(`编译失败：\n${res.compileError.slice(0, 400)}`);
      const { records, stray } = parseOutput(res.stdout);
      const verdict = judge(s.tests, records);
      if (!verdict.allPassed) {
        const first = verdict.results.find((r) => r.status !== 'pass');
        throw new Error(`判题失败 counts=${JSON.stringify(verdict.counts)}\n`
          + `  首个失败用例：${JSON.stringify(first)}\n  stdout: ${res.stdout.slice(0, 300)}`);
      }
      assert(stray === '' || stray.trim() === '', `预期无杂散输出，得到：${stray}`);
    });
  }
}

console.log('\n2) 行为：日志捕获、运行时错误、编译错误、错误答案\n');

for (const lang of LANGS) {
  const ready = lang === 'python3' ? pythonOk : lang === 'cpp' ? cppOk : Boolean(jc);

  await (ready ? test : skip)(`print 输出进入 log 字段，不污染判题 · ${lang}`,
    ready ? async () => {
      const res = await runProblem(lang, twoSum.meta, twoSumLogs[lang], twoSumTests, jc);
      const { records } = parseOutput(res.stdout);
      const verdict = judge(twoSumTests, records);
      assert(verdict.allPassed, '判题应全部通过');
      assert(records[0].log.includes('LOG_MARKER'), `log 应包含 LOG_MARKER，得到：${records[0].log}`);
    } : '本机工具链缺失');

  await (ready ? test : skip)(`运行时异常 → 用例标记 error 且 err 带原因 · ${lang}`,
    ready ? async () => {
      const res = await runProblem(lang, twoSum.meta, twoSumThrows[lang], twoSumTests, jc);
      const { records } = parseOutput(res.stdout);
      const verdict = judge(twoSumTests, records);
      assert(verdict.counts.error === twoSumTests.length, `应全部 error，得到 ${JSON.stringify(verdict.counts)}`);
      assert(records.every((r) => !r.ok), '记录应 ok:false');
      assert(records[0].err.includes('boom'), `err 应包含异常信息，得到：${records[0].err.slice(0, 200)}`);
    } : '本机工具链缺失');

  await (ready ? test : skip)(`设计题答错 → 精确 fail 计数 · ${lang}`,
    ready ? async () => {
      const res = await runProblem(lang, lru.meta, lruWrong[lang], lruTests, jc);
      const { records } = parseOutput(res.stdout);
      const verdict = judge(lruTests, records);
      assert(verdict.counts.fail === 1, `应恰好 1 个 fail，得到 ${JSON.stringify(verdict.counts)}`);
    } : '本机工具链缺失');

  if (lang !== 'python3') {
    await (ready ? test : skip)(`语法错误 → 编译错误路径 · ${lang}`,
      ready ? async () => {
        const res = await runProblem(lang, twoSum.meta, 'clas Solution {', twoSumTests, jc);
        assert(res.compileError, '应报告编译错误');
      } : '本机工具链缺失');
  } else {
    await (ready ? test : skip)('语法错误 → 整体编译失败，无记录（对应 app.js fatal 路径） · python3',
      ready ? async () => {
        const res = await runProblem('python3', twoSum.meta, 'class Solution:\n    def twoSum(self, nums, target):\n        return [', twoSumTests, jc);
        // A syntax error kills the whole script at compile time: no sentinel
        // records at all. In the browser, Pyodide raises the same error and
        // app.js surfaces it as `fatal` — this asserts the failure signature.
        const { records } = parseOutput(res.stdout);
        assert(records.length === 0, `不应产生记录，得到 ${records.length} 条`);
        assert(/SyntaxError/.test(res.stderr || ''), `stderr 应含 SyntaxError，得到：${res.stderr.slice(0, 200)}`);
        assert(res.code !== 0, '应非零退出');
      } : '本机无 python3');
  }
}

console.log('\n3) 单元：解析、比对、行号重映射\n');

await test('parseExamples：two-sum（2 行/用例）解析出 3 个用例', () => {
  const t = parseExamples(twoSum.meta, twoSum.exampleTestcases);
  assert(t.length === 3, `应 3 个用例，得到 ${t.length}`);
  assert(JSON.stringify(t[0].input) === '[[2,7,11,15],9]', `用例 0 错误：${JSON.stringify(t[0].input)}`);
});

await test('parseExamples：lru-cache（系统设计 2 行/用例）解析出 1 个用例', () => {
  assert(isSystemDesign(lru.meta), '应识别为系统设计');
  assert(linesPerTest(lru.meta) === 2, '系统设计应 2 行/用例');
  const t = parseExamples(lru.meta, lru.exampleTestcases);
  assert(t.length === 1, `应 1 个用例，得到 ${t.length}`);
  assert(t[0].input[0].length === 10 && t[0].input[1].length === 10, 'ops/args 应各 10 项');
});

await test('compare：浮点容差 1e-5 内判通过', () => {
  assert(compare(0.1 + 0.2, 0.3).status === 'pass', '0.1+0.2 应≈0.3');
  assert(compare(1, 1.000001).status === 'pass', '1e-6 差应在容差内');
});

await test('compare：相同多重集不同顺序 → 明确 fail 而非误判', () => {
  const r = compare([1, 2, 3], [3, 1, 2]);
  assert(r.status === 'fail', '未声明 orderInsensitive 时应 fail');
  assert(/顺序/.test(r.note), 'note 应提示顺序问题');
  const ok = compare([1, 2, 3], [3, 1, 2], { orderInsensitive: true });
  assert(ok.status === 'pass', '声明后应 pass');
});

await test('compare：系统设计 void 槽位（null）跳过比对', () => {
  const r = compare([null, 1, null, -1], [null, 1, null, -1]);
  assert(r.status === 'pass', '应 pass');
  const bad = compare([null, 1, null, 0], [null, 1, null, -1]);
  assert(bad.status === 'fail', '非 null 槽位不一致应 fail');
});

await test('compare：multipleValid 交给 AI 判定（unknown）', () => {
  const r = compare([0, 1], [1, 0], { multipleValid: true });
  assert(r.status === 'unknown', '应 unknown');
});

await test('judge：缺少记录（进程崩溃）→ error', () => {
  const v = judge(twoSumTests, []);
  assert(v.counts.error === 3, `应 3 error，得到 ${JSON.stringify(v.counts)}`);
  assert(v.firstFailure.status === 'error', 'firstFailure 应 error');
});

await test('remapTrace：用户帧行号映射 + 脚手架帧丢弃', () => {
  const tb = [
    'Traceback (most recent call last):',
    '  File "gen.py", line 3, in <module>',
    '    _lct_emit(_lct_rec)',
    '  File "gen.py", line 12, in twoSum',
    '    return x / 0',
    'ZeroDivisionError: division by zero',
  ].join('\n');
  const out = remapTrace(tb, 9, 5); // user code at gen line 9, 5 lines long
  assert(!out.includes('gen.py'), '生成文件名应被替换');
  assert(out.includes('your code", line 4'), `第 12 行应映射为用户第 4 行，得到：${out}`);
  assert(!out.includes('_lct_emit'), '脚手架帧应被丢弃');
  assert(out.includes('ZeroDivisionError'), '异常行应保留');
});

await test('remapCompilerErrors：行号映射 + 越界标记为脚手架', () => {
  const err = [
    'main.cpp:5:10: error: use of undeclared identifier',
    'main.cpp:259:60: error: no match for operator/',
  ].join('\n');
  const out = remapCompilerErrors(err, 256, 10);
  assert(out.includes('your code:4:60'), `第 259 行应映射为用户第 4 行，得到：${out}`);
  assert(out.includes('[judge scaffolding]'), '越界帧应标记为脚手架');
});

await test('javaType/helperFor：list<ListNode> 声明与反序列化一致', () => {
  assert(javaType('list<ListNode>') === 'List<ListNode>', `得到 ${javaType('list<ListNode>')}`);
  assert(helperFor('list<ListNode>') === 'asListList', `得到 ${helperFor('list<ListNode>')}`);
  assert(javaType('list<TreeNode>') === 'List<TreeNode>', `得到 ${javaType('list<TreeNode>')}`);
  assert(helperFor('list<TreeNode>') === 'asTreeList', `得到 ${helperFor('list<TreeNode>')}`);
  assert(javaType('list<list<integer>>') === 'List<List<Integer>>', `得到 ${javaType('list<list<integer>>')}`);
  assert(javaType('integer[]') === 'int[]' && helperFor('integer[]') === 'asIntArr', '数组映射');
});

await test('cppType：list<> 与 [] 展开一致', () => {
  assert(cppType('list<list<integer>>') === 'vector<vector<int>>', `得到 ${cppType('list<list<integer>>')}`);
  assert(cppType('integer[]') === 'vector<int>', `得到 ${cppType('integer[]')}`);
  assert(cppType('ListNode') === 'ListNode*', `得到 ${cppType('ListNode')}`);
});

await test('parseOutput：哨兵行与杂散行分离', () => {
  const raw = [
    '__LCT__{"i":0,"ok":true,"out":[0,1],"ms":1.2,"err":"","log":""}',
    'garbage from a stray print',
    '__LCT__{"i":1,"ok":false,"out":null,"ms":0.5,"err":"boom","log":""}',
  ].join('\n');
  const { records, stray } = parseOutput(raw);
  assert(records.length === 2, `应 2 条记录，得到 ${records.length}`);
  assert(records[1].err === 'boom', '记录内容应可解析');
  assert(stray.includes('garbage'), '杂散行应进 stray');
});

// ---------------------------------------------------------------- summary

console.log(`\n结果：${passed} 通过, ${failures.length} 失败, ${skipped} 跳过\n`);
if (failures.length) {
  console.log('失败明细：');
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.err.message.split('\n')[0]}`);
  process.exit(1);
}
