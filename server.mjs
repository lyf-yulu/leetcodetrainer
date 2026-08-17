import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const PROBLEMS = path.join(DATA, 'problems');
const CONFIG = path.join(ROOT, 'config.json');
const PORT = Number(process.env.PORT) || 8080;

const MAX_OUTPUT = 256 * 1024;
const RUN_TIMEOUT_MS = 10_000;
const COMPILE_TIMEOUT_MS = 30_000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const GRAPHQL_QUERY = `query q($t: String!) {
  question(titleSlug: $t) {
    questionId
    questionFrontendId
    title
    titleSlug
    difficulty
    content
    metaData
    exampleTestcases
    hints
    topicTags { name slug }
    codeSnippets { langSlug code }
  }
}`;

// ---------------------------------------------------------------- utilities

function json(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

async function readBody(req, limit = 4 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function clip(text) {
  if (text.length <= MAX_OUTPUT) return { text, truncated: false };
  return { text: text.slice(0, MAX_OUTPUT), truncated: true };
}

async function readConfig() {
  try {
    return JSON.parse(await fs.readFile(CONFIG, 'utf8'));
  } catch {
    return {};
  }
}

async function which(cmd) {
  return new Promise((resolve) => {
    execFile('/usr/bin/which', [cmd], (err, stdout) => {
      resolve(err ? null : stdout.trim() || null);
    });
  });
}

/**
 * Java is special: `javac` exists as a stub on macOS even with no JDK, and only
 * fails at invocation. Probing the path is not enough — we must run it.
 */
function probe(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000 }, (err, stdout, stderr) => {
      const out = `${stdout || ''}${stderr || ''}`.trim();
      if (err && !out) return resolve(null);
      if (/unable to locate a java runtime|no such file/i.test(out)) return resolve(null);
      if (err && err.code === 'ENOENT') return resolve(null);
      resolve(out.split('\n')[0].slice(0, 120));
    });
  });
}

let javaToolchain = null;

/**
 * Locates a working javac/java pair. Order:
 *   1. $JAVA_HOME — the explicit signal, wins if its bin/ has real binaries
 *   2. `brew --prefix openjdk` — Homebrew's JDK is NOT registered with the
 *      /usr/bin/java stub until symlinked into /Library/Java (needs sudo), so
 *      check the cellar directly
 *   3. plain PATH — works when the JDK is properly registered
 * Returns { java, javac, version } paths or null.
 */
async function findJavaToolchain() {
  const tryBin = async (dir) => {
    const javac = path.join(dir, 'bin', 'javac');
    const version = await probe(javac, ['-version']);
    return version ? { java: path.join(dir, 'bin', 'java'), javac, version } : null;
  };

  if (process.env.JAVA_HOME) {
    const tc = await tryBin(process.env.JAVA_HOME);
    if (tc) return tc;
  }
  const brew = await which('brew');
  if (brew) {
    try {
      const { stdout } = await new Promise((resolve, reject) =>
        execFile(brew, ['--prefix', 'openjdk'], (err, stdout, stderr) =>
          err ? reject(err) : resolve({ stdout })));
      if (stdout.trim()) {
        const tc = await tryBin(stdout.trim());
        if (tc) return tc;
      }
    } catch { /* openjdk not installed */ }
  }
  const [javaVer, javacVer] = await Promise.all([
    probe('java', ['-version']),
    probe('javac', ['-version']),
  ]);
  if (javaVer && javacVer) return { java: 'java', javac: 'javac', version: javacVer };
  return null;
}

async function getJavaToolchain() {
  if (javaToolchain === null) javaToolchain = await findJavaToolchain();
  return javaToolchain; // may be null — that IS a cached result
}

/** Spawn detached so we can kill the whole process group on timeout. */
function exec(cmd, args, { cwd, stdin = '', timeout }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ code: -1, stdout: '', stderr: String(err.message), timedOut: false });
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeout);

    child.stdout.on('data', (d) => {
      if (stdout.length < MAX_OUTPUT * 2) stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < MAX_OUTPUT * 2) stderr += d.toString('utf8');
    });

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };

    child.on('error', (err) => {
      stderr += String(err.message);
      finish(-1);
    });
    child.on('close', (code) => finish(code));

    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

// ---------------------------------------------------------------- endpoints

let envCache = null;

async function handleEnv(res) {
  if (!envCache) {
    const [jc, cxx] = await Promise.all([
      getJavaToolchain(),
      probe('c++', ['--version']),
    ]);
    const cfg = await readConfig();
    envCache = {
      python3: { available: true, note: 'Pyodide (browser WASM)' },
      java: { available: Boolean(jc), version: jc?.version || null },
      cpp: { available: Boolean(cxx), version: cxx },
      ai: { configured: Boolean(cfg.apiKey && cfg.baseUrl), model: cfg.model || null },
      pyodideVersion: cfg.pyodideVersion || 'v0.28.3',
    };
  }
  json(res, 200, envCache);
}

/**
 * Accepts a slug, a problem number ("1"), or a title ("two sum"), and
 * resolves it through the problemset cache. Paid-only problems are rejected
 * with a clear message instead of a confusing GraphQL miss.
 */
/** Problemset straight from disk — no fetch-on-miss, used for cheap lookups. */
async function readProblemSetCache() {
  try {
    return JSON.parse(await fs.readFile(PROBLEMSET, 'utf8'));
  } catch {
    return null;
  }
}

async function resolveProblem(raw) {
  const q = String(raw || '').trim().toLowerCase();
  if (!q) return { error: '请输入题号、题名或 slug（或用「题库」选择）' };
  if (/^[a-z0-9-]{1,120}$/.test(q)) {
    // Exact slug — but GraphQL answers premium problems with a hollow
    // question (content: null) instead of a miss, so flag them here.
    const hit = (await readProblemSetCache())?.problems?.find((p) => p.slug === q);
    if (hit?.paidOnly) return { paidOnly: true, title: hit.title };
    return { slug: q };
  }

  const ps = await readProblemSet();
  const hit = ps?.problems?.find((p) =>
    String(p.id) === q || p.title.toLowerCase().includes(q) || p.slug.includes(q));
  if (!hit) return { error: `没有找到题目「${raw}」— 检查拼写，或用「题库」搜索` };
  if (hit.paidOnly) return { paidOnly: true, title: hit.title };
  return { slug: hit.slug };
}

async function handleProblem(res, raw) {
  const resolved = await resolveProblem(raw);
  if (resolved.error) return json(res, 404, { error: resolved.error });
  if (resolved.paidOnly) {
    return json(res, 403, { error: `「${resolved.title}」是会员专享题，需要登录 LeetCode 才能拉取` });
  }
  const slug = resolved.slug;

  const cached = path.join(PROBLEMS, `${slug}.json`);
  try {
    const hit = JSON.parse(await fs.readFile(cached, 'utf8'));
    return json(res, 200, { ...hit, cached: true });
  } catch {
    // fall through to network
  }

  let payload;
  try {
    const resp = await fetch('https://leetcode.com/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0',
        Referer: `https://leetcode.com/problems/${slug}/`,
      },
      body: JSON.stringify({ query: GRAPHQL_QUERY, variables: { t: slug } }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!resp.ok) return json(res, 502, { error: `leetcode returned HTTP ${resp.status}` });
    payload = await resp.json();
  } catch (err) {
    return json(res, 502, { error: `fetch failed: ${err.message}` });
  }

  const q = payload?.data?.question;
  if (q && !q.content) {
    // Hollow question: premium data or a genuinely content-less problem.
    const hit = (await readProblemSetCache())?.problems?.find((p) => p.slug === slug);
    if (hit?.paidOnly) {
      return json(res, 403, { error: `「${hit.title}」是会员专享题，需要登录 LeetCode 才能拉取` });
    }
    return json(res, 404, { error: `「${q.title || slug}」的题面数据为空，暂无法使用` });
  }
  if (!q) {
    // Slug-shaped but unknown to GraphQL: the slug may have been renamed or
    // the problem is premium — try the problemset before giving up.
    try {
      const ps = await readProblemSet();
      const hit = ps?.problems?.find((p) =>
        p.slug === slug || String(p.id) === slug || p.title.toLowerCase().includes(slug));
      if (hit?.paidOnly) {
        return json(res, 403, { error: `「${hit.title}」是会员专享题，需要登录 LeetCode 才能拉取` });
      }
      if (hit && hit.slug !== slug) return handleProblem(res, hit.slug);
    } catch { /* problemset unavailable — use the generic message */ }
    return json(res, 404, { error: `没有找到题目「${raw}」— 检查拼写，或用「题库」搜索` });
  }

  let meta = null;
  try {
    meta = JSON.parse(q.metaData);
  } catch {
    return json(res, 502, { error: 'could not parse metaData' });
  }

  const problem = {
    slug,
    id: q.questionFrontendId,
    title: q.title,
    difficulty: q.difficulty,
    content: q.content,
    meta,
    exampleTestcases: q.exampleTestcases,
    hints: q.hints || [],
    tags: (q.topicTags || []).map((t) => t.name),
    snippets: Object.fromEntries((q.codeSnippets || []).map((s) => [s.langSlug, s.code])),
    fetchedAt: new Date().toISOString(),
  };

  await fs.mkdir(PROBLEMS, { recursive: true });
  await fs.writeFile(cached, JSON.stringify(problem, null, 2));
  json(res, 200, { ...problem, cached: false });
}

const RUNNERS = {
  cpp: {
    file: 'main.cpp',
    async build(dir) {
      return exec('c++', ['-std=c++17', '-O2', '-o', 'prog', 'main.cpp'], {
        cwd: dir,
        timeout: COMPILE_TIMEOUT_MS,
      });
    },
    run(dir, stdin, timeout) {
      return exec(path.join(dir, 'prog'), [], { cwd: dir, stdin, timeout });
    },
  },
  java: {
    file: 'Main.java',
    async build(dir, jc) {
      return exec(jc.javac, ['Main.java'], { cwd: dir, timeout: COMPILE_TIMEOUT_MS });
    },
    run(dir, stdin, timeout, jc) {
      return exec(jc.java, ['-Xss64m', '-cp', dir, 'Main'], { cwd: dir, stdin, timeout });
    },
  },
};

async function handleRun(res, body) {
  const { language, source, stdin = '', timeout } = body || {};
  const runner = RUNNERS[language];
  if (!runner) return json(res, 400, { error: `unsupported language: ${language}` });
  if (typeof source !== 'string' || !source.trim()) {
    return json(res, 400, { error: 'source is required' });
  }
  const jc = language === 'java' ? await getJavaToolchain() : null;
  if (language === 'java' && !jc) {
    return json(res, 400, {
      error: 'no Java toolchain found — install with `brew install openjdk` '
        + '(JAVA_HOME and the Homebrew cellar are auto-detected, no symlink needed) '
        + 'or install a JDK that registers with /usr/bin/java, then restart',
    });
  }

  const limit = Math.min(Number(timeout) || RUN_TIMEOUT_MS, 30_000);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lctrainer-'));
  try {
    await fs.writeFile(path.join(dir, runner.file), source);

    const build = await runner.build(dir, jc);
    if (build.timedOut) {
      return json(res, 200, { ok: false, stage: 'compile', error: 'compilation timed out' });
    }
    if (build.code !== 0) {
      return json(res, 200, {
        ok: false,
        stage: 'compile',
        error: clip(build.stderr || build.stdout || 'compilation failed').text,
      });
    }

    const run = await runner.run(dir, stdin, limit, jc);
    const out = clip(run.stdout);
    const err = clip(run.stderr);
    json(res, 200, {
      ok: !run.timedOut && run.code === 0,
      stage: 'run',
      timedOut: run.timedOut,
      exitCode: run.code,
      stdout: out.text,
      stderr: err.text,
      truncated: out.truncated || err.truncated,
    });
  } catch (err) {
    json(res, 500, { error: err.message });
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** One completion against the configured OpenAI-compatible provider. */
async function requestAi(cfg, messages, { json = false, maxTokens = 2048, temperature = 0.2 } = {}) {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const payload = {
    model: cfg.model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (json) payload.response_format = { type: 'json_object' };

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await resp.text();
  if (!resp.ok) {
    return { ok: false, error: `AI provider HTTP ${resp.status}`, detail: text.slice(0, 800) };
  }
  try {
    const data = JSON.parse(text);
    return { ok: true, content: data?.choices?.[0]?.message?.content ?? '', usage: data.usage || null };
  } catch {
    return { ok: false, error: 'AI provider returned malformed JSON', detail: text.slice(0, 300) };
  }
}

async function handleAi(res, body) {
  const cfg = await readConfig();
  if (!cfg.apiKey || !cfg.baseUrl) {
    return json(res, 400, {
      error: 'AI not configured. Create config.json with baseUrl, apiKey and model.',
    });
  }
  const { messages, temperature = 0.2, maxTokens = 2048, responseFormat } = body || {};
  if (!Array.isArray(messages) || !messages.length) {
    return json(res, 400, { error: 'messages is required' });
  }

  try {
    const r = await requestAi(cfg, messages, {
      json: responseFormat === 'json',
      maxTokens,
      temperature,
    });
    if (!r.ok) return json(res, 502, { error: r.error, detail: r.detail });
    json(res, 200, { content: r.content, usage: r.usage });
  } catch (err) {
    json(res, 502, { error: `AI request failed: ${err.message}` });
  }
}

// ---------------------------------------------------------------- problemset

const PROBLEMSET = path.join(DATA, 'problemset.json');
const PROBLEMSET_MAX_AGE_MS = 24 * 3600 * 1000;

/**
 * The full problem list (number + title) for the picker. LeetCode's own list
 * endpoint is fetched once a day and cached on disk — no batch crawling.
 */
async function fetchProblemSet() {
  const resp = await fetch('https://leetcode.com/api/problems/all/', {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Referer: 'https://leetcode.com/problemset/',
    },
    signal: AbortSignal.timeout(25_000),
  });
  if (!resp.ok) throw new Error(`leetcode returned HTTP ${resp.status}`);
  const data = await resp.json();

  const problems = (data.stat_status_pairs || [])
    .filter((p) => p.stat && !p.stat.question__hide)
    .map((p) => ({
      id: p.stat.frontend_question_id,
      title: p.stat.question__title,
      slug: p.stat.question__title_slug,
      difficulty: ['Easy', 'Medium', 'Hard'][(p.difficulty?.level || 1) - 1] || null,
      paidOnly: Boolean(p.paid_only),
    }))
    .sort((a, b) => Number(a.id) - Number(b.id));

  const payload = { fetchedAt: new Date().toISOString(), problems };
  await fs.writeFile(PROBLEMSET, JSON.stringify(payload));
  return payload;
}

/** Cached problemset, or a fresh fetch when the cache is missing/stale. */
async function readProblemSet() {
  try {
    const st = await fs.stat(PROBLEMSET);
    if (Date.now() - st.mtimeMs < PROBLEMSET_MAX_AGE_MS) {
      return JSON.parse(await fs.readFile(PROBLEMSET, 'utf8'));
    }
  } catch { /* not cached yet */ }
  return fetchProblemSet();
}

async function handleProblemSet(res, refresh) {
  try {
    const payload = refresh ? await fetchProblemSet() : await readProblemSet();
    json(res, 200, payload);
  } catch (err) {
    json(res, 502, { error: `problemset fetch failed: ${err.message}` });
  }
}

// ---------------------------------------------------------------- translation

const TRANSLATE_SYSTEM = `You translate LeetCode problem statements from English to Simplified Chinese.
Rules:
- Keep the HTML structure and tags EXACTLY as given — translate only the text content.
- Keep all numbers, variable names, code identifiers, and example input/output unchanged.
- Use precise technical Chinese (算法术语如：数组、链表、哈希表、时间复杂度).
- Keep formatting tags (<code>, <pre>, <sup>, <strong>, <em>, <ul>, <li>) in place.
Return JSON only: {"title":"translated title","content":"translated HTML"}`;

/**
 * Chinese statement, tried in order:
 *   1. cached translation (already in the problem file)
 *   2. leetcode.cn's official translatedContent — free, native quality
 *   3. AI translation of the English statement
 * The result is merged into the problem cache, so it costs at most one fetch
 * or one AI call per problem ever.
 */
async function handleTranslate(res, body) {
  const slug = String(body?.slug || '');
  if (!/^[a-z0-9-]{1,120}$/.test(slug)) return json(res, 400, { error: 'invalid slug' });

  const file = path.join(PROBLEMS, `${slug}.json`);
  let problem;
  try {
    problem = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return json(res, 404, { error: 'problem not cached — load it first' });
  }
  if (problem.translatedContent) {
    return json(res, 200, {
      translatedTitle: problem.translatedTitle || null,
      translatedContent: problem.translatedContent,
      translatedBase: problem.translatedBase || 'https://leetcode.cn',
    });
  }

  // 1) official translation
  try {
    const resp = await fetch('https://leetcode.cn/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0',
        Referer: `https://leetcode.cn/problems/${slug}/`,
      },
      body: JSON.stringify({
        query: 'query q($t: String!) { question(titleSlug: $t) { translatedTitle translatedContent } }',
        variables: { t: slug },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (resp.ok) {
      const data = await resp.json();
      const q = data?.data?.question;
      if (q?.translatedContent) {
        problem.translatedTitle = q.translatedTitle || null;
        problem.translatedContent = q.translatedContent;
        problem.translatedBase = 'https://leetcode.cn';
        await fs.writeFile(file, JSON.stringify(problem, null, 2));
        return json(res, 200, {
          translatedTitle: problem.translatedTitle,
          translatedContent: problem.translatedContent,
          translatedBase: problem.translatedBase,
        });
      }
    }
  } catch { /* leetcode.cn unreachable — fall through to AI */ }

  // 2) AI fallback
  const cfg = await readConfig();
  if (!cfg.apiKey || !cfg.baseUrl) {
    return json(res, 502, {
      error: 'translation unavailable: leetcode.cn unreachable and no AI configured',
    });
  }
  const r = await requestAi(cfg, [
    { role: 'system', content: TRANSLATE_SYSTEM },
    {
      role: 'user',
      content: `Title: ${problem.title}\n\nStatement HTML:\n${problem.content.slice(0, 8000)}`,
    },
  ], { json: true, maxTokens: 6000, temperature: 0.1 });
  if (!r.ok) return json(res, 502, { error: r.error, detail: r.detail });

  let translated = r.content.trim();
  let translatedTitle = null;
  try {
    const parsed = JSON.parse(translated.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''));
    if (parsed && typeof parsed.content === 'string' && parsed.content.trim()) {
      translated = parsed.content.trim();
      translatedTitle = typeof parsed.title === 'string' ? parsed.title.trim() : null;
    }
  } catch { /* use the raw text as the content */ }

  problem.translatedTitle = translatedTitle;
  problem.translatedContent = translated;
  problem.translatedBase = 'https://leetcode.com';
  await fs.writeFile(file, JSON.stringify(problem, null, 2));
  json(res, 200, {
    translatedTitle,
    translatedContent: translated,
    translatedBase: problem.translatedBase,
  });
}

async function handleState(res, name, method, body) {
  if (!/^(progress|notes)$/.test(name)) return json(res, 400, { error: 'unknown state' });
  const file = path.join(DATA, `${name}.json`);
  if (method === 'GET') {
    try {
      return json(res, 200, JSON.parse(await fs.readFile(file, 'utf8')));
    } catch {
      return json(res, 200, {});
    }
  }
  await fs.mkdir(DATA, { recursive: true });
  await fs.writeFile(file, JSON.stringify(body ?? {}, null, 2));
  json(res, 200, { ok: true });
}

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const target = path.join(PUBLIC, rel);
  if (!target.startsWith(PUBLIC + path.sep) && target !== path.join(PUBLIC, 'index.html')) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const buf = await fs.readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target)] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
  }
}

// ---------------------------------------------------------------- server

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const { pathname } = url;

  try {
    if (pathname === '/api/env' && req.method === 'GET') {
      return await handleEnv(res);
    }
    if (pathname === '/api/problem' && req.method === 'GET') {
      return await handleProblem(res, url.searchParams.get('q') || url.searchParams.get('slug') || '');
    }
    if (pathname === '/api/run' && req.method === 'POST') {
      return await handleRun(res, await readBody(req));
    }
    if (pathname === '/api/ai' && req.method === 'POST') {
      return await handleAi(res, await readBody(req));
    }
    if (pathname === '/api/problemset' && req.method === 'GET') {
      return await handleProblemSet(res, url.searchParams.get('refresh') === '1');
    }
    if (pathname === '/api/translate' && req.method === 'POST') {
      return await handleTranslate(res, await readBody(req));
    }
    const state = pathname.match(/^\/api\/state\/(\w+)$/);
    if (state && (req.method === 'GET' || req.method === 'PUT')) {
      return await handleState(res, state[1], req.method, req.method === 'PUT' ? await readBody(req) : null);
    }
    if (pathname.startsWith('/api/')) {
      return json(res, 404, { error: 'unknown endpoint' });
    }
    await serveStatic(res, pathname);
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`leetcode trainer  →  http://127.0.0.1:${PORT}`);
  console.log('bound to 127.0.0.1 only — /api/run executes code locally, do not expose publicly');
});
