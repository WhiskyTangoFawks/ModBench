import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import * as childProcess from 'node:child_process';

export type BackendMode = 'unknown' | 'attached' | 'managed';
export type BackendStatus = 'starting' | 'attached' | 'managed' | 'no-session' | 'ready' | 'disconnected';

export interface StatusBarAdapter {
  setText(text: string): void;
  show(): void;
  dispose(): void;
}

export interface BackendManagerOptions {
  port: number;
  statusBar: StatusBarAdapter;
  binaryPath?: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

export class BackendManager extends EventEmitter {
  private readonly port: number;
  private readonly statusBar: StatusBarAdapter;
  private readonly binaryPath: string;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;

  private _mode: BackendMode = 'unknown';
  private _isHealthy = false;
  private _process: childProcess.ChildProcess | null = null;

  constructor(opts: BackendManagerOptions) {
    super();
    this.port = opts.port;
    this.statusBar = opts.statusBar;
    this.binaryPath = opts.binaryPath ?? '';
    this.pollIntervalMs = opts.pollIntervalMs ?? 500;
    this.pollTimeoutMs = opts.pollTimeoutMs ?? 15_000;

    this.statusBar.setText('$(loading~spin) mEdit: Starting…');
    this.statusBar.show();
  }

  get mode(): BackendMode { return this._mode; }
  get isHealthy(): boolean { return this._isHealthy; }

  async connect(): Promise<void> {
    const healthy = await this.checkHealth();
    if (healthy) {
      this._mode = 'attached';
      this._isHealthy = true;
      this.emitStatus('attached');
      return;
    }

    // Managed mode: spawn the backend process
    this.spawnProcess();
    await this.pollUntilHealthy();
  }

  setStatus(status: BackendStatus): void {
    this.emitStatus(status);
  }

  dispose(): void {
    if (this._process) {
      this._process.kill('SIGTERM');
      setTimeout(() => {
        if (this._process?.exitCode === null) {
          this._process.kill('SIGKILL');
        }
      }, 3000);
    }
    this.statusBar.dispose();
  }

  private checkHealth(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(`http://localhost:${this.port}/health`, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
    });
  }

  private spawnProcess(): void {
    const proc = childProcess.spawn(
      this.binaryPath,
      ['--urls', `http://localhost:${this.port}`],
      { detached: false }
    );

    proc.stdout?.on('data', () => {});
    proc.stderr?.on('data', () => {});

    proc.on('exit', (code) => {
      if (this._isHealthy) {
        this._isHealthy = false;
        this.emitStatus('disconnected');
      }
    });

    this._process = proc;
    this._mode = 'managed';
  }

  private pollUntilHealthy(): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + this.pollTimeoutMs;

      const attempt = async () => {
        if (Date.now() >= deadline) {
          this._isHealthy = false;
          this.emitStatus('disconnected');
          reject(new Error('Backend did not become healthy within timeout'));
          return;
        }

        const healthy = await this.checkHealth();
        if (healthy) {
          this._isHealthy = true;
          this.emitStatus('managed');
          resolve();
        } else {
          setTimeout(attempt, this.pollIntervalMs);
        }
      };

      attempt();
    });
  }

  private emitStatus(status: BackendStatus): void {
    const labels: Record<BackendStatus, string> = {
      starting:     '$(loading~spin) mEdit: Starting…',
      attached:     '$(plug) mEdit: Attached',
      managed:      '$(plug) mEdit: Connected',
      'no-session': '$(plug) mEdit: No session',
      ready:        '$(check) mEdit: Ready',
      disconnected: '$(error) mEdit: Disconnected',
    };
    this.statusBar.setText(labels[status]);
    this.emit('status', status);
  }
}
