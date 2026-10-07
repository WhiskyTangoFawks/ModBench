import * as http from 'node:http';
import * as net from 'node:net';
import * as readline from 'node:readline';
import type { BackendStatus } from './MEditClient';

/** Which of the spawned process's two streams a line arrived on. The forwarder that levels it
 *  takes this type, so the client names no VS Code type (ADR-0019). */
export type BackendStream = 'stdout' | 'stderr';

interface BackendProcess {
  /** Optional signal so stop() can send SIGTERM then escalate to SIGKILL. */
  kill(signal?: NodeJS.Signals): void;
  on(event: 'exit', cb: (code: number | null) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  /** Present when spawned with piped stdio; absent on 'ignore'. */
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
}

export type SpawnFn = (executablePath: string, args: string[]) => BackendProcess;

export interface BackendLifecycleOptions {
  /** A developer-launched backend to attach to, spawning nothing and never falling back to a
   *  spawn. Omitted, this window spawns its own (ADR-0010) on a free port. */
  attachPort?: number;
  /** Claims the port the spawned backend listens on; defaults to an OS-assigned free one. */
  freePort?: () => Promise<number>;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  log?: (msg: string) => void;
  /** Receives each line the spawned backend writes, with the stream it came from.
   *  Levelling lives in the caller's forwarder, not here. */
  onOutput?: (line: string, source: BackendStream) => void;
  /** Spawns the bundled backend; omitted in attach-only/test contexts. */
  spawn?: SpawnFn;
  /** Path to the bundled backend executable. */
  executablePath?: string;
  /** Read fresh at each spawn from the Output channel's current level, so a crash-restart picks
   *  up a level change. The spawn path only — an attached backend never sees it. */
  serilogLevelArgs?: () => string[];
  /** How long stop() waits after SIGTERM before escalating to SIGKILL. Defaults to 5s, matching
   *  .NET's Generic Host shutdown budget (HostOptions.ShutdownTimeout). */
  stopGracePeriodMs?: number;
  /** Polled at `pollIntervalMs` while attaching/starting; defaults to a real GET `/health`
   *  against `port`. Injectable so a test drives attach/restart timing without a real socket. */
  checkHealth?: () => Promise<boolean>;
}

/** The backend process the client hides (ADR-0002). */
export class BackendLifecycle {
  private readonly attachPort?: number;
  private readonly freePort: () => Promise<number>;
  private spawnPort?: number;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;
  private readonly stopGracePeriodMs: number;
  private readonly log: (msg: string) => void;
  private readonly onOutput: (line: string, source: BackendStream) => void;
  private readonly spawnFn?: SpawnFn;
  private readonly executablePath?: string;
  private readonly serilogLevelArgs?: () => string[];
  private readonly checkHealthFn: () => Promise<boolean>;

  private _status: BackendStatus = 'starting';
  private readonly listeners = new Set<(status: BackendStatus) => void>();
  private child?: BackendProcess;
  // True between start() and stop(); an exit while true is a crash → restart.
  private expectedAlive = false;
  // In-flight start(), its restarts included, so concurrent callers share it instead of
  // double-spawning.
  private startPromise?: Promise<void>;
  // A child exited during the start in flight, which restarts it rather than settling.
  private restartQueued = false;
  // Bumped by stop(); an in-flight start()/connect() from an older generation aborts instead of
  // resurrecting a load order the user already closed.
  private generation = 0;
  private restartAttempts = 0;
  private static readonly MAX_RESTARTS = 3;

  constructor(opts: BackendLifecycleOptions) {
    this.attachPort = opts.attachPort;
    this.freePort = opts.freePort ?? claimFreePort;
    this.pollIntervalMs = opts.pollIntervalMs ?? 500;
    this.pollTimeoutMs = opts.pollTimeoutMs ?? 30_000;
    this.stopGracePeriodMs = opts.stopGracePeriodMs ?? 5_000;
    this.log = opts.log ?? (() => {});
    this.onOutput = opts.onOutput ?? (() => {});
    this.spawnFn = opts.spawn;
    this.executablePath = opts.executablePath;
    this.serilogLevelArgs = opts.serilogLevelArgs;
    this.checkHealthFn = opts.checkHealth ?? (() => this.checkHealthOverHttp());
  }

  get status(): BackendStatus { return this._status; }

  /** The start in flight, which settles once a child runs or its restarts end. */
  get starting(): Promise<void> | undefined { return this.startPromise; }

  /** The port the API answers on: the attached one, else the spawned backend's once start() has
   *  claimed it. */
  get port(): number | undefined { return this.attachPort ?? this.spawnPort; }

  onStatusChanged(listener: (status: BackendStatus) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Spawns this window's own backend, or waits for the one on `attachPort`. Idempotent: concurrent calls share one in-flight start, so no double-spawn. */
  start(): Promise<void> {
    this.expectedAlive = true;
    this.startPromise ??= this.startUntilSettled().finally(() => { this.startPromise = undefined; });
    return this.startPromise;
  }

  private async startUntilSettled(): Promise<void> {
    const gen = this.generation;
    do {
      this.restartQueued = false;
      await this.doStart();
    } while (this.isRestartQueued() && gen === this.generation);
  }

  // A direct read narrows to the `false` assigned above, since TS cannot see handleExit set it
  // across the `await`.
  private isRestartQueued(): boolean {
    return this.restartQueued;
  }

  private async doStart(): Promise<void> {
    const gen = this.generation;

    if (this.attachPort === undefined && !this.child) {
      this.spawnPort = await this.freePort();
      if (gen !== this.generation) return;
    }

    if (this.attachPort === undefined && this.spawnFn && this.executablePath && !this.child) {
      this.setStatus('starting');
      const child = this.spawnFn(this.executablePath, [
        '--urls', `http://localhost:${this.spawnPort}`,
        ...(this.serilogLevelArgs?.() ?? []),
      ]);
      this.child = child;
      child.on('error', (err) => this.log(`[backend] spawn error: ${err.message}`));
      child.on('exit', (code) => this.handleExit(code));
      this.forwardOutput(child);
    }

    await this.connect(gen, this.attachPort === undefined ? this.child : undefined);
    if (this._status === 'running') this.restartAttempts = 0;
  }

  // Subscribed unconditionally: a piped stream nobody reads fills its OS buffer and then blocks
  // the backend's writes, so draining is not optional.
  private forwardOutput(child: BackendProcess): void {
    const streams: [BackendStream, NodeJS.ReadableStream | null | undefined][] =
      [['stdout', child.stdout], ['stderr', child.stderr]];
    for (const [source, stream] of streams) {
      if (!stream) continue;
      readline.createInterface({ input: stream }).on('line', (line) => this.onOutput(line, source));
    }
  }

  /** The `child` handle clears immediately, so nothing dispatches new work to a backend already
   *  condemned; only the *status* report waits for the process to be gone. */
  async stop(): Promise<void> {
    this.expectedAlive = false;
    this.generation++; // cancels an in-flight doStart()/connect()
    this.restartAttempts = 0;
    const wasRunning = this.child !== undefined || this._status === 'running';
    const child = this.child;
    this.child = undefined;
    if (child) {
      await this.killAndConfirmExit(child);
    }
    if (wasRunning) this.setStatus('stopped');
  }

  // A backend mid a long synchronous request won't notice SIGTERM, so this escalates to SIGKILL
  // and waits for a real 'exit'. Accepted race: stop() clears `this.child` first, so a start()
  // racing the wait can spawn a second child.
  private killAndConfirmExit(child: BackendProcess): Promise<void> {
    return new Promise((resolve) => {
      // A container, not a `let`, so it exists (as `undefined`) before onExit is even defined —
      // safe even if 'exit' fired synchronously from kill().
      const escalateTimer: { current?: ReturnType<typeof setTimeout> } = {};
      const onExit = () => {
        clearTimeout(escalateTimer.current);
        resolve();
      };
      child.on('exit', onExit);
      child.kill('SIGTERM');
      escalateTimer.current = setTimeout(() => {
        this.log(`[backend] did not exit within ${this.stopGracePeriodMs}ms of SIGTERM — sending SIGKILL`);
        child.kill('SIGKILL');
      }, this.stopGracePeriodMs);
    });
  }

  private handleExit(code: number | null): void {
    this.child = undefined;
    if (!this.expectedAlive) return; // stop() already handled it
    if (this.restartAttempts >= BackendLifecycle.MAX_RESTARTS) {
      this.setStatus('disconnected');
      this.log(`[backend] backend crashed ${this.restartAttempts}× — giving up`);
      return;
    }
    this.restartAttempts++;
    // Begun before the status says disconnected, so whoever hears it finds the restart under way.
    if (this.startPromise) this.restartQueued = true;
    else void this.start();
    // The process is gone now; the restart is an attempt, not a guarantee.
    this.setStatus('disconnected');
    this.log(`[backend] backend exited unexpectedly (code ${code}); restart ${this.restartAttempts}/${BackendLifecycle.MAX_RESTARTS}`);
  }

  // A spawned child that is gone before `/health` answers is a failed start, whoever else answers
  // on its port.
  private connect(gen: number, child: BackendProcess | undefined): Promise<void> {
    return new Promise((resolve) => {
      const deadline = Date.now() + this.pollTimeoutMs;

      const attempt = async () => {
        const abandoned = () => gen !== this.generation || (child !== undefined && this.child !== child);
        if (abandoned()) { resolve(); return; }
        const healthy = await this.checkHealthFn();
        if (abandoned()) { resolve(); return; }
        if (healthy) {
          this.setStatus('running');
          resolve();
          return;
        }

        if (Date.now() >= deadline) {
          this.log(`[backend] Timed out waiting for backend on port ${this.port}`);
          this.setStatus('disconnected');
          resolve();
          return;
        }

        setTimeout(() => { void attempt(); }, this.pollIntervalMs);
      };

      void attempt();
    });
  }

  private checkHealthOverHttp(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(`http://localhost:${this.port}/health`, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on('error', (err) => { this.log(`[backend] Health check error: ${err.message}`); resolve(false); });
    });
  }

  private setStatus(status: BackendStatus): void {
    this._status = status;
    for (const listener of this.listeners) listener(status);
  }
}

function claimFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') { reject(new Error('no port was assigned')); return; }
      probe.close(() => resolve(address.port));
    });
  });
}
