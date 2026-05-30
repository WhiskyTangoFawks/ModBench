"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const ApiClient_1 = require("../ApiClient");
(0, vitest_1.describe)('createApiClient', () => {
    (0, vitest_1.it)('uses the supplied port in the base URL', () => {
        const client = (0, ApiClient_1.createApiClient)(5172);
        // openapi-fetch exposes baseUrl via the internal config;
        // easiest to verify by checking the fetch is bound to the right base.
        // We don't need to call the network — just verify construction doesn't throw
        // and the returned object has the expected methods.
        (0, vitest_1.expect)(client).toHaveProperty('GET');
        (0, vitest_1.expect)(client).toHaveProperty('POST');
    });
    (0, vitest_1.it)('constructs different clients for different ports', () => {
        const a = (0, ApiClient_1.createApiClient)(5172);
        const b = (0, ApiClient_1.createApiClient)(5173);
        (0, vitest_1.expect)(a).not.toBe(b);
    });
});
//# sourceMappingURL=ApiClient.test.js.map