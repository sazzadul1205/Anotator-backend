// config/concurrency.js
// Concurrency limiter with a FIFO queue, driven entirely by config/app.js.
//
// Env vars (declared once, in config/app.js):
//   MAX_CONCURRENT_IMPORTS   — how many imports run at once (default 2)
//   MAX_CONCURRENT_EXPORTS   — how many exports run at once (default 4)
//   MAX_QUEUE_SIZE           — max pending jobs before rejecting (default 100)
//   JOB_TIMEOUT_MS           — per-job hard timeout in ms (default 600000 = 10m)
//   QUEUE_LOG_INTERVAL_MS    — how often to log queue depth (default 60000)
//
// Usage:
//   const imports = require("../config/concurrency").imports;
//   await imports.run(async () => { ...do work... });

const { config } = require("./app");

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
    let callerSettled = false;

    const settleCaller = (type, value) => {
      if (callerSettled) return;
      callerSettled = true;
      if (type === "resolve") {
        this.stats.completed++;
        resolve(value);
      } else {
        this.stats.failed++;
        reject(value);
      }
    };

    const finish = () => {
      this.running--;
      setImmediate(() => this._drain());
    };

    const timer = setTimeout(() => {
      this.stats.timedOut++;
      settleCaller(
        "reject",
        Object.assign(
          new Error(`[${this.name}] job exceeded ${this.jobTimeoutMs}ms`),
          { status: 500 },
        ),
      );
      // --- fix: do NOT free the slot here. Keep it occupied until fn()
      // truly settles, otherwise timed-out jobs would let extra work start
      // concurrently. The `finally` below handles the actual release. ---
    }, this.jobTimeoutMs);

    try {
      const result = await fn();
      clearTimeout(timer);
      settleCaller("resolve", result);
    } catch (err) {
      clearTimeout(timer);
      settleCaller("reject", err);
    } finally {
      finish();
    }
  }
}

// ---------------------------------------------------------------------------
// Instances — one queue per class of work
// ---------------------------------------------------------------------------

const {
  maxConcurrentImports,
  maxConcurrentExports,
  maxQueueSize,
  jobTimeoutMs,
  exportTimeoutMs,
  logIntervalMs,
} = config.queues;

const imports = new Queue({
  name: "imports",
  concurrency: maxConcurrentImports,
  maxQueueSize,
  jobTimeoutMs,
});

const exports_ = new Queue({
  name: "exports",
  concurrency: maxConcurrentExports,
  maxQueueSize,
  jobTimeoutMs: exportTimeoutMs,
});

// Optional: periodic queue-depth logging so you can see pressure in the logs.
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