import * as harness from './harness.mjs';
import { buildCpp, cppUserOffset } from './harness-cpp.mjs';
import { buildJava, javaUserOffset } from './harness-java.mjs';
import { judge, compare } from './judge.mjs';
import { PythonRunner } from './runner-py.js';
import * as ai from './ai.js';

const $ = (id) => document.getElementById(id);

const LANGS = [
  { id: 'python3', label: 'Python3', envKey: 'python3' },
  { id: 'cpp', label: 'C++', envKey: 'cpp' },
  { id: 'java', label: 'Java', envKey: 'java' },
];

const state = {
  env: null,
  problem: null,
  tests: [],          // [{input, expected?, label?, source?}]
  language: 'python3',
  editor: null,       // Monaco model wrapper or textarea shim
  runner: null,
  progress: {},
  notes: {},
  lastJudged: null,
  chat: [],
  hints: null,        // {slug, warmup, hints:[...], stage} — staged "求助" hints
  drafts: {},         // slug:lang -> code, so switching does not lose work
  problemSet: null,   // {fetchedAt, problems: [{id,title,slug,difficulty,paidOnly}]}
  stmtLang: 'zh',     // statement language preference: 'zh' | 'en'
  translateFailed: false, // session flag: stop auto-retrying translation
};

// ---------------------------------------------------------------- helpers

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function short(v, max = 220) {
  const s = JSON.stringify(v);
  if (s === undefined) return 'undefined';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function status(text, spinning = false) {
  $('run-status').innerHTML = spinning ? `<span class="spin"></span> ${esc(text)}` : esc(text);
}

async function api(path, opts) {
  const resp = await fetch(path, opts);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

function draftKey() {
  return `${state.problem?.slug || '?'}:${state.language}`;
}

// ---------------------------------------------------------------- editor

/** Monaco if it loads, plain textarea if the CDN is unreachable. */
async function initEditor() {
  const host = $('editor-host');
  try {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs/loader.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('monaco loader failed'));
      setTimeout(() => reject(new Error('monaco timeout')), 12000);
      document.head.appendChild(s);
    });

    await new Promise((resolve, reject) => {
      window.require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs' } });
      window.require(['vs/editor/editor.main'], resolve, reject);
    });

    host.innerHTML = '';
    const ed = window.monaco.editor.create(host, {
      value: '',
      language: 'python',
      theme: 'vs-dark',
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      automaticLayout: true,
      tabSize: 4,
      renderWhitespace: 'selection',
    });

    state.editor = {
      get: () => ed.getValue(),
      set: (v) => ed.setValue(v),
      setLang: (id) => {
        const map = { python3: 'python', cpp: 'cpp', java: 'java' };
        window.monaco.editor.setModelLanguage(ed.getModel(), map[id] || 'plaintext');
      },
      monaco: true,
    };
  } catch {
    // Fallback: the textarea already in the DOM.
    const ta = $('fallback-editor');
    state.editor = {
      get: () => ta.value,
      set: (v) => { ta.value = v; },
      setLang: () => {},
      monaco: false,
    };
  }

  // Cmd/Ctrl+Enter submits from anywhere.
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  });
}

// ---------------------------------------------------------------- env + boot

async function loadEnv() {
  state.env = await api('/api/env');
  const badges = LANGS.map((l) => {
    const e = state.env[l.envKey] || {};
    return `<span class="badge ${e.available ? 'on' : 'off'}" title="${esc(e.version || e.note || '不可用')}">${l.label}</span>`;
  });
  badges.push(
    `<span class="badge ${state.env.ai?.configured ? 'on' : 'off'}" title="${esc(state.env.ai?.model || '未配置 config.json')}">AI</span>`
  );
  $('env-badges').innerHTML = badges.join('');

  const sel = $('lang');
  sel.innerHTML = LANGS.map((l) => {
    const ok = state.env[l.envKey]?.available;
    return `<option value="${l.id}"${ok ? '' : ' disabled'}>${l.label}${ok ? '' : ' (未安装)'}</option>`;
  }).join('');
  sel.value = state.language;

  $('settings-env').innerHTML = LANGS.map((l) => {
    const e = state.env[l.envKey] || {};
    return `<div class="row"><span class="badge ${e.available ? 'on' : 'off'}">${l.label}</span>
      <span style="font-size:12px;color:var(--muted)">${esc(e.version || e.note || '未检测到')}</span></div>`;
  }).join('') + (state.env.java?.available ? '' :
    `<p style="font-size:12.5px;color:var(--muted)">装 Java：<code>brew install openjdk</code>，然后重启服务。
    自动探测 <code>JAVA_HOME</code> / brew 路径，无需 sudo 符号链接。</p>`);
}

// ---------------------------------------------------------------- problem

async function loadProblem(q) {
  // Accepts a slug, a problem number, a title, or a full LeetCode URL.
  q = String(q || '').trim().toLowerCase()
    .replace(/^https?:\/\/[^/]*leetcode[^/]*\/problems\//, '')
    .replace(/\/.*$/, '');
  if (!q) return;

  status('加载题目…', true);
  $('problem-pane').innerHTML = '<div class="empty"><span class="spin"></span> 拉取题目…</div>';

  try {
    const p = await api(`/api/problem?q=${encodeURIComponent(q)}`);
    state.problem = p;
    state.chat = [];
    state.hints = null;
    $('slug').value = p.slug;
    $('custom-input').value = loadCustomInput(p.slug);

    // Cached AI-generated cases live alongside the problem; fall back to raw examples.
    const cachedTests = loadCachedTests(p.slug);
    state.tests = cachedTests || harness.parseExamples(p.meta, p.exampleTestcases);

    renderProblem();
    applyTemplate();
    renderResult(null);
    status(p.cached ? '题目已缓存' : '题目已拉取');

    // Prefer Chinese statements: fetch the official translation once and it is
    // cached server-side. Failures stop auto-retrying for the rest of the
    // session — the 中文 button stays for manual retries.
    if (!p.translatedContent && !state.translateFailed) {
      translateProblem(p, true);
    }
  } catch (err) {
    // A failed load must not leave the old problem silently loaded — running
    // would judge the previous problem's code against the wrong metaData.
    state.problem = null;
    state.tests = [];
    $('problem-pane').innerHTML = `<div class="empty">加载失败：${esc(err.message)}<br><br>
      可输入题号（如 1）、题名（如 two sum）或 slug（如 two-sum），
      或点顶栏「题库」搜索选择</div>`;
    status('加载失败');
  }
}

/**
 * Statement HTML is injected into the page, so scrub it: drop scripts/iframes
 * and inline handlers, and rewrite relative URLs (LeetCode statements use
 * `/uploads/...`) against the right origin — leetcode.cn for translations,
 * leetcode.com for the original.
 */
function stmtHtml(html, base) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '')
    .replace(/(\s)(src|href)=(["'])\/(?!\/)/g, (m, sp, attr, q) => `${sp}${attr}=${q}${base}/`);
}

function renderProblem() {
  const p = state.problem;
  const rec = state.progress[p.slug];
  const useZh = state.stmtLang === 'zh' && Boolean(p.translatedContent);
  const base = useZh ? (p.translatedBase || 'https://leetcode.cn') : 'https://leetcode.com';
  const content = stmtHtml(useZh ? p.translatedContent : p.content, base);
  const title = useZh && p.translatedTitle
    ? `${esc(p.translatedTitle)} <span class="en-title">${esc(p.title)}</span>`
    : esc(p.title);

  // Language toggle shows the language you would switch TO; when no
  // translation exists yet it doubles as the "translate now" button.
  const btn = $('btn-lang');
  if (btn) {
    btn.hidden = false;
    btn.textContent = p.translatedContent ? (useZh ? 'EN' : '中文') : '中文';
    btn.title = p.translatedContent
      ? '切换题面语言'
      : '翻译题面（leetcode.cn 官方翻译，失败时用 AI）';
  }

  const hints = (p.hints || []).length
    ? `<details class="hints"><summary>官方提示 (${p.hints.length})</summary>
       <ol>${p.hints.map((h) => `<li>${h}</li>`).join('')}</ol></details>`
    : '';

  $('problem-pane').innerHTML = `
    <h2 class="p-title">${p.id}. ${title}</h2>
    <div class="p-meta">
      <span class="diff ${esc(p.difficulty)}">${esc(p.difficulty)}</span>
      ${rec ? `<span class="state ${rec.state}">${stateLabel(rec.state)}</span>` : ''}
      ${(p.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}
    </div>
    <div class="statement">${content || '<p>（无题面）</p>'}</div>
    ${hints}`;
}

// ---------------------------------------------------------------- translation

async function translateProblem(p, silent = false) {
  const btn = $('btn-lang');
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    const t = await api('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: p.slug }),
    });
    // The user may have loaded another problem while the translation was in
    // flight — a stale result must not overwrite the new problem's pane.
    if (state.problem !== p) return;
    p.translatedTitle = t.translatedTitle;
    p.translatedContent = t.translatedContent;
    p.translatedBase = t.translatedBase;
    state.stmtLang = 'zh';
    state.translateFailed = false;
    renderProblem();
  } catch (err) {
    state.translateFailed = true;
    if (!silent) alert(`翻译失败：${err.message}`);
    else console.warn('auto-translate failed:', err.message);
    if (btn) btn.textContent = '中文';
  } finally {
    if (btn) btn.disabled = false;
  }
}

function onLangToggle() {
  const p = state.problem;
  if (!p) return;
  if (p.translatedContent && state.stmtLang === 'zh') {
    state.stmtLang = 'en';
    renderProblem();
  } else if (state.stmtLang === 'en') {
    state.stmtLang = 'zh';
    renderProblem();
  } else {
    translateProblem(p);
  }
}

// ---------------------------------------------------------------- problem set

async function loadProblemSet(refresh = false) {
  const body = $('list-body');
  body.innerHTML = '<div class="empty"><span class="spin"></span> 拉取题库…</div>';
  try {
    state.problemSet = await api(`/api/problemset${refresh ? '?refresh=1' : ''}`);
    renderList();
  } catch (err) {
    body.innerHTML = `<div class="empty">题库拉取失败：${esc(err.message)}</div>`;
  }
}

function renderList() {
  const q = ($('list-search').value || '').trim().toLowerCase();
  const all = state.problemSet?.problems || [];
  const filtered = q
    ? all.filter((p) => String(p.id) === q || String(p.id).startsWith(q)
        || p.title.toLowerCase().includes(q) || p.slug.includes(q))
    : all;
  const body = $('list-body');
  if (!filtered.length) {
    body.innerHTML = '<div class="empty">没有匹配的题目</div>';
    return;
  }
  const MAX = 300;
  const shown = filtered.slice(0, MAX);
  body.innerHTML = (filtered.length > MAX
    ? `<div class="list-hint">匹配 ${filtered.length} 条，显示前 ${MAX} 条 — 继续输入缩小范围</div>`
    : '') + shown.map((p) => `
      <button class="pl-row" data-slug="${esc(p.slug)}"${p.paidOnly ? ' disabled title="会员专享题，未登录无法拉取"' : ''}>
        <span class="pl-id">${esc(p.id)}.</span>
        <span class="pl-title">${esc(p.title)}</span>
        <span class="diff ${esc(p.difficulty || '')}">${esc(p.difficulty || '')}</span>
        ${p.paidOnly ? '<span class="pl-lock">🔒</span>' : ''}
      </button>`).join('');
  body.querySelectorAll('.pl-row').forEach((row) => {
    row.addEventListener('click', () => {
      $('ov-list').classList.remove('show');
      loadProblem(row.dataset.slug);
    });
  });
}

function applyTemplate() {
  const p = state.problem;
  if (!p) return;
  const draft = state.drafts[draftKey()];
  const snippet = p.snippets?.[state.language] || '';
  state.editor.set(draft ?? snippet ?? '');
  state.editor.setLang(state.language);
}

// ---------------------------------------------------------------- test cases

function testsCacheKey(slug) {
  return `lct:tests:${slug}`;
}

function loadCachedTests(slug) {
  try {
    const raw = localStorage.getItem(testsCacheKey(slug));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? parsed : null;
  } catch {
    return null;
  }
}

function saveCachedTests(slug, tests) {
  try {
    localStorage.setItem(testsCacheKey(slug), JSON.stringify(tests));
  } catch { /* quota — non-fatal */ }
}

async function generateTests() {
  const p = state.problem;
  if (!p) return;
  if (!state.env.ai?.configured) {
    alert('AI 未配置。在项目根目录创建 config.json 后重启服务。');
    return;
  }

  status('AI 生成用例…', true);
  $('btn-gen-tests').disabled = true;
  try {
    const examples = harness.parseExamples(p.meta, p.exampleTestcases);
    const { cases, notes } = await ai.generateTestCases({
      problem: p,
      exampleInputs: examples.map((t) => t.input),
    });

    // The model is usually right, but a malformed case (wrong argument count)
    // would break the judge driver at runtime — drop anything that doesn't
    // match the signature instead of failing the whole batch.
    const n = harness.isSystemDesign(p.meta) ? 2 : (p.meta.params || []).length;
    const valid = (cases || []).filter((c) =>
      Array.isArray(c.input) && c.input.length === n && c.expected !== undefined);
    if (!valid.length) throw new Error('AI 未返回可用用例');

    state.tests = valid;
    saveCachedTests(p.slug, valid);
    const withExpected = valid.filter((c) => c.expected !== undefined).length;
    const dropped = (cases || []).length - valid.length;
    status(`用例就绪：${valid.length} 个（${withExpected} 个有期望值${dropped ? `，丢弃 ${dropped} 个格式不符` : ''}）`);
    if (notes) {
      $('result-pane').insertAdjacentHTML('afterbegin',
        `<div class="card info"><h4>用例说明</h4><p>${esc(notes)}</p></div>`);
    }
  } catch (err) {
    status('用例生成失败');
    alert(`用例生成失败：${err.message}`);
  } finally {
    $('btn-gen-tests').disabled = false;
  }
}

// ---------------------------------------------------------------- execution

async function execute(tests) {
  const code = state.editor.get();
  const { meta } = state.problem;
  const userLines = code.split('\n').length;

  /** Tracebacks cite generated line numbers; translate them to the user's own. */
  const fixRecords = (parsed, offset) => {
    for (const r of parsed.records) {
      if (r.err) r.err = harness.remapTrace(r.err, offset, userLines);
    }
    return parsed;
  };

  if (state.language === 'python3') {
    if (!state.runner) {
      state.runner = new PythonRunner(state.env.pyodideVersion);
      state.runner.onStatus = (m) => status(m, true);
    }
    const src = harness.build('python3', meta, code, tests);
    const res = await state.runner.run(src, 20_000);
    if (!res.ok && res.timedOut) return { fatal: res.error, timedOut: true };
    const pyOffset = harness.userCodeOffset('python3');
    if (!res.ok) {
      return { fatal: harness.remapTrace(res.error, pyOffset, userLines) };
    }
    return fixRecords(harness.parseOutput(res.stdout), pyOffset);
  }

  const isCpp = state.language === 'cpp';
  const source = isCpp ? buildCpp(meta, code) : buildJava(meta, code);
  const offset = isCpp ? cppUserOffset() : javaUserOffset();

  const res = await api('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      language: state.language,
      source,
      stdin: JSON.stringify(tests),
      timeout: 15_000,
    }),
  });

  if (res.stage === 'compile' && !res.ok) {
    return { compileError: harness.remapCompilerErrors(res.error, offset, userLines) };
  }
  if (res.timedOut) return { fatal: `执行超时（>15s）`, timedOut: true };
  const parsed = fixRecords(harness.parseOutput(res.stdout), offset);
  if (!parsed.records.length && res.stderr) return { fatal: res.stderr };
  return { ...parsed, stderr: res.stderr };
}

async function run(isSubmit) {
  if (!state.problem) {
    alert('先加载一道题');
    return;
  }
  const code = state.editor.get().trim();
  if (!code) {
    alert('编辑器是空的');
    return;
  }
  state.drafts[draftKey()] = state.editor.get();

  const tests = state.tests.length ? state.tests : harness.parseExamples(state.problem.meta, state.problem.exampleTestcases);
  if (!tests.length) {
    alert('没有可用测试用例，点「补全用例」让 AI 生成');
    return;
  }

  $('btn-run').disabled = true;
  $('btn-submit').disabled = true;
  status(isSubmit ? '判题中…' : '运行中…', true);
  $('result-pane').innerHTML = '<div class="empty"><span class="spin"></span> 执行中…</div>';

  try {
    const out = await execute(tests);

    if (out.compileError) {
      renderCompileError(out.compileError);
      status('编译失败');
      coachCompile(out.compileError);
      return;
    }
    if (out.fatal) {
      renderFatal(out.fatal, out.timedOut);
      status(out.timedOut ? '超时' : '运行错误');
      coachRuntime(out.fatal, out.timedOut);
      return;
    }

    const verdict = judge(tests, out.records);
    state.lastJudged = { verdict, tests, code, language: state.language };
    renderResult(verdict, out.stray);
    status(verdictText(verdict));

    // Example runs (非提交) also get coached on errors/wrong answers —
    // beginners hit these constantly and need the explanation right away.
    if (!isSubmit && verdict.counts.error > 0) {
      coachRuntime(verdict.firstFailure?.error || '', false);
    } else if (!isSubmit && verdict.counts.fail > 0) {
      coachFailure(verdict);
    }

    if (isSubmit) {
      // Unknowns (any-order / multiple-valid-answer cases) get adjudicated by
      // the AI whenever there is no mechanical failure, so the recorded
      // attempt reflects the final truth — recording first would wrongly
      // count a failed attempt for a run that later passes.
      if (verdict.counts.unknown > 0 && !verdict.hasFailure) {
        await adjudicateUnknowns(verdict);
      }
      if (verdict.hasFailure || verdict.allPassed) {
        recordAttempt(verdict);
        await coach(verdict);
      } else {
        coachSlot().innerHTML = `<div class="card info"><h4>无法判定</h4>
          <p>部分用例没有期望输出${state.env.ai?.configured ? '，AI 也没能给出裁决' : '，且 AI 未配置'}。
          点「补全用例」生成期望值，或用「调试」输入框核对输出。</p></div>`;
      }
    }
  } catch (err) {
    renderFatal(err.message);
    status('出错');
  } finally {
    $('btn-run').disabled = false;
    $('btn-submit').disabled = false;
    $('btn-custom').disabled = false;
  }
}

const runExamples = () => run(false);
const submit = () => run(true);

// ---------------------------------------------------------------- debug input

function customCacheKey(slug) {
  return `lct:custom:${slug}`;
}

function loadCustomInput(slug) {
  try {
    return localStorage.getItem(customCacheKey(slug)) || '';
  } catch {
    return '';
  }
}

/**
 * Ad-hoc debug runs: paste raw JSON input and see the actual output with the
 * full per-case detail (log, errors) — no expected values, no attempt recorded,
 * no AI coaching. This is the "run & poke at it" loop.
 */
async function runCustom() {
  if (!state.problem) {
    alert('先加载一道题');
    return;
  }
  const raw = $('custom-input').value.trim();
  if (!raw) {
    alert('输入 JSON 用例，例如 [[2,7,11,15],9]；多条输入用 [[...],[...]]');
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    alert(`JSON 解析失败：${err.message}`);
    return;
  }

  // Normalize to a tests array. Accepted shapes:
  //   {"input":[...]}      one explicit test
  //   [arg1, arg2, ...]    one test whose length matches the parameter count
  //   [[...],[...]]        multiple tests (length disagrees with the parameter
  //                        count, or explicit inputs each wrapped once)
  const n = harness.isSystemDesign(state.problem.meta) ? 2 : (state.problem.meta.params || []).length;
  let tests;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.input)) {
    tests = [{ input: parsed.input }];
  } else if (Array.isArray(parsed) && parsed.length === n) {
    tests = [{ input: parsed }];
  } else if (Array.isArray(parsed) && parsed.length && parsed.every((t) => Array.isArray(t))) {
    tests = parsed.map((input) => ({ input }));
  } else {
    alert(`输入格式无法识别：本函数需要 ${n} 个参数，请用数组 [参数1, 参数2, …]（多条输入用 [[…],[…]]）。`);
    return;
  }

  try {
    localStorage.setItem(customCacheKey(state.problem.slug), raw);
  } catch { /* quota — non-fatal */ }

  const code = state.editor.get().trim();
  if (!code) {
    alert('编辑器是空的');
    return;
  }
  state.drafts[draftKey()] = state.editor.get();

  $('btn-run').disabled = true;
  $('btn-submit').disabled = true;
  $('btn-custom').disabled = true;
  status('调试运行…', true);
  $('result-pane').innerHTML = '<div class="empty"><span class="spin"></span> 执行中…</div>';

  try {
    const out = await execute(tests);
    if (out.compileError) {
      renderCompileError(out.compileError);
      status('编译失败');
      coachCompile(out.compileError);
      return;
    }
    if (out.fatal) {
      renderFatal(out.fatal, out.timedOut);
      status(out.timedOut ? '超时' : '运行错误');
      coachRuntime(out.fatal, out.timedOut);
      return;
    }
    const verdict = judge(tests, out.records);
    renderResult(verdict, out.stray);
    status('调试完成 — 展示输出，不判对错');
    if (verdict.counts.error > 0) {
      coachRuntime(verdict.firstFailure?.error || '', false);
    } else if (verdict.counts.fail > 0) {
      coachFailure(verdict);
    }
  } catch (err) {
    renderFatal(err.message);
    status('出错');
  } finally {
    $('btn-run').disabled = false;
    $('btn-submit').disabled = false;
    $('btn-custom').disabled = false;
  }
}

function verdictText(v) {
  const { pass, fail, error, unknown } = v.counts;
  const bits = [`${pass} 通过`];
  if (fail) bits.push(`${fail} 错误`);
  if (error) bits.push(`${error} 异常`);
  if (unknown) bits.push(`${unknown} 待定`);
  return bits.join(' · ');
}

// ---------------------------------------------------------------- rendering

function renderCompileError(text) {
  $('result-pane').innerHTML = `
    <div class="verdict fail">编译错误<small>代码没通过编译器，先修语法</small></div>
    <div class="err-box">${esc(text)}</div>`;
}

function renderFatal(text, timedOut) {
  $('result-pane').innerHTML = `
    <div class="verdict ${timedOut ? 'warn' : 'fail'}">${timedOut ? '执行超时' : '运行错误'}
      <small>${timedOut ? '大概率是死循环，或算法复杂度太高' : '代码在判题前就崩了'}</small></div>
    <div class="err-box">${esc(text)}</div>`;
}

function renderResult(verdict, stray) {
  const pane = $('result-pane');
  if (!verdict) {
    pane.innerHTML = '<div class="empty">运行代码后，这里显示判题结果与 AI 分析</div>';
    return;
  }

  const { counts } = verdict;
  let cls = 'warn';
  let title = '部分通过';
  let sub = verdictText(verdict);

  if (verdict.allPassed) {
    cls = 'pass';
    title = '全部通过';
    sub = `${counts.pass} 个用例 · ${verdict.totalMs.toFixed(1)}ms`;
  } else if (counts.error) {
    cls = 'fail';
    title = '运行异常';
  } else if (counts.fail) {
    cls = 'fail';
    title = '答案错误';
  } else if (counts.unknown === verdict.results.length) {
    cls = 'warn';
    title = '已执行，未判定';
    sub = '这些用例没有期望值，点「补全用例」让 AI 生成后即可判定';
  }

  const cases = verdict.results.map((r) => {
    const label = r.status === 'error' ? '异常' :
      r.status === 'pass' ? '通过' : r.status === 'fail' ? '错误' : '未判定';
    const body = r.status === 'error'
      ? `<div class="err-box">${esc(r.error)}</div>`
      : `<dl class="kv">
           <dt>输入</dt><dd>${esc(short(r.input))}</dd>
           <dt>输出</dt><dd class="${r.status === 'fail' ? 'bad' : ''}">${esc(short(r.actual))}</dd>
           ${r.expected !== undefined ? `<dt>期望</dt><dd class="good">${esc(short(r.expected))}</dd>` : ''}
           ${r.note ? `<dt>说明</dt><dd>${esc(r.note)}</dd>` : ''}
         </dl>`;
    return `<details class="case"${r.status !== 'pass' ? ' open' : ''}>
      <summary><span class="dot ${r.status}"></span>用例 ${r.i + 1} · ${label}
        <span class="ms">${r.ms != null ? `${r.ms.toFixed(2)}ms` : ''}</span></summary>
      <div class="case-body">${body}
        ${r.log ? `<div class="log-box">${esc(r.log)}</div>` : ''}</div>
    </details>`;
  }).join('');

  pane.innerHTML = `
    <div class="verdict ${cls}">${title}<small>${esc(sub)}</small></div>
    ${stray ? `<div class="log-box">${esc(stray)}</div>` : ''}
    ${cases}
    <div id="coach-slot"></div>`;
}

// ---------------------------------------------------------------- AI coach

function coachSlot() {
  let slot = $('coach-slot');
  if (!slot) {
    $('result-pane').insertAdjacentHTML('beforeend', '<div id="coach-slot"></div>');
    slot = $('coach-slot');
  }
  return slot;
}

function coachLoading(msg) {
  coachSlot().innerHTML = `<div class="card info"><span class="spin"></span> ${esc(msg)}</div>`;
}

function coachError(msg) {
  coachSlot().innerHTML = `<div class="card bad"><h4>AI 分析失败</h4><p>${esc(msg)}</p></div>`;
}

/**
 * Mechanical comparison cannot settle some cases (any-order answers, multiple
 * valid answers). The AI rules on each; the verdict is mutated in place and
 * re-rendered, so recordAttempt runs against the final truth.
 */
async function adjudicateUnknowns(verdict) {
  if (!state.env.ai?.configured) return;
  const undecided = verdict.results.filter((r) => r.status === 'unknown' && r.actual !== undefined);
  if (!undecided.length) return;

  coachLoading('AI 判定输出是否正确…');
  const rulings = await Promise.all(undecided.slice(0, 6).map((r) =>
    ai.adjudicate({ problem: state.problem, input: r.input, expected: r.expected, actual: r.actual })
      .then((v) => ({ i: r.i, ...v }))
      .catch(() => ({ i: r.i, correct: null }))));

  for (const r of rulings) {
    const target = verdict.results.find((x) => x.i === r.i);
    if (target && r.correct !== null) target.status = r.correct ? 'pass' : 'fail';
  }
  verdict.counts = verdict.results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, { pass: 0, fail: 0, error: 0, unknown: 0 });
  verdict.allPassed = verdict.counts.pass === verdict.results.length;
  renderResult(verdict);
}

async function coach(verdict) {
  if (!state.env.ai?.configured) {
    coachSlot().innerHTML = `<div class="card info"><h4>AI 教练未启用</h4>
      <p>创建 <code>config.json</code> 填入 baseUrl / model / apiKey，重启服务后即可获得复杂度分析、
      最优解对比与错因定位。</p></div>`;
    return;
  }

  const p = state.problem;
  const code = state.editor.get();
  const failure = verdict.results.find((r) => r.status === 'fail' || r.status === 'error');

  if (verdict.allPassed) {
    coachLoading('AI 正在做复杂度分析与最优解对比…');
    try {
      const review = await ai.reviewPassing({
        problem: p,
        language: state.language,
        code,
        timing: `${verdict.totalMs.toFixed(1)}ms total`,
        results: verdict.results
          .map((r) => `${JSON.stringify(r.input)} → ${JSON.stringify(r.actual)}`)
          .join('\n'),
      });
      renderReview(review);
      updateMastery(review.verdict);
    } catch (err) {
      coachError(err.message);
    }
    return;
  }

  coachLoading('AI 正在判断你的思路是否正确…');
  try {
    const diag = await ai.diagnoseFailure({
      problem: p,
      language: state.language,
      code,
      failure,
      counts: verdict.counts,
    });
    renderDiagnosis(diag);
    await saveNote(diag, code);
  } catch (err) {
    coachError(err.message);
  }
}

/**
 * Errors are the beginner's normal state — every run that fails (compile
 * error, crash, timeout) gets an AI explanation right away, on any run type.
 * Judged runs keep their separate diagnosis/review flows.
 */
async function coachCompile(errorText) {
  if (!state.env.ai?.configured) return;
  coachLoading('AI 解析编译错误…');
  try {
    const r = await ai.explainCompileError({
      problem: state.problem,
      language: state.language,
      code: state.editor.get(),
      errorText,
    });
    coachSlot().innerHTML = renderErrorCoach(r);
    wireChat();
  } catch (err) {
    coachError(err.message);
  }
}

async function coachRuntime(errorText, timedOut) {
  if (!state.env.ai?.configured) return;
  coachLoading(timedOut ? 'AI 分析超时原因…' : 'AI 解析运行错误…');
  try {
    const r = await ai.explainRuntimeError({
      problem: state.problem,
      language: state.language,
      code: state.editor.get(),
      errorText,
      timedOut,
    });
    coachSlot().innerHTML = renderErrorCoach(r);
    wireChat();
  } catch (err) {
    coachError(err.message);
  }
}

function renderErrorCoach(r) {
  const sound = r.approachSound === true;
  return `
    <div class="card ${sound ? 'accent' : 'bad'}">
      <h4>${sound ? '你的思路是对的，只是这里写岔了' : '思路需要调整'} · 报错解析</h4>
      ${r.approachSummary ? `<p><strong>你在做的：</strong>${esc(r.approachSummary)}</p>` : ''}
      ${r.whatItMeans ? `<p><strong>含义：</strong>${esc(r.whatItMeans)}</p>` : ''}
      ${r.where ? `<p><strong>位置：</strong>${esc(r.where)}</p>` : ''}
      ${r.howToFix ? `<p><strong>怎么修：</strong>${esc(r.howToFix)}</p>` : ''}
      ${!sound && r.approachHint ? `<p style="color:var(--accent)"><strong>思路层面：</strong>${esc(r.approachHint)}</p>` : ''}
      ${r.commonMistake ? `<p style="color:var(--muted)"><strong>常见原因：</strong>${esc(r.commonMistake)}</p>` : ''}
      ${r.encouragement ? `<p>${esc(r.encouragement)}</p>` : ''}
    </div>
    ${chatUi()}`;
}

/**
 * Non-submit wrong answers: the full diagnosis (approach judgement, hints),
 * but without saving a note — only judged submissions feed the 错题本.
 */
async function coachFailure(verdict) {
  if (!state.env.ai?.configured) return;
  const failure = verdict.results.find((r) => r.status === 'fail' || r.status === 'error');
  if (!failure) return;
  coachLoading('AI 正在判断你的思路是否正确…');
  try {
    const diag = await ai.diagnoseFailure({
      problem: state.problem,
      language: state.language,
      code: state.editor.get(),
      failure,
      counts: verdict.counts,
    });
    renderDiagnosis(diag);
  } catch (err) {
    coachError(err.message);
  }
}

// ---------------------------------------------------------------- getting started

/**
 * "求助" for a first-timer with no idea where to start. Fetches three staged
 * hints and reveals them ONE AT A TIME — each click reveals the next, so the
 * user tries in between instead of getting the whole answer at once.
 */
async function helpMe() {
  const p = state.problem;
  if (!p) { alert('先加载一道题'); return; }
  if (!state.env.ai?.configured) {
    alert('AI 未配置。在项目根目录创建 config.json 后重启服务。');
    return;
  }
  const btn = $('btn-help');
  btn.disabled = true;
  coachLoading('AI 正在为你想分阶段提示…');
  try {
    const data = await ai.hintsFor({ problem: p, language: state.language, code: state.editor.get() });
    state.hints = { slug: p.slug, warmup: data.warmup, hints: data.hints, stage: 0 };
    renderHints();
  } catch (err) {
    coachError(err.message);
  } finally {
    btn.disabled = false;
  }
}

function renderHints() {
  const h = state.hints;
  if (!h || !h.hints || !h.hints.length) {
    coachSlot().innerHTML = `<div class="card bad"><h4>求助</h4><p>AI 没能给出可用提示，请稍后再试。</p></div>`;
    return;
  }
  h.stage = Math.min(h.stage + 1, h.hints.length);
  const revealed = h.hints.slice(0, h.stage);
  const hasMore = h.stage < h.hints.length;

  coachSlot().innerHTML = `
    <div class="card info">
      <h4>💡 思路提示 · ${h.stage}/${h.hints.length}</h4>
      ${h.warmup ? `<p style="color:var(--muted)">${esc(h.warmup)}</p>` : ''}
      ${revealed.map((t, i) => `
        <div class="hint-item">
          <div class="hint-label">提示 ${i + 1}</div>
          <div class="hint-text">${esc(t)}</div>
        </div>`).join('')}
      ${hasMore
        ? `<button id="btn-next-hint" class="primary">看提示 ${h.stage + 1}</button>`
        : `<p style="color:var(--muted)">提示到此为止，动手试试；还是卡住，就在下方追问。</p>`}
    </div>
    ${chatUi()}`;
  wireChat();
  const next = $('btn-next-hint');
  if (next) next.addEventListener('click', renderHints);
}

function renderReview(r) {
  const badge = { optimal: 'good', acceptable: 'info', suboptimal: 'accent' }[r.verdict] || 'info';
  const label = { optimal: '已是最优', acceptable: '可以接受', suboptimal: '有更好解法' }[r.verdict] || r.verdict;

  coachSlot().innerHTML = `
    <div class="card ${badge}">
      <h4>AI 点评 · ${esc(label)}</h4>
      <div class="cx">
        <span>你的：<b>${esc(r.complexity?.time || '?')}</b> 时间 / <b>${esc(r.complexity?.space || '?')}</b> 空间</span>
      </div>
      <p>${esc(r.complexity?.explanation || '')}</p>
    </div>

    ${r.verdict !== 'optimal' && r.optimal ? `
    <div class="card accent">
      <h4>最优解</h4>
      <div class="cx"><span><b>${esc(r.optimal.time || '?')}</b> 时间 / <b>${esc(r.optimal.space || '?')}</b> 空间</span></div>
      <p>${esc(r.optimal.approach || '')}</p>
      ${r.gap ? `<p style="color:var(--accent)"><strong>差的那一步：</strong>${esc(r.gap)}</p>` : ''}
    </div>` : ''}

    ${(r.strengths || []).length ? `
    <div class="card good"><h4>做得好的地方</h4>
      <ul>${r.strengths.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>` : ''}

    ${(r.improvements || []).length ? `
    <div class="card"><h4>可以改进</h4>
      <ul>${r.improvements.map((i) =>
        `<li><strong>${esc(i.what)}</strong> — ${esc(i.why)}${i.how ? `<br><span style="color:var(--muted)">${esc(i.how)}</span>` : ''}</li>`
      ).join('')}</ul></div>` : ''}

    ${(r.idiomatic || []).length ? `
    <div class="card"><h4>语言习惯</h4>
      <ul>${r.idiomatic.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>` : ''}

    ${r.followUp ? `
    <div class="card info"><h4>面试官可能追问</h4><p>${esc(r.followUp)}</p></div>` : ''}

    ${chatUi()}`;
  wireChat();
}

function renderDiagnosis(d) {
  const sound = d.approachSound;
  const hints = (d.hints || []).map((h, i) =>
    `<button class="hint-btn" data-hint="${i}">💡 提示 ${i + 1}（点击展开）</button>
     <div class="hint-text" id="hint-${i}" style="display:none">${esc(h)}</div>`).join('');

  coachSlot().innerHTML = `
    <div class="card ${sound ? 'accent' : 'bad'}">
      <h4>${sound ? '思路正确，实现有 bug' : '思路需要调整'}</h4>
      <p><strong>你在做的：</strong>${esc(d.approachSummary || '')}</p>
      <p>${esc(d.diagnosis || '')}</p>
      ${d.errorCategory ? `<span class="tag">${esc(d.errorCategory)}</span>` : ''}
    </div>

    ${sound && d.bugLocation ? `
    <div class="card bad">
      <h4>问题位置${d.bugLocation.line ? ` · 第 ${esc(d.bugLocation.line)} 行` : ''}</h4>
      ${d.bugLocation.snippet ? `<div class="log-box">${esc(d.bugLocation.snippet)}</div>` : ''}
      <p class="mt">${esc(d.bugLocation.fix || '')}</p>
    </div>` : ''}

    ${d.whyThisCaseFails ? `
    <div class="card"><h4>这个用例为什么错</h4><p>${esc(d.whyThisCaseFails)}</p></div>` : ''}

    ${hints ? `<div class="card"><h4>渐进提示</h4>${hints}</div>` : ''}

    ${d.retryFocus ? `
    <div class="card accent"><h4>重写时只改这一点</h4><p>${esc(d.retryFocus)}</p></div>` : ''}

    ${d.encouragement ? `<div class="card good"><p>${esc(d.encouragement)}</p></div>` : ''}

    ${chatUi()}`;

  coachSlot().querySelectorAll('[data-hint]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const box = $(`hint-${btn.dataset.hint}`);
      box.style.display = box.style.display === 'none' ? 'block' : 'none';
    });
  });
  wireChat();
}

function chatUi() {
  return `
    <div class="card">
      <h4>继续追问</h4>
      <div class="chat-log" id="chat-log">${state.chat.map((m) =>
        `<div class="msg ${m.role === 'user' ? 'user' : 'ai'}">${esc(m.content)}</div>`).join('')}</div>
      <div class="chat-row">
        <input id="chat-input" placeholder="比如：为什么用堆比排序好？">
        <button id="chat-send">问</button>
      </div>
    </div>`;
}

function wireChat() {
  const input = $('chat-input');
  const send = $('chat-send');
  if (!input || !send) return;

  const ask = async () => {
    const q = input.value.trim();
    if (!q) return;
    input.value = '';
    state.chat.push({ role: 'user', content: q });
    $('chat-log').insertAdjacentHTML('beforeend', `<div class="msg user">${esc(q)}</div>`);
    send.disabled = true;

    const placeholder = document.createElement('div');
    placeholder.className = 'msg ai';
    placeholder.innerHTML = '<span class="spin"></span>';
    $('chat-log').appendChild(placeholder);

    try {
      const answer = await ai.ask({
        problem: state.problem,
        code: state.editor.get(),
        language: state.language,
        question: q,
        history: state.chat.slice(0, -1).slice(-8),
      });
      state.chat.push({ role: 'assistant', content: answer });
      placeholder.textContent = answer;
    } catch (err) {
      placeholder.className = 'msg ai';
      placeholder.textContent = `失败：${err.message}`;
    } finally {
      send.disabled = false;
    }
  };

  send.addEventListener('click', ask);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') ask();
  });
}

// ---------------------------------------------------------------- progress

const STATE_LABEL = {
  mastered: '已掌握',
  solved: '已通过',
  shaky: '勉强过',
  failed: '未通过',
  attempted: '尝试过',
};

function stateLabel(s) {
  return STATE_LABEL[s] || s;
}

/** Spaced-repetition-ish: the shakier the result, the sooner it comes back. */
function nextReview(state_, attempts) {
  const days = { mastered: 21, solved: 7, shaky: 3, failed: 1, attempted: 1 }[state_] ?? 3;
  const scaled = Math.max(1, Math.round(days / Math.max(1, attempts * 0.5)));
  return new Date(Date.now() + scaled * 86400_000).toISOString().slice(0, 10);
}

function recordAttempt(verdict) {
  const p = state.problem;
  const prev = state.progress[p.slug] || { attempts: 0, fails: 0, passes: 0 };
  const attempts = prev.attempts + 1;
  const passed = verdict.allPassed;

  let s;
  if (passed) s = attempts === 1 ? 'solved' : 'shaky';
  else s = 'failed';

  state.progress[p.slug] = {
    ...prev,
    slug: p.slug,
    title: p.title,
    difficulty: p.difficulty,
    tags: p.tags,
    attempts,
    passes: prev.passes + (passed ? 1 : 0),
    fails: prev.fails + (passed ? 0 : 1),
    state: s,
    language: state.language,
    lastAttempt: new Date().toISOString(),
    nextReview: nextReview(s, attempts),
  };
  persistProgress();
  renderProblem();
}

/** Called after a passing review: an optimal solution on a clean run means mastery. */
function updateMastery(reviewVerdict) {
  const p = state.problem;
  const rec = state.progress[p.slug];
  if (!rec) return;
  if (reviewVerdict === 'optimal' && rec.state === 'solved') {
    rec.state = 'mastered';
    rec.nextReview = nextReview('mastered', rec.attempts);
    persistProgress();
    renderProblem();
  }
}

async function persistProgress() {
  try {
    await api('/api/state/progress', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.progress),
    });
  } catch { /* non-fatal */ }
}

async function persistNotes() {
  try {
    await api('/api/state/notes', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.notes),
    });
  } catch { /* non-fatal */ }
}

async function saveNote(diagnosis, code) {
  const p = state.problem;
  try {
    const note = await ai.writeNote({
      problem: p,
      diagnosis,
      code,
      language: state.language,
    });
    const list = state.notes[p.slug] || [];
    list.unshift({
      ...note,
      slug: p.slug,
      problemTitle: p.title,
      difficulty: p.difficulty,
      approachSound: diagnosis.approachSound,
      at: new Date().toISOString(),
    });
    state.notes[p.slug] = list.slice(0, 8);
    await persistNotes();
  } catch { /* the diagnosis is already shown; a missing note is not fatal */ }
}

function renderProgress() {
  const rows = Object.values(state.progress)
    .sort((a, b) => (b.lastAttempt || '').localeCompare(a.lastAttempt || ''));

  if (!rows.length) {
    $('progress-body').innerHTML = '<div class="empty">还没有提交记录</div>';
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const due = rows.filter((r) => r.nextReview && r.nextReview <= today);
  const counts = rows.reduce((a, r) => {
    a[r.state] = (a[r.state] || 0) + 1;
    return a;
  }, {});

  $('progress-body').innerHTML = `
    <div class="row" style="flex-wrap:wrap;margin-bottom:14px">
      ${Object.entries(counts).map(([k, v]) =>
        `<span class="state ${k}">${stateLabel(k)} ${v}</span>`).join('')}
      <span class="spacer"></span>
      ${due.length ? `<span class="badge on">今天该复习 ${due.length} 题</span>` : ''}
    </div>
    <table class="prog">
      <thead><tr><th>题目</th><th>难度</th><th>状态</th><th>尝试</th><th>下次复习</th></tr></thead>
      <tbody>${rows.map((r) => `
        <tr>
          <td><a data-open="${esc(r.slug)}">${esc(r.title || r.slug)}</a></td>
          <td><span class="diff ${esc(r.difficulty)}">${esc(r.difficulty || '')}</span></td>
          <td><span class="state ${r.state}">${stateLabel(r.state)}</span></td>
          <td>${r.attempts}${r.fails ? ` <span style="color:var(--red)">(${r.fails}✗)</span>` : ''}</td>
          <td style="color:${r.nextReview <= today ? 'var(--accent)' : 'var(--muted)'}">${esc(r.nextReview || '')}</td>
        </tr>`).join('')}</tbody>
    </table>`;

  $('progress-body').querySelectorAll('[data-open]').forEach((a) => {
    a.addEventListener('click', () => {
      $('ov-progress').classList.remove('show');
      loadProblem(a.dataset.open);
    });
  });
}

function renderNotes() {
  const all = Object.values(state.notes).flat()
    .sort((a, b) => (b.at || '').localeCompare(a.at || ''));

  if (!all.length) {
    $('notes-body').innerHTML = `<div class="empty">还没有错题记录<br>
      提交出错时，AI 会自动归纳一条笔记到这里</div>`;
    return;
  }

  const byCat = all.reduce((a, n) => {
    const k = n.category || 'other';
    (a[k] = a[k] || []).push(n);
    return a;
  }, {});

  $('notes-body').innerHTML = `
    <div class="row" style="flex-wrap:wrap;margin-bottom:14px">
      ${Object.entries(byCat).sort((a, b) => b[1].length - a[1].length)
        .map(([k, v]) => `<span class="tag">${esc(k)} × ${v.length}</span>`).join('')}
    </div>
    ${all.map((n) => `
      <div class="note">
        <h4>${esc(n.title || '(无标题)')}</h4>
        <div class="note-meta">
          ${esc(n.problemTitle || n.slug)} ·
          <span class="tag">${esc(n.category || '')}</span>
          ${n.approachSound ? '<span class="tag">思路对</span>' : '<span class="tag">思路错</span>'}
          · ${esc((n.at || '').slice(0, 10))}
        </div>
        ${n.trigger ? `<p style="margin:0 0 5px"><strong>触发场景：</strong>${esc(n.trigger)}</p>` : ''}
        ${n.lesson ? `<p style="margin:0"><strong>教训：</strong>${esc(n.lesson)}</p>` : ''}
        ${(n.checklist || []).length ? `<ul>${n.checklist.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
        ${(n.relatedPatterns || []).length
          ? `<div class="note-meta mt">相关：${n.relatedPatterns.map((p) => esc(p)).join(' · ')}</div>` : ''}
      </div>`).join('')}`;
}

// ---------------------------------------------------------------- boot

async function boot() {
  await initEditor();

  try {
    await loadEnv();
  } catch (err) {
    $('env-badges').innerHTML = `<span class="badge off">后端不可用</span>`;
    console.error(err);
  }

  try {
    const [progress, notes] = await Promise.all([
      api('/api/state/progress').catch(() => ({})),
      api('/api/state/notes').catch(() => ({})),
    ]);
    state.progress = progress || {};
    state.notes = notes || {};
  } catch { /* start empty */ }

  $('load').addEventListener('click', () => loadProblem($('slug').value));
  $('slug').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadProblem($('slug').value);
  });

  $('lang').addEventListener('change', (e) => {
    state.drafts[draftKey()] = state.editor.get();
    state.language = e.target.value;
    applyTemplate();
  });

  $('btn-reset').addEventListener('click', () => {
    delete state.drafts[draftKey()];
    applyTemplate();
  });

  $('btn-run').addEventListener('click', runExamples);
  $('btn-submit').addEventListener('click', submit);
  $('btn-gen-tests').addEventListener('click', generateTests);
  $('btn-custom').addEventListener('click', runCustom);
  $('custom-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runCustom();
  });

  $('btn-help').addEventListener('click', helpMe);
  $('btn-lang').addEventListener('click', onLangToggle);

  $('btn-list').addEventListener('click', () => {
    $('ov-list').classList.add('show');
    if (!state.problemSet) loadProblemSet();
    else renderList();
    $('list-search').focus();
  });
  $('btn-list-refresh').addEventListener('click', () => loadProblemSet(true));
  $('list-search').addEventListener('input', () => {
    if (state.problemSet) renderList();
  });

  $('btn-progress').addEventListener('click', () => {
    renderProgress();
    $('ov-progress').classList.add('show');
  });
  $('btn-notes').addEventListener('click', () => {
    renderNotes();
    $('ov-notes').classList.add('show');
  });
  $('btn-settings').addEventListener('click', () => $('ov-settings').classList.add('show'));

  document.querySelectorAll('[data-close]').forEach((b) =>
    b.addEventListener('click', () => $(b.dataset.close).classList.remove('show')));
  document.querySelectorAll('.overlay').forEach((ov) =>
    ov.addEventListener('click', (e) => {
      if (e.target === ov) ov.classList.remove('show');
    }));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.overlay.show').forEach((o) => o.classList.remove('show'));
  });

  // Warm Pyodide in the background so the first Python submit is not a cold start.
  if (state.env?.python3?.available) {
    state.runner = new PythonRunner(state.env.pyodideVersion);
    state.runner.onStatus = (m) => status(m, true);
    state.runner.warmup().then(() => status('Python 就绪')).catch(() => status('Python 运行时加载失败'));
  }

  const initial = new URLSearchParams(location.search).get('slug');
  if (initial) loadProblem(initial);
}

boot();
