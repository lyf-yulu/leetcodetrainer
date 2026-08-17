/**
 * Compares judge output against expected values.
 *
 * LeetCode-style comparison is not plain equality: floats need tolerance, some
 * problems accept any order, and some accept multiple distinct answers. When a
 * mismatch cannot be settled mechanically we return `uncertain` rather than a
 * hard fail, and let the AI coach adjudicate.
 */

const FLOAT_EPS = 1e-5;

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (isNum(a) && isNum(b)) {
    if (Number.isInteger(a) && Number.isInteger(b)) return a === b;
    return Math.abs(a - b) <= FLOAT_EPS * Math.max(1, Math.abs(a), Math.abs(b));
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

function canonical(v) {
  if (Array.isArray(v)) {
    const inner = v.map(canonical);
    inner.sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
    return inner;
  }
  return v;
}

/** Order-insensitive at every nesting level — for "return in any order" problems. */
function equalUnordered(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/**
 * `opts.orderInsensitive` must be declared per-problem (the AI test-case generator
 * sets it from the statement). It is deliberately NOT the default: silently
 * ignoring order would pass genuinely wrong answers on problems where order is
 * part of the spec — returning intervals, paths, or sorted output.
 *
 * `opts.multipleValid` means even an ordered mismatch might still be acceptable,
 * so we defer to the AI adjudicator instead of failing outright.
 */
export function compare(actual, expected, opts = {}) {
  if (expected === undefined || expected === null) {
    return { status: 'unknown', reason: 'no expected value available' };
  }
  if (deepEqual(actual, expected)) return { status: 'pass' };

  // Design problems return null in void-method slots; compare only known slots.
  if (Array.isArray(actual) && Array.isArray(expected) && actual.length === expected.length
      && expected.some((e) => e === null)) {
    const sameWhereKnown = expected.every((e, i) => e === null || deepEqual(actual[i], e));
    if (sameWhereKnown) return { status: 'pass', note: 'void slots ignored' };
  }

  if (opts.orderInsensitive && Array.isArray(actual) && Array.isArray(expected)
      && equalUnordered(actual, expected)) {
    return { status: 'pass', note: '顺序不敏感，已匹配' };
  }

  if (opts.multipleValid) {
    return { status: 'unknown', reason: '本题可能有多个正确答案，需 AI 判定' };
  }

  // Same multiset but different order, on a problem that did not declare order
  // insensitivity: flag it rather than silently passing or hard-failing.
  if (Array.isArray(actual) && Array.isArray(expected) && equalUnordered(actual, expected)) {
    return { status: 'fail', note: '元素相同但顺序不同 — 若本题允许任意顺序，请重新生成用例' };
  }

  return { status: 'fail' };
}

/**
 * Judges a full run. `tests` may carry `expected`; when absent the case is
 * reported as `unknown` so the UI can show output without claiming correctness.
 */
export function judge(tests, records) {
  const byIndex = new Map(records.map((r) => [r.i, r]));
  const results = tests.map((test, i) => {
    const rec = byIndex.get(i);
    if (!rec) {
      return { i, status: 'error', input: test.input, error: 'no result produced (crash or timeout)' };
    }
    if (!rec.ok) {
      return { i, status: 'error', input: test.input, error: rec.err || 'runtime error', log: rec.log, ms: rec.ms };
    }
    const cmp = compare(rec.out, test.expected, {
      orderInsensitive: test.orderInsensitive,
      multipleValid: test.multipleValid,
    });
    return {
      i,
      status: cmp.status,
      note: cmp.note || cmp.reason,
      input: test.input,
      actual: rec.out,
      expected: test.expected,
      log: rec.log,
      ms: rec.ms,
    };
  });

  const counts = { pass: 0, fail: 0, error: 0, unknown: 0 };
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;

  return {
    results,
    counts,
    allPassed: counts.pass === results.length && results.length > 0,
    hasFailure: counts.fail > 0 || counts.error > 0,
    totalMs: results.reduce((s, r) => s + (r.ms || 0), 0),
    firstFailure: results.find((r) => r.status === 'fail' || r.status === 'error') || null,
  };
}
