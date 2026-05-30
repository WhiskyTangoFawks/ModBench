"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createApiClient = createApiClient;
const openapi_fetch_1 = __importDefault(require("openapi-fetch"));
function createApiClient(port) {
    return (0, openapi_fetch_1.default)({ baseUrl: `http://localhost:${port}` });
}
//# sourceMappingURL=ApiClient.js.map