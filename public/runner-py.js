/**
 * Pyodide-backed Python runner.
 *
 * Runs in a Web Worker so an infinite loop in user code cannot freeze the UI —
 * the worker gets terminated on timeout and a fresh one is spun up.
 */

const WORKER_SRC = `
let pyodide = null;
let loading = null;

async function ensure(version) {
  if (pyodide) return pyodide;
  if (!loading) {
    loading = (async () => {
      const base = 'https://cdn.jsdelivr.net/pyodide/' + version + '/full/';
      importScripts(base + 'pyodide.js');
      pyodide = await loadPyodide({ indexURL: base });
      return pyodide;
    })();
  }
  return loading;
}

self.onmessage = async (e) => {
  const { id, code, version } = e.data;
  try {
    const py = await ensure(version);
    // Signal only once the interpreter is READY: the timeout budget measures
    // user-code execution, not the Pyodide download (~10MB on a cold start),
    // which would otherwise eat the whole budget and false-timeout.
    self.postMessage({ id, starting: true });
    let stdout = '';
    py.setStdout({ batched: (s) => { stdout += s + '\\n'; } });
    py.setStderr({ batched: (s) => { stdout += s + '\\n'; } });
    const t0 = performance.now();
    await py.runPythonAsync(code);
    self.postMessage({ id, ok: true, stdout, wallMs: performance.now() - t0 });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
`;

export class PythonRunner {
  constructor(version = 'v0.28.3') {
    this.version = version;
    this.worker = null;
    this.seq = 0;
    this.ready = false;
    this.onStatus = () => {};
  }

  spawn() {
    const blob = new Blob([WORKER_SRC], { type: 'text/javascript' });
    this.worker = new Worker(URL.createObjectURL(blob));
    return this.worker;
  }

  /** Pre-loads Pyodide so the first real submission is not slowed by the download. */
  async warmup() {
    if (this.ready) return;
    this.onStatus('loading Python runtime (~10MB, cached after first load)');
    await this.run('pass', 180_000);
    this.ready = true;
    this.onStatus('Python ready');
  }

  async run(code, timeoutMs = 15_000) {
    if (!this.worker) this.spawn();
    const id = ++this.seq;
    const worker = this.worker;

    return new Promise((resolve) => {
      let timer = null;
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (watchdog) clearTimeout(watchdog);
        worker.removeEventListener('message', onMessage);
        resolve(result);
      };

      // Failsafe: if the runtime never even signals "starting" (CDN stall,
      // worker hang), give up rather than queueing silently forever. The
      // budget is generous — killing a slow download only forces a full
      // re-download on the next attempt, so patience is cheaper than retries.
      const watchdog = setTimeout(() => {
        worker.terminate();
        this.worker = null;
        this.ready = false;
        finish({ ok: false, timedOut: false, error: 'Python 运行时加载超时（Pyodide CDN 不可达或网络太慢）', stdout: '' });
      }, 300_000);

      const onMessage = (e) => {
        if (e.data.id !== id) return;
        if (e.data.starting) {
          // Budget starts when the interpreter is ready and THIS run begins
          // executing — a run queued behind the Pyodide download must not
          // burn its timeout while waiting in line.
          timer = setTimeout(() => {
            worker.terminate();
            this.worker = null;
            this.ready = false;
            finish({ ok: false, timedOut: true, error: `execution exceeded ${timeoutMs}ms — likely an infinite loop or far-too-slow algorithm`, stdout: '' });
          }, timeoutMs);
          return;
        }
        finish({ ...e.data, timedOut: false });
      };

      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', (err) => {
        finish({ ok: false, error: `worker error: ${err.message}`, stdout: '' });
      }, { once: true });

      worker.postMessage({ id, code, version: this.version });
    });
  }

  dispose() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
    this.ready = false;
  }
}
