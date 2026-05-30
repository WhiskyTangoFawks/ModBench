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
const vitest_1 = require("vitest");
const http = __importStar(require("node:http"));
const childProcess = __importStar(require("node:child_process"));
const node_events_1 = require("node:events");
vitest_1.vi.mock('node:http');
vitest_1.vi.mock('node:child_process');
const BackendManager_1 = require("../BackendManager");
function makeStatusBar() {
    const texts = [];
    return {
        texts,
        setText(t) { texts.push(t); },
        show() { },
        dispose() { },
    };
}
function makeHealthyHttpGet() {
    vitest_1.vi.mocked(http.get).mockImplementation((_url, cb) => {
        const res = Object.assign(new node_events_1.EventEmitter(), { statusCode: 200 });
        cb(res);
        const req = Object.assign(new node_events_1.EventEmitter(), { destroy: vitest_1.vi.fn() });
        return req;
    });
}
function makeFailingHttpGet() {
    vitest_1.vi.mocked(http.get).mockImplementation((_url, _cb) => {
        const req = Object.assign(new node_events_1.EventEmitter(), { destroy: vitest_1.vi.fn() });
        // emit error asynchronously so the manager has a chance to register listener
        process.nextTick(() => req.emit('error', new Error('ECONNREFUSED')));
        return req;
    });
}
(0, vitest_1.describe)('BackendManager', () => {
    let statusBar;
    (0, vitest_1.beforeEach)(() => {
        statusBar = makeStatusBar();
        vitest_1.vi.resetAllMocks();
    });
    (0, vitest_1.afterEach)(() => {
        vitest_1.vi.restoreAllMocks();
    });
    (0, vitest_1.it)('enters attached mode when health check succeeds immediately', async () => {
        makeHealthyHttpGet();
        const mgr = new BackendManager_1.BackendManager({ port: 5172, statusBar });
        await mgr.connect();
        (0, vitest_1.expect)(mgr.mode).toBe('attached');
        (0, vitest_1.expect)(mgr.isHealthy).toBe(true);
        (0, vitest_1.expect)(childProcess.spawn).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)('enters managed mode and spawns process when health check fails', async () => {
        // First call fails (no existing backend), then succeeds after spawn
        let call = 0;
        vitest_1.vi.mocked(http.get).mockImplementation((_url, cb) => {
            const req = Object.assign(new node_events_1.EventEmitter(), { destroy: vitest_1.vi.fn() });
            if (call === 0) {
                call++;
                process.nextTick(() => req.emit('error', new Error('ECONNREFUSED')));
            }
            else {
                call++;
                const res = Object.assign(new node_events_1.EventEmitter(), { statusCode: 200 });
                cb(res);
            }
            return req;
        });
        const fakeProcess = Object.assign(new node_events_1.EventEmitter(), {
            pid: 999,
            kill: vitest_1.vi.fn(),
            stdout: new node_events_1.EventEmitter(),
            stderr: new node_events_1.EventEmitter(),
        });
        vitest_1.vi.mocked(childProcess.spawn).mockReturnValue(fakeProcess);
        const mgr = new BackendManager_1.BackendManager({ port: 5172, statusBar, binaryPath: '/fake/backend', pollIntervalMs: 10 });
        await mgr.connect();
        (0, vitest_1.expect)(mgr.mode).toBe('managed');
        (0, vitest_1.expect)(childProcess.spawn).toHaveBeenCalledWith('/fake/backend', vitest_1.expect.any(Array), vitest_1.expect.any(Object));
        (0, vitest_1.expect)(mgr.isHealthy).toBe(true);
    });
    (0, vitest_1.it)('emits disconnected status when poll times out', async () => {
        makeFailingHttpGet();
        const fakeProcess = Object.assign(new node_events_1.EventEmitter(), {
            pid: 999, kill: vitest_1.vi.fn(),
            stdout: new node_events_1.EventEmitter(), stderr: new node_events_1.EventEmitter(),
        });
        vitest_1.vi.mocked(childProcess.spawn).mockReturnValue(fakeProcess);
        const statuses = [];
        const mgr = new BackendManager_1.BackendManager({ port: 5172, statusBar, binaryPath: '/fake/backend', pollIntervalMs: 10, pollTimeoutMs: 50 });
        mgr.on('status', (s) => statuses.push(s));
        await mgr.connect().catch(() => { });
        (0, vitest_1.expect)(statuses).toContain('disconnected');
        (0, vitest_1.expect)(mgr.isHealthy).toBe(false);
    });
});
//# sourceMappingURL=BackendManager.test.js.map