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
const fs = __importStar(require("node:fs/promises"));
vitest_1.vi.mock('node:fs/promises');
vitest_1.vi.mock('node:child_process');
const GamePathDetector_1 = require("../GamePathDetector");
const FO4_APP_ID = '377160';
const VDF_WITH_FO4 = `
"libraryfolders"
{
  "1"
  {
    "path"    "/mnt/games/steam"
    "apps"
    {
      "${FO4_APP_ID}"    "12345"
      "220"    "67890"
    }
  }
}
`;
const VDF_WITHOUT_FO4 = `
"libraryfolders"
{
  "1"
  {
    "path"    "/mnt/games/steam"
    "apps"
    {
      "220"    "67890"
    }
  }
}
`;
(0, vitest_1.describe)('parseLibraryFoldersVdf', () => {
    (0, vitest_1.it)('returns library path when FO4 AppID present', () => {
        const result = (0, GamePathDetector_1.parseLibraryFoldersVdf)(VDF_WITH_FO4);
        (0, vitest_1.expect)(result).toBe('/mnt/games/steam');
    });
    (0, vitest_1.it)('returns null when FO4 AppID absent', () => {
        const result = (0, GamePathDetector_1.parseLibraryFoldersVdf)(VDF_WITHOUT_FO4);
        (0, vitest_1.expect)(result).toBeNull();
    });
    (0, vitest_1.it)('handles multiple libraries and returns the one containing FO4', () => {
        const vdf = `
"libraryfolders"
{
  "1"
  {
    "path"    "/default/steam"
    "apps"
    {
      "220"    "1"
    }
  }
  "2"
  {
    "path"    "/mnt/games/steam"
    "apps"
    {
      "${FO4_APP_ID}"    "2"
    }
  }
}
`;
        (0, vitest_1.expect)((0, GamePathDetector_1.parseLibraryFoldersVdf)(vdf)).toBe('/mnt/games/steam');
    });
});
(0, vitest_1.describe)('detectGamePaths (Linux)', () => {
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.resetAllMocks();
    });
    (0, vitest_1.it)('returns correct paths when FO4 library found', async () => {
        vitest_1.vi.mocked(fs.readFile).mockResolvedValue(VDF_WITH_FO4);
        vitest_1.vi.mocked(fs.access).mockResolvedValue(undefined);
        const result = await (0, GamePathDetector_1.detectGamePaths)();
        (0, vitest_1.expect)(result).not.toBeNull();
        (0, vitest_1.expect)(result.dataFolder).toBe('/mnt/games/steam/steamapps/common/Fallout 4/Data');
        (0, vitest_1.expect)(result.pluginsTxt).toContain('Fallout4/Plugins.txt');
        (0, vitest_1.expect)(result.pluginsTxt).toContain('/mnt/games/steam/steamapps/compatdata');
    });
    (0, vitest_1.it)('returns null when VDF cannot be read', async () => {
        vitest_1.vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));
        const result = await (0, GamePathDetector_1.detectGamePaths)();
        (0, vitest_1.expect)(result).toBeNull();
    });
});
//# sourceMappingURL=GamePathDetector.test.js.map