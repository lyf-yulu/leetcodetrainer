/**
 * AI coach. Three distinct paths, because "correct but suboptimal" and "wrong but
 * on the right track" need completely different pedagogy:
 *
 *   passed          -> complexity audit + optimal-solution gap
 *   failed          -> is the *approach* sound? if yes, locate the bug; if no, escalating hints
 *   testcases       -> extract expected outputs from the statement, synthesize edge cases
 *
 * The rule threaded through every prompt: never hand over a full working solution
 * unless the user explicitly asks for it.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One call, retried on transient failures. Providers occasionally return an
 * HTTP 5xx or — worse — malformed JSON for a `json` request; a single glitch
 * should not kill the whole coaching flow, so JSON-mode calls validate the
 * payload before returning and retry with a backoff.
 */
async function call(messages, { json = false, maxTokens = 2048, temperature = 0.2 } = {}) {
  const attempts = json ? 3 : 2;
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const resp = await fetch('/api/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, responseFormat: json ? 'json' : undefined, maxTokens, temperature }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `AI call failed (HTTP ${resp.status})`);
      const content = data.content || '';
      if (json) parseJson(content); // throws on malformed JSON -> retry
      return content;
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) await sleep(400 * attempt);
    }
  }
  throw lastErr;
}

function parseJson(text) {
  const cleaned = String(text).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/[{[][\s\S]*[}\]]/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch { /* fall through */ }
    }
    throw new Error('AI returned malformed JSON');
  }
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<sup>/g, '^').replace(/<\/sup>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

const LANG_LABEL = { python3: 'Python', java: 'Java', cpp: 'C++' };

/**
 * The statement fed to the model. Prefers the cached Chinese translation when
 * present — coaching built on the language the user reads tends to come back
 * in that language, and quotes line up with what's on screen.
 */
function statementOf(problem, max = 12000) {
  return stripHtml(problem.translatedContent || problem.content).slice(0, max);
}

// ------------------------------------------------------------- test cases

const TESTCASE_SYSTEM = `You build test suites for competitive-programming problems.
You are given a problem statement and the example INPUTS (LeetCode's API does not
expose expected outputs). Your job:

1. Read the worked examples in the statement and recover the expected output for
   each given input. Be exact — these become the ground truth for judging.
2. Add edge cases the examples miss: empty/minimal input, boundaries stated in the
   constraints, duplicates, negatives, all-same values, maximum-size-in-spirit cases
   (keep them small enough to stay readable).
3. If the problem accepts multiple valid answers (any order, any valid pair), set
   "orderInsensitive": true and/or "multipleValid": true on that case.

IMPORTANT: reply in Simplified Chinese (简体中文) — every free-text field must be
written in 中文. Keep JSON keys and code identifiers in English.

Return JSON only:
{"cases":[{"input":[...],"expected":<value>,"label":"...","source":"statement"|"synthesized",
           "orderInsensitive":false,"multipleValid":false}],
 "notes":"anything the judge should know"}

"input" must be an array of arguments matching the function signature exactly.
Never invent an expected value you cannot derive with certainty; omit the case instead.`;

export async function generateTestCases({ problem, exampleInputs }) {
  const content = await call([
    { role: 'system', content: TESTCASE_SYSTEM },
    {
      role: 'user',
      content: `Problem: ${problem.title} (${problem.difficulty})

Statement:
${statementOf(problem)}

Function signature (metaData):
${JSON.stringify(problem.meta, null, 2)}

Example inputs parsed from LeetCode:
${JSON.stringify(exampleInputs, null, 2)}

Recover the expected output for each example input, then add edge cases.
请用简体中文回答。`,
    },
  ], { json: true, maxTokens: 3000 });

  const parsed = parseJson(content);
  return {
    cases: Array.isArray(parsed.cases) ? parsed.cases : [],
    notes: parsed.notes || '',
  };
}

// ------------------------------------------------------------- passed path

const REVIEW_SYSTEM = `You are a sharp, warm algorithms coach reviewing a solution that PASSED.
Passing is the floor, not the goal. Your job is to tell the user what an interviewer
would still push back on.

IMPORTANT: reply in Simplified Chinese (简体中文) — every free-text field must be
written in 中文. Keep JSON keys and code identifiers in English.

Return JSON only:
{"verdict":"optimal"|"acceptable"|"suboptimal",
 "complexity":{"time":"O(...)","space":"O(...)","explanation":"why, tied to specific lines"},
 "optimal":{"time":"O(...)","space":"O(...)","approach":"name + one-paragraph sketch"},
 "gap":"the ONE conceptual step between their approach and the optimal one — the insight they were missing, not a code diff",
 "strengths":["what they genuinely did well"],
 "improvements":[{"what":"...","why":"...","how":"a nudge, not finished code"}],
 "idiomatic":["language-specific style notes"],
 "followUp":"a question an interviewer would ask next"}

If their solution IS optimal, say so plainly — do not manufacture criticism. Discuss
the optimal approach conceptually; do NOT write out a full alternative solution.`;

export async function reviewPassing({ problem, language, code, timing, results }) {
  const content = await call([
    { role: 'system', content: REVIEW_SYSTEM },
    {
      role: 'user',
      content: `Problem: ${problem.title} (${problem.difficulty})
Topics: ${(problem.tags || []).join(', ')}

Statement:
${statementOf(problem, 4000)}

Their ${LANG_LABEL[language] || language} solution (all tests passed${timing ? `, ${timing}` : ''}):
\`\`\`
${code}
\`\`\`

${results ? `What it produced on the tests (input → output):\n${results}` : ''}
请用简体中文回答。`,
    },
  ], { json: true, maxTokens: 2500 });

  return parseJson(content);
}

// ------------------------------------------------------------- error paths

const EXPLAIN_COMPILE_SYSTEM = `You are a patient programming coach helping a beginner. Their code FAILED TO COMPILE.
They have already seen the compiler output (line numbers are mapped to their own code).
Explain it like a teacher, not a reference manual.

IMPORTANT: reply in Simplified Chinese (简体中文) — every free-text field must be
written in 中文. Keep JSON keys and code identifiers in English.

Return JSON only:
{"whatItMeans":"what the error means in plain language, 1-2 sentences",
 "where":"which part of their code causes it, citing the line number",
 "howToFix":"concrete fix steps, described not written — never output finished code",
 "commonMistake":"the typical beginner mistake behind this error, one sentence"}`;

export async function explainCompileError({ problem, language, code, errorText }) {
  const content = await call([
    { role: 'system', content: EXPLAIN_COMPILE_SYSTEM },
    {
      role: 'user',
      content: `Problem: ${problem.title} (${problem.difficulty})

Their ${LANG_LABEL[language] || language} code (line numbers shown — use these exact numbers):
\`\`\`
${numbered(code)}
\`\`\`

Compiler output (line numbers already refer to the code above):
${String(errorText).slice(0, 2500)}`,
    },
  ], { json: true, maxTokens: 1200 });

  return parseJson(content);
}

const EXPLAIN_RUNTIME_SYSTEM = `You are a patient programming coach helping a beginner. Their code CRASHED at runtime.
They have already seen the traceback or error message (line numbers are mapped to their own code).

IMPORTANT: reply in Simplified Chinese (简体中文) — every free-text field must be
written in 中文. Keep JSON keys and code identifiers in English.

Return JSON only:
{"whatItMeans":"what the error means in plain language, 1-2 sentences",
 "where":"which part of their code triggers it, citing the line number if identifiable",
 "howToFix":"concrete fix steps, described not written — never output finished code",
 "commonMistake":"the typical beginner mistake behind this error, one sentence",
 "encouragement":"one honest sentence — no empty praise"}`;

export async function explainRuntimeError({ problem, language, code, errorText, timedOut }) {
  const content = await call([
    { role: 'system', content: EXPLAIN_RUNTIME_SYSTEM },
    {
      role: 'user',
      content: `Problem: ${problem.title} (${problem.difficulty})

Their ${LANG_LABEL[language] || language} code (line numbers shown):
\`\`\`
${numbered(code)}
\`\`\`

${timedOut
    ? 'The program TIMED OUT (>15s): the cause is likely an infinite loop, or an algorithm far too slow for the constraints.'
    : 'Runtime error output (line numbers already refer to the code above):'}
${String(errorText).slice(0, 2500)}`,
    },
  ], { json: true, maxTokens: 1200 });

  return parseJson(content);
}

// ------------------------------------------------------------- failed path

const DIAGNOSE_SYSTEM = `You are a patient algorithms coach. The user's solution FAILED.
The single most important judgement you make: is their overall APPROACH fundamentally
sound, or is the idea itself wrong? Everything else follows from that.

- approachSound: true  -> the idea works, the execution is broken. Point at the exact
  line and explain the mechanism of the failure. Do not rewrite the solution.
- approachSound: false -> the idea cannot be patched into a correct solution. Give
  three escalating hints (nudge -> technique name -> concrete strategy) so they can
  find it themselves.

IMPORTANT: reply in Simplified Chinese (简体中文) — every free-text field must be
written in 中文. Keep JSON keys and code identifiers in English.

Return JSON only:
{"approachSound":true|false,
 "approachSummary":"what they were attempting, in one sentence, stated generously",
 "diagnosis":"what actually goes wrong, mechanically",
 "bugLocation":{"line":<number|null>,"snippet":"the offending code","fix":"what needs to change, described not written"},
 "errorCategory":"off-by-one"|"boundary-condition"|"wrong-data-structure"|"complexity"|"misread-problem"|"logic-error"|"initialization"|"overflow"|"syntax-or-runtime",
 "whyThisCaseFails":"trace the failing input through their code, step by step",
 "hints":["gentle nudge","the technique or invariant to reach for","concrete strategy, still not code"],
 "encouragement":"one honest sentence — no empty praise",
 "retryFocus":"the single thing to change before resubmitting"}

Never output a complete working solution. The user must write the fix themselves.`;

/** Numbered source so the model's `bugLocation.line` refers to real user lines. */
function numbered(code) {
  return String(code).split('\n').map((l, i) => `${String(i + 1).padStart(3)} | ${l}`).join('\n');
}

export async function diagnoseFailure({ problem, language, code, failure, counts }) {
  const detail = failure
    ? `Failing case:
  input:    ${JSON.stringify(failure.input)}
  expected: ${JSON.stringify(failure.expected)}
  actual:   ${JSON.stringify(failure.actual)}
  ${failure.error ? `error:    ${failure.error}` : ''}`
    : 'No specific failing case captured.';

  const content = await call([
    { role: 'system', content: DIAGNOSE_SYSTEM },
    {
      role: 'user',
      content: `Problem: ${problem.title} (${problem.difficulty})
Topics: ${(problem.tags || []).join(', ')}

Statement:
${statementOf(problem, 4000)}

Their ${LANG_LABEL[language] || language} attempt (line numbers shown — use these
exact numbers for bugLocation.line):
\`\`\`
${numbered(code)}
\`\`\`

Results: ${counts.pass} passed, ${counts.fail} wrong, ${counts.error} errored.
${detail}

Any line numbers in the error above already refer to this same numbering.
请用简体中文回答。`,
    },
  ], { json: true, maxTokens: 2500 });

  return parseJson(content);
}

// ------------------------------------------------------------- adjudication

const ADJUDICATE_SYSTEM = `A mechanical judge could not decide whether an output is correct
(the problem may accept multiple valid answers, any ordering, or floating-point drift).
Decide whether the actual output satisfies the problem's requirements.

IMPORTANT: reply in Simplified Chinese (简体中文) — every free-text field must be
written in 中文. Keep JSON keys in English.

Return JSON only: {"correct":true|false,"reason":"one sentence"}`;

export async function adjudicate({ problem, input, expected, actual }) {
  const content = await call([
    { role: 'system', content: ADJUDICATE_SYSTEM },
    {
      role: 'user',
      content: `Problem: ${problem.title}

Requirements:
${statementOf(problem, 2500)}

input:    ${JSON.stringify(input)}
expected: ${JSON.stringify(expected)}
actual:   ${JSON.stringify(actual)}

Is the actual output acceptable?
请用简体中文回答。`,
    },
  ], { json: true, maxTokens: 400 });

  return parseJson(content);
}

// ------------------------------------------------------------- notebook

const NOTE_SYSTEM = `Write a terse, reusable mistake-notebook entry from a failed attempt.
The user will reread this weeks later, so it must be self-contained and skimmable.

IMPORTANT: reply in Simplified Chinese (简体中文) — every free-text field must be
written in 中文. Keep JSON keys and code identifiers in English.

Return JSON only:
{"title":"short pattern name, generalized beyond this one problem",
 "category":"the error category",
 "trigger":"the situation where this mistake tends to appear",
 "lesson":"the transferable rule, 1-2 sentences",
 "checklist":["concrete thing to verify next time"],
 "relatedPatterns":["technique or problem family to review"]}`;

export async function writeNote({ problem, diagnosis, code, language }) {
  const content = await call([
    { role: 'system', content: NOTE_SYSTEM },
    {
      role: 'user',
      content: `Problem: ${problem.title} (${problem.difficulty})
Topics: ${(problem.tags || []).join(', ')}
Language: ${LANG_LABEL[language] || language}

Diagnosis: ${diagnosis.diagnosis}
Category: ${diagnosis.errorCategory}
Approach was sound: ${diagnosis.approachSound}

Their code:
\`\`\`
${code}
\`\`\``,
    },
  ], { json: true, maxTokens: 900 });

  return parseJson(content);
}

// ------------------------------------------------------------- follow-up

export async function ask({ problem, code, language, question, history = [] }) {
  const messages = [
    {
      role: 'system',
      content: `You are an algorithms coach helping with "${problem.title}".
Answer the user's question directly and concisely. Guide toward insight rather than
handing over code — but if they explicitly ask to see a full solution, give it and
explain it thoroughly. Their language is ${LANG_LABEL[language] || language}.

IMPORTANT: reply in Simplified Chinese (简体中文), keeping code identifiers in English.

Problem statement:
${statementOf(problem, 3000)}

Their current code:
\`\`\`
${code}
\`\`\``,
    },
    ...history,
    { role: 'user', content: question },
  ];
  return call(messages, { maxTokens: 1600, temperature: 0.4 });
}

export const _internal = { stripHtml, parseJson };
