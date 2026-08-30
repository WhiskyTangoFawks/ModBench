import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import * as readline from 'node:readline';
import type { BackendStream } from './backendLog';

export type BackendStatus = 'starting' | 'attached' | 'disconnected' | 'stopped';

export interface StatusBarAdapter {
  setText(text: string): void;
  show(): void;
  dispose(): void;
}

/** Minimal view of a spawned backend process — injectable so spawn/teardown is
 *  unit-testable without a real child process. */
export interface BackendProcess {
  /** #562: optional signal so stop() can send SIGTERM then escalate to SIGKILL. */
  kill(signal?: NodeJS.Signals): void;
  on(event: 'exit', cb: (code: number | null) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  /** Present when spawned with piped stdio (#199); absent on 'ignore'. */
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
}

export type SpawnFn = (executablePath: string, args: string[]) => BackendProcess;

export interface BackendManagerOptions {
  port: number;
  statusBar: StatusBarAdapter;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  log?: (msg: string) => void;
  /** Receives each line the spawned backend writes, with the stream it came from
   *  (#199). Levelling lives in the caller's forwarder, not here. */
  onOutput?: (line: string, source: BackendStream) => void;
  /** Spawns the bundled backend; omitted in attach-only/test contexts. */
  spawn?: SpawnFn;
  /** Path to the bundled backend executable. */
  executablePath?: string;
  /** Extra spawn argv (e.g. `['--Serilog:MinimumLevel:Default', 'Debug']`) built
   *  fresh at each spawn from the Output channel's current level (#205), so a
   *  crash-restart picks up any level change. Only ever applied on the spawn
   *  path — an attached backend never sees it. */
  serilogLevelArgs?: () => string[];
  /** #562: how long stop() waits after SIGTERM before escalating to SIGKILL — a backend mid
   *  a long, non-yielding synchronous request won't notice SIGTERM promptly, and stop() must
   *  never report "stopped" while the OS process is still demonstrably alive. Defaults to 5s,
   *  matching .NET's own Generic Host default graceful-shutdown budget (HostOptions.ShutdownTimeout). */
  stopGracePeriodMs?: number;
}

export class BackendManager extends EventEmitter {
  private readonly port: number;
  private readonly statusBar: StatusBarAdapter;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;
  private readonly stopGracePeriodMs: number;
  private readonly log: (msg: string) => void;
  private readonly onOutput: (line: string, source: BackendStream) => void;
  private readonly spawnFn?: SpawnFn;
  private readonly executablePath?: string;
  private readonly serilogLevelArgs?: () => string[];

  private _isHealthy = false;
  private child?: BackendProcess;
  /** True between start() and stop(); an exit while true is a crash → restart. */
  private expectedAlive = false;
  /** In-flight start(), so concurrent callers share it instead of double-spawning. */
  private startPromise?: Promise<void>;
  /** Bumped by stop(); an in-flight start()/connect() from an older generation
   *  aborts instead of resurrecting a load order the user already closed. */
  private generation = 0;
  private restartAttempts = 0;
  private static readonly MAX_RESTARTS = 3;

  constructor(opts: BackendManagerOptions) {
    super();
    this.port = opts.port;
    this.statusBar = opts.statusBar;
    this.pollIntervalMs = opts.pollIntervalMs ?? 500;
    this.pollTimeoutMs = opts.pollTimeoutMs ?? 30_000;
    this.stopGracePeriodMs = opts.stopGracePeriodMs ?? 5_000;
    this.log = opts.log ?? (() => {});
    this.onOutput = opts.onOutput ?? (() => {});
    this.spawnFn = opts.spawn;
    this.executablePath = opts.executablePath;
    this.serilogLevelArgs = opts.serilogLevelArgs;

    this.statusBar.setText('$(loading~spin) mEdit: Connecting…');
    this.statusBar.show();
  }

  get isHealthy(): boolean { return this._isHealthy; }

  /** Ensure the backend is running: attach if one is already healthy (e.g. a
   *  dev-launched instance), otherwise spawn the bundled binary and wait.
   *  Idempotent — concurrent calls share one in-flight start (no double-spawn). */
  start(): Promise<void> {
    this.expectedAlive = true;
    this.startPromise ??= this.doStart().finally(() => { this.startPromise = undefined; });
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    const gen = this.generation;

    if (await this.checkHealth()) {
      if (gen !== this.generation) return; // stopped mid-check — don't attach
      this._isHealthy = true;
      this.restartAttempts = 0;
      this.emitStatus('attached');
      return;
    }
    if (gen !== this.generation) return;

    if (this.spawnFn && this.executablePath && !this.child) {
      this.emitStatus('starting');
      const child = this.spawnFn(this.executablePath, [
        '--urls', `http://localhost:${this.port}`,
        ...(this.serilogLevelArgs?.() ?? []),
      ]);
      this.child = child;
      child.on('error', (err) => this.log(`[BackendManager] spawn error: ${err.message}`));
      child.on('exit', (code) => this.handleExit(code));
      this.forwardOutput(child);
    }

    await this.connect(gen);
    if (this._isHealthy) this.restartAttempts = 0;
  }

  /** Pipe the child's console output line-by-line to `onOutput`. Subscribed
   *  unconditionally: a piped stream nobody reads fills its OS buffer and then
   *  blocks the backend's writes, so draining isn't optional. Re-runs per spawn,
   *  so a crash-restarted child is forwarded too. */
  private forwardOutput(child: BackendProcess): void {
    const streams: [BackendStream, NodeJS.ReadableStream | null | undefined][] =
      [['stdout', child.stdout], ['stderr', child.stderr]];
    for (const [source, stream] of streams) {
      if (!stream) continue;
      readline.createInterface({ input: stream }).on('line', (line) => this.onOutput(line, source));
    }
  }

  /** Deliberate teardown: kill the backend and cancel any in-flight start. `isHealthy` and the
   *  `child` handle are cleared immediately (unchanged from before #562) — a backend we've
   *  already decided to kill shouldn't keep looking usable to anything that might dispatch new
   *  work to it. Only the *status* report is different: it now waits for the OS process to
   *  actually be gone before claiming so (#562). */
  async stop(): Promise<void> {
    this.expectedAlive = false;
    this.generation++; // cancels an in-flight doStart()/connect()
    this.restartAttempts = 0;
    const wasRunning = this.child !== undefined || this._isHealthy;
    const child = this.child;
    this.child = undefined;
    this._isHealthy = false;
    if (child) {
      await this.killAndConfirmExit(child);
    }
    // #247/#562: emitted rather than written straight to the status bar, so a deliberate stop is
    // observable — wireSessionRunningContext (extension.ts, #352) subscribes to 'status' to
    // drive the Plugins view's Launch/Close mEdit toggle and would otherwise keep reading
    // "running" until something else happened to fire. Deferred until the child (if any) has
    // actually exited — see killAndConfirmExit — so this never claims "stopped" while the OS
    // process is still demonstrably alive (#562).
    if (wasRunning) this.emitStatus('stopped');
  }

  /** Send SIGTERM and wait for the child to actually exit. A backend mid a long, non-yielding
   *  synchronous request won't notice SIGTERM promptly (#562) — if it hasn't exited within
   *  `stopGracePeriodMs`, escalate to SIGKILL, which the OS does not let it ignore, and keep
   *  waiting for the same real `'exit'` event. Never resolves on a guess.
   *
   *  Residual race (accepted, #562 review): stop() clears `this.child` synchronously before this
   *  resolves, so a same-instance start() racing in during the wait sees `!this.child` and could
   *  spawn a second child before this one is confirmed dead. Not the leak AC1 targets — that's
   *  the reload path, where a *new* BackendManager instance has no reference to the old child at
   *  all, which deactivate() awaiting dispose() (and so this method) before teardown prevents.
   *  This narrower case is same-instance and mitigated in practice: emitStatus('stopped') stays
   *  deferred until this resolves, so the UI's relaunch affordance is disabled for the same
   *  window. Left as a stated, accepted risk rather than guarded further — not a spec gap. */
  private killAndConfirmExit(child: BackendProcess): Promise<void> {
    return new Promise((resolve) => {
      // A container, not a `let`, so it exists (as `undefined`) before onExit is even defined —
      // safe even if 'exit' fired synchronously from kill() (the BackendProcess interface itself
      // doesn't rule that out, though real Node child processes never do).
      const escalateTimer: { current?: ReturnType<typeof setTimeout> } = {};
      const onExit = () => {
        clearTimeout(escalateTimer.current);
        resolve();
      };
      child.on('exit', onExit);
      child.kill('SIGTERM');
      escalateTimer.current = setTimeout(() => {
        this.log(`[BackendManager] backend did not exit within ${this.stopGracePeriodMs}ms of SIGTERM — sending SIGKILL`);
        child.kill('SIGKILL');
      }, this.stopGracePeriodMs);
    });
  }

  private handleExit(code: number | null): void {
    this.child = undefined;
    this._isHealthy = false;
    if (!this.expectedAlive) return; // stop() already handled it
    if (this.restartAttempts >= BackendManager.MAX_RESTARTS) {
      this.log(`[BackendManager] backend crashed ${this.restartAttempts}× — giving up`);
      this.emitStatus('disconnected');
      return;
    }
    this.restartAttempts++;
    this.log(`[BackendManager] backend exited unexpectedly (code ${code}); restart ${this.restartAttempts}/${BackendManager.MAX_RESTARTS}`);
    void this.start().then(() => {
      if (this._isHealthy) this.emit('restarted');
    });
  }

  connect(gen = this.generation): Promise<void> {
    return new Promise((resolve) => {
      const deadline = Date.now() + this.pollTimeoutMs;

      const attempt = async () => {
        if (gen !== this.generation) { resolve(); return; } // cancelled by stop()
        const healthy = await this.checkHealth();
        if (gen !== this.generation) { resolve(); return; }
        if (healthy) {
          this._isHealthy = true;
          this.emitStatus('attached');
          resolve();
          return;
        }

        if (Date.now() >= deadline) {
          this._isHealthy = false;
          this.log(`[BackendManager] Timed out waiting for backend on port ${this.port}`);
          this.emitStatus('disconnected');
          resolve();
          return;
        }

        setTimeout(() => { void attempt(); }, this.pollIntervalMs);
      };

      void attempt();
    });
  }

  /** #562: awaits stop()'s confirmed-exit teardown before disposing the status bar — the
   *  extension's deactivate() delegates to this directly, so a reload cannot proceed (and
   *  construct a replacement BackendManager with no reference to this instance's child) until
   *  the old child is actually gone. */
  async dispose(): Promise<void> {
    await this.stop();
    this.statusBar.dispose();
  }

  private checkHealth(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(`http://localhost:${this.port}/health`, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on('error', (err) => { this.log(`[BackendManager] Health check error: ${err.message}`); resolve(false); });
    });
  }

  private emitStatus(status: BackendStatus): void {
    const labels: Record<BackendStatus, string> = {
      starting:     '$(loading~spin) mEdit: Connecting…',
      attached:     '$(plug) mEdit: Attached',
      disconnected: '$(error) mEdit: Disconnected — start MEditService and reload',
      stopped:      '$(circle-slash) mEdit: Stopped',
    };
    this.statusBar.setText(labels[status]);
    this.emit('status', status);
  }
}
