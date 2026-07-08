import { EventEmitter } from 'node:events';
import * as http from 'node:http';

export type BackendStatus = 'starting' | 'attached' | 'disconnected';

export interface StatusBarAdapter {
  setText(text: string): void;
  show(): void;
  dispose(): void;
}

/** Minimal view of a spawned backend process — injectable so spawn/teardown is
 *  unit-testable without a real child process. */
export interface BackendProcess {
  kill(): void;
  on(event: 'exit', cb: (code: number | null) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}

export type SpawnFn = (executablePath: string, args: string[]) => BackendProcess;

export interface BackendManagerOptions {
  port: number;
  statusBar: StatusBarAdapter;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  log?: (msg: string) => void;
  /** Spawns the bundled backend; omitted in attach-only/test contexts. */
  spawn?: SpawnFn;
  /** Path to the bundled backend executable. */
  executablePath?: string;
}

export class BackendManager extends EventEmitter {
  private readonly port: number;
  private readonly statusBar: StatusBarAdapter;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;
  private readonly log: (msg: string) => void;
  private readonly spawnFn?: SpawnFn;
  private readonly executablePath?: string;

  private _isHealthy = false;
  private child?: BackendProcess;
  /** True between start() and stop(); an exit while true is a crash → restart. */
  private expectedAlive = false;
  /** In-flight start(), so concurrent callers share it instead of double-spawning. */
  private startPromise?: Promise<void>;
  /** Bumped by stop(); an in-flight start()/connect() from an older generation
   *  aborts instead of resurrecting a session the user already closed. */
  private generation = 0;
  private restartAttempts = 0;
  private static readonly MAX_RESTARTS = 3;

  constructor(opts: BackendManagerOptions) {
    super();
    this.port = opts.port;
    this.statusBar = opts.statusBar;
    this.pollIntervalMs = opts.pollIntervalMs ?? 500;
    this.pollTimeoutMs = opts.pollTimeoutMs ?? 30_000;
    this.log = opts.log ?? (() => {});
    this.spawnFn = opts.spawn;
    this.executablePath = opts.executablePath;

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
      const child = this.spawnFn(this.executablePath, ['--urls', `http://localhost:${this.port}`]);
      this.child = child;
      child.on('error', (err) => this.log(`[BackendManager] spawn error: ${err.message}`));
      child.on('exit', (code) => this.handleExit(code));
    }

    await this.connect(gen);
    if (this._isHealthy) this.restartAttempts = 0;
  }

  /** Deliberate teardown: kill the backend and cancel any in-flight start. */
  stop(): void {
    this.expectedAlive = false;
    this.generation++; // cancels an in-flight doStart()/connect()
    this.restartAttempts = 0;
    const wasRunning = this.child !== undefined || this._isHealthy;
    if (this.child) {
      this.child.kill();
      this.child = undefined;
    }
    this._isHealthy = false;
    if (wasRunning) this.statusBar.setText('$(circle-slash) mEdit: Stopped');
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

  dispose(): void {
    this.stop();
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
    };
    this.statusBar.setText(labels[status]);
    this.emit('status', status);
  }
}
