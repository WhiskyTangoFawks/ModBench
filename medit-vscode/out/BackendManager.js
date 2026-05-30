"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.BackendManager = void 0;
const node_events_1 = require("node:events");
const http = __importStar(require("node:http"));
const childProcess = __importStar(require("node:child_process"));
class BackendManager extends node_events_1.EventEmitter {
    port;
    statusBar;
    binaryPath;
    pollIntervalMs;
    pollTimeoutMs;
    _mode = 'unknown';
    _isHealthy = false;
    _process = null;
    constructor(opts) {
        super();
        this.port = opts.port;
        this.statusBar = opts.statusBar;
        this.binaryPath = opts.binaryPath ?? '';
        this.pollIntervalMs = opts.pollIntervalMs ?? 500;
        this.pollTimeoutMs = opts.pollTimeoutMs ?? 15_000;
        this.statusBar.setText('$(loading~spin) mEdit: Starting…');
        this.statusBar.show();
    }
    get mode() { return this._mode; }
    get isHealthy() { return this._isHealthy; }
    async connect() {
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
    setStatus(status) {
        this.emitStatus(status);
    }
    dispose() {
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
    checkHealth() {
        return new Promise((resolve) => {
            const req = http.get(`http://localhost:${this.port}/health`, (res) => {
                resolve(res.statusCode === 200);
            });
            req.on('error', () => resolve(false));
        });
    }
    spawnProcess() {
        const proc = childProcess.spawn(this.binaryPath, ['--urls', `http://localhost:${this.port}`], { detached: false });
        proc.stdout?.on('data', () => { });
        proc.stderr?.on('data', () => { });
        proc.on('exit', (code) => {
            if (this._isHealthy) {
                this._isHealthy = false;
                this.emitStatus('disconnected');
            }
        });
        this._process = proc;
        this._mode = 'managed';
    }
    pollUntilHealthy() {
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
                }
                else {
                    setTimeout(attempt, this.pollIntervalMs);
                }
            };
            attempt();
        });
    }
    emitStatus(status) {
        const labels = {
            starting: '$(loading~spin) mEdit: Starting…',
            attached: '$(plug) mEdit: Attached',
            managed: '$(plug) mEdit: Connected',
            'no-session': '$(plug) mEdit: No session',
            ready: '$(check) mEdit: Ready',
            disconnected: '$(error) mEdit: Disconnected',
        };
        this.statusBar.setText(labels[status]);
        this.emit('status', status);
    }
}
exports.BackendManager = BackendManager;
//# sourceMappingURL=BackendManager.js.map