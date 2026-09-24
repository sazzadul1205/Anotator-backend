// config/concurrency.js
// Env-driven concurrency limiter with a FIFO queue.
//
// Env vars:
//   MAX_CONCURRENT_IMPORTS   — how many imports run at once (default 2)
//   MAX_CONCURRENT_EXPORTS   — how many exports run at once (default 4)
//   MAX_QUEUE_SIZE           — max pending jobs before rejecting (default 100)
//   JOB_TIMEOUT_MS           — per-job hard timeout in ms (default 600000 = 10m)
//   QUEUE_LOG_INTERVAL_MS    — how often to log queue depth (default 60000)
//
// Usage:
//   const imports = require("../config/concurrency").imports;
//   await imports.run(async () => { ...do work... });

function readInt(name, fallback, { min = 1, max = 100000 } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) {
    console.warn(
      `⚠️  ${name}="${raw}" is invalid; using default ${fallback} (range ${min}-${max})`,
    );
    return fallback;
  }
  return n;
}

class Queue {
  constructor({ name, concurrency, maxQueueSize, jobTimeoutMs }) {
    this.name = name;
    this.concurrency = concurrency;
    this.maxQueueSize = maxQueueSize;
    this.jobTimeoutMs = jobTimeoutMs;
    this.running = 0;
    this.queue = []; // [{ fn, resolve, reject, enqueuedAt }]
    this.stats = {
      started: 0,
      completed: 0,
      failed: 0,
      rejected: 0,
      timedOut: 0,
    };
  }

  /** Current queue depth (jobs waiting to run). */
  get pending() {
    return this.queue.length;
  }

  /** Total jobs known to this queue: running + pending. */
  get total() {
    return this.running + this.queue.length;
  }

  /**
   * Enqueue a job. Returns a Promise that resolves/rejects with the job's result.
   * Rejects immediately if the queue is full.
   */
  run(fn) {
    if (this.queue.length >= this.maxQueueSize) {
      this.stats.rejected++;
      return Promise.reject(
        Object.assign(
          new Error(`[${this.name}] queue full (${this.maxQueueSize})`),
          { status: 503 },
        ),
      );
    }

    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject, enqueuedAt: Date.now() });
      this._drain();
    });
  }

  /** Returns a snapshot of queue state — useful for health endpoints. */
  snapshot() {
    const oldest = this.queue[0];
    return {
      name: this.name,
      concurrency: this.concurrency,
      running: this.running,
      pending: this.queue.length,
      maxQueueSize: this.maxQueueSize,
      jobTimeoutMs: this.jobTimeoutMs,
      oldestWaitMs: oldest ? Date.now() - oldest.enqueuedAt : 0,
      stats: { ...this.stats },
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  async _drain() {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      this.running++;
      this.stats.started++;
      this._execute(job);
    }
  }

  async _execute(job) {
    const { fn, resolve, reject } = job;

    // Wrap the job in a hard timeout so a hung job can't stall the queue.
    let timer;
    const timeoutPromise = new Promise((_, rej) => {
      timer = setTimeout(() => {
        this.stats.timedOut++;
        rej(
          Object.assign(
            new Error(`[${this.name}] job exceeded ${this.jobTimeoutMs}ms`),
            { status: 500 },
          ),
        );
      }, this.jobTimeoutMs);
    });

    try {
      const result = await Promise.race([fn(), timeoutPromise]);
      clearTimeout(timer);
      this.stats.completed++;
      resolve(result);
    } catch (err) {
      clearTimeout(timer);
      this.stats.failed++;
      reject(err);
    } finally {
      this.running--;
      // Kick the next job off the queue (async so we don't recurse deep)
      setImmediate(() => this._drain());
    }
  }
}

// ---------------------------------------------------------------------------
// Instances — one queue per class of work
// ---------------------------------------------------------------------------

const maxQueueSize = readInt("MAX_QUEUE_SIZE", 100, { min: 1, max: 10000 });
const jobTimeoutMs = readInt("JOB_TIMEOUT_MS", 10 * 60 * 1000, {
  min: 1000,
  max: 24 * 60 * 60 * 1000,
});

const imports = new Queue({
  name: "imports",
  concurrency: readInt("MAX_CONCURRENT_IMPORTS", 2, { min: 1, max: 64 }),
  maxQueueSize,
  jobTimeoutMs,
});

const exports_ = new Queue({
  name: "exports",
  concurrency: readInt("MAX_CONCURRENT_EXPORTS", 4, { min: 1, max: 64 }),
  maxQueueSize,
  jobTimeoutMs: readInt("EXPORT_TIMEOUT_MS", 60 * 1000, {
    min: 1000,
    max: 10 * 60 * 1000,
  }),
});

// Optional: periodic queue-depth logging so you can see pressure in the logs.
const logIntervalMs = readInt("QUEUE_LOG_INTERVAL_MS", 60000, {
  min: 5000,
  max: 60 * 60 * 1000,
});
if (logIntervalMs > 0) {
  setInterval(() => {
    if (imports.total === 0 && exports_.total === 0) return;
    console.log(
      `[queue] imports running=${imports.running} pending=${imports.pending} | ` +
        `exports running=${exports_.running} pending=${exports_.pending}`,
    );
  }, logIntervalMs).unref();
}

module.exports = {
  imports,
  exports: exports_,
  // Expose config so other modules (health, admin UI) can display them.
  config: {
    maxConcurrentImports: imports.concurrency,
    maxConcurrentExports: exports_.concurrency,
    maxQueueSize,
    jobTimeoutMs,
  },
};
