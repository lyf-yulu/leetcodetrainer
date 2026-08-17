/**
 * Generates judge driver code from LeetCode's `metaData`.
 *
 * Three problem shapes exist:
 *   1. plain function   — {name, params, return}
 *   2. system design    — {classname, constructor, methods, systemdesign: true}
 *   3. structural types — params/return typed ListNode / TreeNode, which arrive
 *                         as flat JSON arrays and must be rebuilt into objects.
 *
 * Drivers emit one sentinel-prefixed JSON line per test so user `print()` output
 * stays separable from judge results.
 */

export const SENTINEL = '__LCT__';

const STRUCT_TYPES = /^(ListNode|TreeNode)(\[\])?$/;

export function isSystemDesign(meta) {
  return Boolean(meta && (meta.systemdesign || meta.classname));
}

/** Number of JSON lines that make up one test case in `exampleTestcases`. */
export function linesPerTest(meta) {
  return isSystemDesign(meta) ? 2 : (meta.params || []).length;
}

/**
 * `exampleTestcases` is newline-delimited JSON values, N lines per case.
 * Returns `[{ input: [...] }]` with no expected values — LeetCode's GraphQL
 * does not expose them, they get filled in later by AI extraction.
 */
export function parseExamples(meta, raw) {
  if (!raw) return [];
  const lines = String(raw).split('\n').map((l) => l.trim()).filter((l) => l.length);
  const n = linesPerTest(meta);
  if (n <= 0) return [];

  const tests = [];
  for (let i = 0; i + n <= lines.length; i += n) {
    const input = [];
    let bad = false;
    for (let k = 0; k < n; k++) {
      try {
        input.push(JSON.parse(lines[i + k]));
      } catch {
        bad = true;
        break;
      }
    }
    if (!bad) tests.push({ input });
  }
  return tests;
}

function b64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return typeof btoa === 'function' ? btoa(bin) : Buffer.from(str, 'utf8').toString('base64');
}

// ---------------------------------------------------------------- Python

const PY_PRELUDE = `import sys, json, io, time, base64, traceback
from typing import List, Optional, Dict, Tuple, Set

class ListNode:
    def __init__(self, val=0, next=None):
        self.val = val
        self.next = next

class TreeNode:
    def __init__(self, val=0, left=None, right=None):
        self.val = val
        self.left = left
        self.right = right

class Node:
    def __init__(self, val=0, neighbors=None, next=None, random=None, children=None):
        self.val = val
        self.neighbors = neighbors if neighbors is not None else []
        self.next = next
        self.random = random
        self.children = children if children is not None else []

def _lct_to_list(arr):
    head = None
    for v in reversed(arr or []):
        head = ListNode(v, head)
    return head

def _lct_from_list(node):
    out, seen, guard = [], set(), 0
    while node is not None:
        if id(node) in seen or guard > 100000:
            out.append("<cycle>")
            break
        seen.add(id(node))
        guard += 1
        out.append(node.val)
        node = node.next
    return out

def _lct_to_tree(arr):
    if not arr:
        return None
    root = TreeNode(arr[0])
    queue, i = [root], 1
    while queue and i < len(arr):
        node = queue.pop(0)
        if i < len(arr):
            v = arr[i]; i += 1
            if v is not None:
                node.left = TreeNode(v); queue.append(node.left)
        if i < len(arr):
            v = arr[i]; i += 1
            if v is not None:
                node.right = TreeNode(v); queue.append(node.right)
    return root

def _lct_from_tree(root):
    if root is None:
        return []
    out, queue = [], [root]
    while queue:
        node = queue.pop(0)
        if node is None:
            out.append(None)
            continue
        out.append(node.val)
        queue.append(node.left)
        queue.append(node.right)
    while out and out[-1] is None:
        out.pop()
    return out

def _lct_deser(v, t):
    if t == "ListNode": return _lct_to_list(v)
    if t == "TreeNode": return _lct_to_tree(v)
    if t in ("ListNode[]", "list<ListNode>"): return [_lct_to_list(x) for x in (v or [])]
    if t in ("TreeNode[]", "list<TreeNode>"): return [_lct_to_tree(x) for x in (v or [])]
    return v

def _lct_ser(v, t):
    if t == "ListNode": return _lct_from_list(v)
    if t == "TreeNode": return _lct_from_tree(v)
    if t in ("ListNode[]", "list<ListNode>"): return [_lct_from_list(x) for x in (v or [])]
    if t in ("TreeNode[]", "list<TreeNode>"): return [_lct_from_tree(x) for x in (v or [])]
    return v

def _lct_emit(rec):
    _LCT_REAL_STDOUT.write("${SENTINEL}" + json.dumps(rec, default=str) + "\\n")
    _LCT_REAL_STDOUT.flush()

_LCT_REAL_STDOUT = sys.stdout
`;

function pyDriverFunction(meta) {
  const paramTypes = (meta.params || []).map((p) => p.type);
  return `
_LCT_PARAM_TYPES = ${JSON.stringify(paramTypes)}
_LCT_RETURN_TYPE = ${JSON.stringify(meta.return?.type || 'void')}
_LCT_METHOD = ${JSON.stringify(meta.name)}

for _lct_i, _lct_test in enumerate(_LCT_TESTS):
    _lct_args = [_lct_deser(a, _LCT_PARAM_TYPES[j]) for j, a in enumerate(_lct_test["input"])]
    _lct_buf = io.StringIO()
    sys.stdout = _lct_buf
    _lct_t0 = time.perf_counter()
    _lct_rec = {"i": _lct_i}
    try:
        _lct_sol = Solution()
        _lct_raw = getattr(_lct_sol, _LCT_METHOD)(*_lct_args)
        if _LCT_RETURN_TYPE == "void":
            _lct_rec["out"] = _lct_ser(_lct_args[0], _LCT_PARAM_TYPES[0])
        else:
            _lct_rec["out"] = _lct_ser(_lct_raw, _LCT_RETURN_TYPE)
        _lct_rec["ok"] = True
    except Exception:
        _lct_rec["ok"] = False
        _lct_rec["err"] = traceback.format_exc(limit=8)
    finally:
        _lct_rec["ms"] = round((time.perf_counter() - _lct_t0) * 1000, 3)
        sys.stdout = _LCT_REAL_STDOUT
    _lct_rec["log"] = _lct_buf.getvalue()[:4000]
    _lct_emit(_lct_rec)
`;
}

function pyDriverDesign(meta) {
  const methodTypes = {};
  for (const m of meta.methods || []) {
    methodTypes[m.name] = (m.params || []).map((p) => p.type);
  }
  return `
_LCT_CLASS = ${JSON.stringify(meta.classname)}
_LCT_CTOR_TYPES = ${JSON.stringify((meta.constructor?.params || []).map((p) => p.type))}
_LCT_METHOD_TYPES = ${JSON.stringify(methodTypes)}

for _lct_i, _lct_test in enumerate(_LCT_TESTS):
    _lct_ops = _lct_test["input"][0]
    _lct_argl = _lct_test["input"][1]
    _lct_buf = io.StringIO()
    sys.stdout = _lct_buf
    _lct_t0 = time.perf_counter()
    _lct_rec = {"i": _lct_i}
    try:
        _lct_obj = None
        _lct_res = []
        for _lct_k, _lct_op in enumerate(_lct_ops):
            _lct_a = _lct_argl[_lct_k] if _lct_k < len(_lct_argl) else []
            if _lct_k == 0:
                _lct_ctor = [_lct_deser(v, _LCT_CTOR_TYPES[j] if j < len(_LCT_CTOR_TYPES) else "")
                             for j, v in enumerate(_lct_a)]
                _lct_obj = globals()[_LCT_CLASS](*_lct_ctor)
                _lct_res.append(None)
            else:
                _lct_ts = _LCT_METHOD_TYPES.get(_lct_op, [])
                _lct_ca = [_lct_deser(v, _lct_ts[j] if j < len(_lct_ts) else "")
                           for j, v in enumerate(_lct_a)]
                _lct_res.append(getattr(_lct_obj, _lct_op)(*_lct_ca))
        _lct_rec["out"] = _lct_res
        _lct_rec["ok"] = True
    except Exception:
        _lct_rec["ok"] = False
        _lct_rec["err"] = traceback.format_exc(limit=8)
    finally:
        _lct_rec["ms"] = round((time.perf_counter() - _lct_t0) * 1000, 3)
        sys.stdout = _LCT_REAL_STDOUT
    _lct_rec["log"] = _lct_buf.getvalue()[:4000]
    _lct_emit(_lct_rec)
`;
}

const USER_BANNER = '# ---------------- user solution ----------------';

export function buildPython(meta, userCode, tests) {
  const payload = b64(JSON.stringify(tests));
  const driver = isSystemDesign(meta) ? pyDriverDesign(meta) : pyDriverFunction(meta);
  return [
    PY_PRELUDE,
    USER_BANNER,
    userCode,
    '# ---------------- judge driver ----------------',
    `_LCT_TESTS = json.loads(base64.b64decode("${payload}").decode("utf-8"))`,
    driver,
  ].join('\n');
}

/**
 * Line number at which the user's code starts inside the generated file.
 * Tracebacks and compiler errors point at generated lines, which are meaningless
 * to the user (and actively mislead the AI coach), so they get remapped.
 */
export function userCodeOffset(language) {
  if (language === 'python3' || language === 'python') {
    // Derived from the same join() the builder uses, so it cannot drift: prelude
    // lines, then the banner, then user code begins on the next line.
    return [PY_PRELUDE, USER_BANNER].join('\n').split('\n').length + 1;
  }
  return null;
}

// ---------------------------------------------------------------- dispatch

export function build(language, meta, userCode, tests) {
  if (language === 'python3' || language === 'python') {
    return buildPython(meta, userCode, tests);
  }
  throw new Error(`harness for ${language} not implemented yet`);
}

/** Splits raw stdout into judge records and the user's own stray output. */
export function parseOutput(stdout) {
  const records = [];
  const stray = [];
  for (const line of String(stdout).split('\n')) {
    if (line.startsWith(SENTINEL)) {
      try {
        records.push(JSON.parse(line.slice(SENTINEL.length)));
      } catch {
        stray.push(line);
      }
    } else if (line.length) {
      stray.push(line);
    }
  }
  return { records, stray: stray.join('\n') };
}

/**
 * Rewrites generated-file line numbers back to the user's own numbering, and drops
 * driver frames entirely — a traceback through `_lct_*` internals is noise, and
 * feeding those line numbers to the AI coach makes it point at the wrong code.
 *
 * `offset` is the 1-based line in the generated file where user code begins.
 */
export function remapTrace(text, offset, userLineCount) {
  if (!text || !offset) return text || '';
  const lines = String(text).split('\n');
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^(\s*File ")([^"]*)(", line )(\d+)(.*)$/);
    if (!m) {
      out.push(line);
      continue;
    }
    const gen = Number(m[4]);
    const mapped = gen - offset + 1;

    // Frame lies outside the user's code: it is judge scaffolding, drop it and the
    // source-echo line that follows.
    if (mapped < 1 || (userLineCount && mapped > userLineCount)) {
      if (i + 1 < lines.length && /^\s{4,}\S/.test(lines[i + 1] || '')) i++;
      continue;
    }
    out.push(`${m[1]}your code${m[3]}${mapped}${m[5]}`);
  }

  const cleaned = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  // If every frame was scaffolding, keep at least the exception line.
  if (!/line \d+/.test(cleaned)) {
    const last = String(text).trim().split('\n').pop();
    return cleaned || last || '';
  }
  return cleaned;
}

/** Same idea for C++/Java compiler diagnostics, which cite `main.cpp:259:60`. */
export function remapCompilerErrors(text, offset, userLineCount) {
  if (!text || !offset) return text || '';
  return String(text).split('\n').map((line) =>
    line.replace(/^(\s*)(?:main\.cpp|Main\.java):(\d+)(:\d+)?/g, (full, pad, ln, col) => {
      const mapped = Number(ln) - offset + 1;
      if (mapped < 1 || (userLineCount && mapped > userLineCount)) {
        return `${pad}[judge scaffolding]`;
      }
      return `${pad}your code:${mapped}${col || ''}`;
    })
  ).join('\n');
}

export function usesStructTypes(meta) {
  const types = [
    ...(meta.params || []).map((p) => p.type),
    meta.return?.type,
  ].filter(Boolean);
  return types.some((t) => STRUCT_TYPES.test(t));
}
