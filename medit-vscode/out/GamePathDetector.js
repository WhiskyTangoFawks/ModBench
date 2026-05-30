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
exports.parseLibraryFoldersVdf = parseLibraryFoldersVdf;
exports.detectGamePaths = detectGamePaths;
const fs = __importStar(require("node:fs/promises"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const node_child_process_1 = require("node:child_process");
const node_util_1 = require("node:util");
const execAsync = (0, node_util_1.promisify)(node_child_process_1.exec);
const FO4_APP_ID = '377160';
// Parses Valve's VDF format just enough to find a library path that contains a given AppID.
function parseLibraryFoldersVdf(content) {
    // Each library block looks like:  "path"  "/some/path"  ...  "appid"  "value"
    // We split by library entry and look for one containing FO4_APP_ID.
    const libraryBlocks = content.split(/"\d+"\s*\{/);
    for (const block of libraryBlocks) {
        if (!block.includes(`"${FO4_APP_ID}"`))
            continue;
        const match = block.match(/"path"\s+"([^"]+)"/);
        if (match)
            return match[1];
    }
    return null;
}
async function detectGamePaths() {
    if (process.platform === 'win32') {
        return detectWindows();
    }
    return detectLinux();
}
async function detectLinux() {
    const vdfPath = path.join(os.homedir(), '.steam', 'steam', 'config', 'libraryfolders.vdf');
    try {
        const content = await fs.readFile(vdfPath, 'utf-8');
        const library = parseLibraryFoldersVdf(content);
        if (!library)
            return null;
        const steamapps = path.join(library, 'steamapps');
        const dataFolder = path.join(steamapps, 'common', 'Fallout 4', 'Data');
        const pluginsTxt = path.join(steamapps, 'compatdata', FO4_APP_ID, 'pfx', 'drive_c', 'users', 'steamuser', 'AppData', 'Local', 'Fallout4', 'Plugins.txt');
        await fs.access(dataFolder);
        return { dataFolder, pluginsTxt };
    }
    catch {
        return null;
    }
}
async function detectWindows() {
    try {
        const { stdout } = await execAsync('reg query "HKCU\\Software\\Valve\\Steam" /v SteamPath');
        const match = stdout.match(/SteamPath\s+REG_SZ\s+(.+)/);
        if (!match)
            return null;
        const steamPath = match[1].trim();
        const steamapps = path.join(steamPath, 'steamapps');
        const dataFolder = path.join(steamapps, 'common', 'Fallout 4', 'Data');
        const pluginsTxt = path.join(process.env['LOCALAPPDATA'] ?? '', 'Fallout4', 'Plugins.txt');
        await fs.access(dataFolder);
        return { dataFolder, pluginsTxt };
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=GamePathDetector.js.map