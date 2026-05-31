import { EventEmitter } from 'node:events';
import * as http from 'node:http';

export type BackendStatus = 'starting' | 'attached' | 'disconnected';

export interface StatusBarAdapter {
  setText(text: string): void;
  show(): void;
  dispose(): void;
}

export interface BackendManagerOptions {
  port: number;
  statusBar: StatusBarAdapter;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

export class BackendManager extends EventEmitter {
  private readonly port: number;
  private readonly statusBar: StatusBarAdapter;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;

  private _isHealthy = false;

  constructor(opts: BackendManagerOptions) {
    super();
    this.port = opts.port;
    this.statusBar = opts.statusBar;
    this.pollIntervalMs = opts.pollIntervalMs ?? 500;
    this.pollTimeoutMs = opts.pollTimeoutMs ?? 30_000;

    this.statusBar.setText('$(loading~spin) mEdit: Connecting…');
    this.statusBar.show();
  }

  get isHealthy(): boolean { return this._isHealthy; }

  connect(): Promise<void> {
    return new Promise((resolve) => {
      const deadline = Date.now() + this.pollTimeoutMs;

      const attempt = async () => {
        const healthy = await this.checkHealth();
        if (healthy) {
          this._isHealthy = true;
          this.emitStatus('attached');
          resolve();
          return;
        }

        if (Date.now() >= deadline) {
          this._isHealthy = false;
          this.emitStatus('disconnected');
          resolve();
          return;
        }

        setTimeout(attempt, this.pollIntervalMs);
      };

      attempt();
    });
  }

  dispose(): void {
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
