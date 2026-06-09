"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(extension_exports);
var vscode3 = __toESM(require("vscode"));
var path2 = __toESM(require("path"));
var os2 = __toESM(require("os"));
var fs2 = __toESM(require("fs"));

// src/BackendManager.ts
var import_node_events = require("node:events");
var http = __toESM(require("node:http"));
var BackendManager = class extends import_node_events.EventEmitter {
  port;
  statusBar;
  pollIntervalMs;
  pollTimeoutMs;
  log;
  _isHealthy = false;
  constructor(opts) {
    super();
    this.port = opts.port;
    this.statusBar = opts.statusBar;
    this.pollIntervalMs = opts.pollIntervalMs ?? 500;
    this.pollTimeoutMs = opts.pollTimeoutMs ?? 3e4;
    this.log = opts.log ?? (() => {
    });
    this.statusBar.setText("$(loading~spin) mEdit: Connecting\u2026");
    this.statusBar.show();
  }
  get isHealthy() {
    return this._isHealthy;
  }
  connect() {
    return new Promise((resolve) => {
      const deadline = Date.now() + this.pollTimeoutMs;
      const attempt = async () => {
        const healthy = await this.checkHealth();
        if (healthy) {
          this._isHealthy = true;
          this.emitStatus("attached");
          resolve();
          return;
        }
        if (Date.now() >= deadline) {
          this._isHealthy = false;
          this.log(`[BackendManager] Timed out waiting for backend on port ${this.port}`);
          this.emitStatus("disconnected");
          resolve();
          return;
        }
        setTimeout(() => {
          void attempt();
        }, this.pollIntervalMs);
      };
      void attempt();
    });
  }
  dispose() {
    this.statusBar.dispose();
  }
  checkHealth() {
    return new Promise((resolve) => {
      const req = http.get(`http://localhost:${this.port}/health`, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on("error", (err) => {
        this.log(`[BackendManager] Health check error: ${err.message}`);
        resolve(false);
      });
    });
  }
  emitStatus(status) {
    const labels = {
      starting: "$(loading~spin) mEdit: Connecting\u2026",
      attached: "$(plug) mEdit: Attached",
      disconnected: "$(error) mEdit: Disconnected \u2014 start MEditService and reload"
    };
    this.statusBar.setText(labels[status]);
    this.emit("status", status);
  }
};

// node_modules/openapi-fetch/dist/index.mjs
var PATH_PARAM_RE = /\{[^{}]+\}/g;
var supportsRequestInitExt = () => {
  return typeof process === "object" && Number.parseInt(process?.versions?.node?.substring(0, 2)) >= 18 && process.versions.undici;
};
function randomID() {
  return Math.random().toString(36).slice(2, 11);
}
function createClient(clientOptions) {
  let {
    baseUrl = "",
    Request: CustomRequest = globalThis.Request,
    fetch: baseFetch = globalThis.fetch,
    querySerializer: globalQuerySerializer,
    bodySerializer: globalBodySerializer,
    pathSerializer: globalPathSerializer,
    headers: baseHeaders,
    requestInitExt = void 0,
    ...baseOptions
  } = { ...clientOptions };
  requestInitExt = supportsRequestInitExt() ? requestInitExt : void 0;
  baseUrl = removeTrailingSlash(baseUrl);
  const globalMiddlewares = [];
  async function coreFetch(schemaPath, fetchOptions) {
    const {
      baseUrl: localBaseUrl,
      fetch = baseFetch,
      Request = CustomRequest,
      headers,
      params = {},
      parseAs = "json",
      querySerializer: requestQuerySerializer,
      bodySerializer = globalBodySerializer ?? defaultBodySerializer,
      pathSerializer: requestPathSerializer,
      body,
      middleware: requestMiddlewares = [],
      ...init
    } = fetchOptions || {};
    let finalBaseUrl = baseUrl;
    if (localBaseUrl) {
      finalBaseUrl = removeTrailingSlash(localBaseUrl) ?? baseUrl;
    }
    let querySerializer = typeof globalQuerySerializer === "function" ? globalQuerySerializer : createQuerySerializer(globalQuerySerializer);
    if (requestQuerySerializer) {
      querySerializer = typeof requestQuerySerializer === "function" ? requestQuerySerializer : createQuerySerializer({
        ...typeof globalQuerySerializer === "object" ? globalQuerySerializer : {},
        ...requestQuerySerializer
      });
    }
    const pathSerializer = requestPathSerializer || globalPathSerializer || defaultPathSerializer;
    const serializedBody = body === void 0 ? void 0 : bodySerializer(
      body,
      // Note: we declare mergeHeaders() both here and below because it’s a bit of a chicken-or-egg situation:
      // bodySerializer() needs all headers so we aren’t dropping ones set by the user, however,
      // the result of this ALSO sets the lowest-priority content-type header. So we re-merge below,
      // setting the content-type at the very beginning to be overwritten.
      // Lastly, based on the way headers work, it’s not a simple “present-or-not” check becauase null intentionally un-sets headers.
      mergeHeaders(baseHeaders, headers, params.header)
    );
    const finalHeaders = mergeHeaders(
      // with no body, we should not to set Content-Type
      serializedBody === void 0 || // if serialized body is FormData; browser will correctly set Content-Type & boundary expression
      serializedBody instanceof FormData ? {} : {
        "Content-Type": "application/json"
      },
      baseHeaders,
      headers,
      params.header
    );
    const finalMiddlewares = [...globalMiddlewares, ...requestMiddlewares];
    const requestInit = {
      redirect: "follow",
      ...baseOptions,
      ...init,
      body: serializedBody,
      headers: finalHeaders
    };
    let id;
    let options;
    let request = new Request(
      createFinalURL(schemaPath, { baseUrl: finalBaseUrl, params, querySerializer, pathSerializer }),
      requestInit
    );
    let response;
    for (const key in init) {
      if (!(key in request)) {
        request[key] = init[key];
      }
    }
    if (finalMiddlewares.length) {
      id = randomID();
      options = Object.freeze({
        baseUrl: finalBaseUrl,
        fetch,
        parseAs,
        querySerializer,
        bodySerializer,
        pathSerializer
      });
      for (const m of finalMiddlewares) {
        if (m && typeof m === "object" && typeof m.onRequest === "function") {
          const result = await m.onRequest({
            request,
            schemaPath,
            params,
            options,
            id
          });
          if (result) {
            if (result instanceof Request) {
              request = result;
            } else if (result instanceof Response) {
              response = result;
              break;
            } else {
              throw new Error("onRequest: must return new Request() or Response() when modifying the request");
            }
          }
        }
      }
    }
    if (!response) {
      try {
        response = await fetch(request, requestInitExt);
      } catch (error2) {
        let errorAfterMiddleware = error2;
        if (finalMiddlewares.length) {
          for (let i = finalMiddlewares.length - 1; i >= 0; i--) {
            const m = finalMiddlewares[i];
            if (m && typeof m === "object" && typeof m.onError === "function") {
              const result = await m.onError({
                request,
                error: errorAfterMiddleware,
                schemaPath,
                params,
                options,
                id
              });
              if (result) {
                if (result instanceof Response) {
                  errorAfterMiddleware = void 0;
                  response = result;
                  break;
                }
                if (result instanceof Error) {
                  errorAfterMiddleware = result;
                  continue;
                }
                throw new Error("onError: must return new Response() or instance of Error");
              }
            }
          }
        }
        if (errorAfterMiddleware) {
          throw errorAfterMiddleware;
        }
      }
      if (finalMiddlewares.length) {
        for (let i = finalMiddlewares.length - 1; i >= 0; i--) {
          const m = finalMiddlewares[i];
          if (m && typeof m === "object" && typeof m.onResponse === "function") {
            const result = await m.onResponse({
              request,
              response,
              schemaPath,
              params,
              options,
              id
            });
            if (result) {
              if (!(result instanceof Response)) {
                throw new Error("onResponse: must return new Response() when modifying the response");
              }
              response = result;
            }
          }
        }
      }
    }
    const contentLength = response.headers.get("Content-Length");
    if (response.status === 204 || request.method === "HEAD" || contentLength === "0" && !response.headers.get("Transfer-Encoding")?.includes("chunked")) {
      return response.ok ? { data: void 0, response } : { error: void 0, response };
    }
    if (response.ok) {
      const getResponseData = async () => {
        if (parseAs === "stream") {
          return response.body;
        }
        if (parseAs === "json" && !contentLength) {
          const raw = await response.text();
          return raw ? JSON.parse(raw) : void 0;
        }
        return await response[parseAs]();
      };
      return { data: await getResponseData(), response };
    }
    let error = await response.text();
    try {
      error = JSON.parse(error);
    } catch {
    }
    return { error, response };
  }
  return {
    request(method, url, init) {
      return coreFetch(url, { ...init, method: method.toUpperCase() });
    },
    /** Call a GET endpoint */
    GET(url, init) {
      return coreFetch(url, { ...init, method: "GET" });
    },
    /** Call a PUT endpoint */
    PUT(url, init) {
      return coreFetch(url, { ...init, method: "PUT" });
    },
    /** Call a POST endpoint */
    POST(url, init) {
      return coreFetch(url, { ...init, method: "POST" });
    },
    /** Call a DELETE endpoint */
    DELETE(url, init) {
      return coreFetch(url, { ...init, method: "DELETE" });
    },
    /** Call a OPTIONS endpoint */
    OPTIONS(url, init) {
      return coreFetch(url, { ...init, method: "OPTIONS" });
    },
    /** Call a HEAD endpoint */
    HEAD(url, init) {
      return coreFetch(url, { ...init, method: "HEAD" });
    },
    /** Call a PATCH endpoint */
    PATCH(url, init) {
      return coreFetch(url, { ...init, method: "PATCH" });
    },
    /** Call a TRACE endpoint */
    TRACE(url, init) {
      return coreFetch(url, { ...init, method: "TRACE" });
    },
    /** Register middleware */
    use(...middleware) {
      for (const m of middleware) {
        if (!m) {
          continue;
        }
        if (typeof m !== "object" || !("onRequest" in m || "onResponse" in m || "onError" in m)) {
          throw new Error("Middleware must be an object with one of `onRequest()`, `onResponse() or `onError()`");
        }
        globalMiddlewares.push(m);
      }
    },
    /** Unregister middleware */
    eject(...middleware) {
      for (const m of middleware) {
        const i = globalMiddlewares.indexOf(m);
        if (i !== -1) {
          globalMiddlewares.splice(i, 1);
        }
      }
    }
  };
}
function serializePrimitiveParam(name, value, options) {
  if (value === void 0 || value === null) {
    return "";
  }
  if (typeof value === "object") {
    throw new Error(
      "Deeply-nested arrays/objects aren\u2019t supported. Provide your own `querySerializer()` to handle these."
    );
  }
  return `${name}=${options?.allowReserved === true ? value : encodeURIComponent(value)}`;
}
function serializeObjectParam(name, value, options) {
  if (!value || typeof value !== "object") {
    return "";
  }
  const values = [];
  const joiner = {
    simple: ",",
    label: ".",
    matrix: ";"
  }[options.style] || "&";
  if (options.style !== "deepObject" && options.explode === false) {
    for (const k in value) {
      values.push(k, options.allowReserved === true ? value[k] : encodeURIComponent(value[k]));
    }
    const final2 = values.join(",");
    switch (options.style) {
      case "form": {
        return `${name}=${final2}`;
      }
      case "label": {
        return `.${final2}`;
      }
      case "matrix": {
        return `;${name}=${final2}`;
      }
      default: {
        return final2;
      }
    }
  }
  for (const k in value) {
    const finalName = options.style === "deepObject" ? `${name}[${k}]` : k;
    values.push(serializePrimitiveParam(finalName, value[k], options));
  }
  const final = values.join(joiner);
  return options.style === "label" || options.style === "matrix" ? `${joiner}${final}` : final;
}
function serializeArrayParam(name, value, options) {
  if (!Array.isArray(value)) {
    return "";
  }
  if (options.explode === false) {
    const joiner2 = { form: ",", spaceDelimited: "%20", pipeDelimited: "|" }[options.style] || ",";
    const final = (options.allowReserved === true ? value : value.map((v) => encodeURIComponent(v))).join(joiner2);
    switch (options.style) {
      case "simple": {
        return final;
      }
      case "label": {
        return `.${final}`;
      }
      case "matrix": {
        return `;${name}=${final}`;
      }
      // case "spaceDelimited":
      // case "pipeDelimited":
      default: {
        return `${name}=${final}`;
      }
    }
  }
  const joiner = { simple: ",", label: ".", matrix: ";" }[options.style] || "&";
  const values = [];
  for (const v of value) {
    if (options.style === "simple" || options.style === "label") {
      values.push(options.allowReserved === true ? v : encodeURIComponent(v));
    } else {
      values.push(serializePrimitiveParam(name, v, options));
    }
  }
  return options.style === "label" || options.style === "matrix" ? `${joiner}${values.join(joiner)}` : values.join(joiner);
}
function createQuerySerializer(options) {
  return function querySerializer(queryParams) {
    const search = [];
    if (queryParams && typeof queryParams === "object") {
      for (const name in queryParams) {
        const value = queryParams[name];
        if (value === void 0 || value === null) {
          continue;
        }
        if (Array.isArray(value)) {
          if (value.length === 0) {
            continue;
          }
          search.push(
            serializeArrayParam(name, value, {
              style: "form",
              explode: true,
              ...options?.array,
              allowReserved: options?.allowReserved || false
            })
          );
          continue;
        }
        if (typeof value === "object") {
          search.push(
            serializeObjectParam(name, value, {
              style: "deepObject",
              explode: true,
              ...options?.object,
              allowReserved: options?.allowReserved || false
            })
          );
          continue;
        }
        search.push(serializePrimitiveParam(name, value, options));
      }
    }
    return search.join("&");
  };
}
function defaultPathSerializer(pathname, pathParams) {
  let nextURL = pathname;
  for (const match of pathname.match(PATH_PARAM_RE) ?? []) {
    let name = match.substring(1, match.length - 1);
    let explode = false;
    let style = "simple";
    if (name.endsWith("*")) {
      explode = true;
      name = name.substring(0, name.length - 1);
    }
    if (name.startsWith(".")) {
      style = "label";
      name = name.substring(1);
    } else if (name.startsWith(";")) {
      style = "matrix";
      name = name.substring(1);
    }
    if (!pathParams || pathParams[name] === void 0 || pathParams[name] === null) {
      continue;
    }
    const value = pathParams[name];
    if (Array.isArray(value)) {
      nextURL = nextURL.replace(match, serializeArrayParam(name, value, { style, explode }));
      continue;
    }
    if (typeof value === "object") {
      nextURL = nextURL.replace(match, serializeObjectParam(name, value, { style, explode }));
      continue;
    }
    if (style === "matrix") {
      nextURL = nextURL.replace(match, `;${serializePrimitiveParam(name, value)}`);
      continue;
    }
    nextURL = nextURL.replace(match, style === "label" ? `.${encodeURIComponent(value)}` : encodeURIComponent(value));
  }
  return nextURL;
}
function defaultBodySerializer(body, headers) {
  if (body instanceof FormData) {
    return body;
  }
  if (headers) {
    const contentType = headers.get instanceof Function ? headers.get("Content-Type") ?? headers.get("content-type") : headers["Content-Type"] ?? headers["content-type"];
    if (contentType === "application/x-www-form-urlencoded") {
      return new URLSearchParams(body).toString();
    }
  }
  return JSON.stringify(body);
}
function createFinalURL(pathname, options) {
  let finalURL = `${options.baseUrl}${pathname}`;
  if (options.params?.path) {
    finalURL = options.pathSerializer(finalURL, options.params.path);
  }
  let search = options.querySerializer(options.params.query ?? {});
  if (search.startsWith("?")) {
    search = search.substring(1);
  }
  if (search) {
    finalURL += `?${search}`;
  }
  return finalURL;
}
function mergeHeaders(...allHeaders) {
  const finalHeaders = new Headers();
  for (const h of allHeaders) {
    if (!h || typeof h !== "object") {
      continue;
    }
    const iterator = h instanceof Headers ? h.entries() : Object.entries(h);
    for (const [k, v] of iterator) {
      if (v === null) {
        finalHeaders.delete(k);
      } else if (Array.isArray(v)) {
        for (const v2 of v) {
          finalHeaders.append(k, v2);
        }
      } else if (v !== void 0) {
        finalHeaders.set(k, v);
      }
    }
  }
  return finalHeaders;
}
function removeTrailingSlash(url) {
  if (url.endsWith("/")) {
    return url.substring(0, url.length - 1);
  }
  return url;
}

// src/ApiClient.ts
function createApiClient(port) {
  return createClient({ baseUrl: `http://localhost:${port}` });
}

// src/GamePathDetector.ts
var fs = __toESM(require("node:fs/promises"));
var os = __toESM(require("node:os"));
var path = __toESM(require("node:path"));
var import_node_child_process = require("node:child_process");
var import_node_util = require("node:util");
var execAsync = (0, import_node_util.promisify)(import_node_child_process.exec);
var FO4_APP_ID = "377160";
function parseLibraryFoldersVdf(content) {
  const libraryBlocks = content.split(/"\d+"\s*\{/);
  for (const block of libraryBlocks) {
    if (!block.includes(`"${FO4_APP_ID}"`)) continue;
    const match = block.match(/"path"\s+"([^"]+)"/);
    if (match) return match[1];
  }
  return null;
}
async function detectGamePaths() {
  if (process.platform === "win32") {
    return detectWindows();
  }
  return detectLinux();
}
async function detectLinux() {
  const vdfPath = path.join(os.homedir(), ".steam", "steam", "config", "libraryfolders.vdf");
  try {
    const content = await fs.readFile(vdfPath, "utf-8");
    const library = parseLibraryFoldersVdf(content);
    if (!library) return null;
    const steamapps = path.join(library, "steamapps");
    const dataFolder = path.join(steamapps, "common", "Fallout 4", "Data");
    const pluginsTxt = path.join(
      steamapps,
      "compatdata",
      FO4_APP_ID,
      "pfx",
      "drive_c",
      "users",
      "steamuser",
      "AppData",
      "Local",
      "Fallout4",
      "Plugins.txt"
    );
    await fs.access(dataFolder);
    return { dataFolder, pluginsTxt };
  } catch {
    return null;
  }
}
async function detectWindows() {
  try {
    const { stdout } = await execAsync(
      'reg query "HKCU\\Software\\Valve\\Steam" /v SteamPath'
    );
    const match = stdout.match(/SteamPath\s+REG_SZ\s+(.+)/);
    if (!match) return null;
    const steamPath = match[1].trim();
    const steamapps = path.join(steamPath, "steamapps");
    const dataFolder = path.join(steamapps, "common", "Fallout 4", "Data");
    const pluginsTxt = path.join(
      process.env["LOCALAPPDATA"] ?? "",
      "Fallout4",
      "Plugins.txt"
    );
    await fs.access(dataFolder);
    return { dataFolder, pluginsTxt };
  } catch {
    return null;
  }
}

// src/SessionWizard.ts
var SessionWizard = class {
  constructor(deps) {
    this.deps = deps;
  }
  deps;
  async run() {
    const { data } = await this.deps.client.GET("/plugins", {});
    const plugins = data;
    if (Array.isArray(plugins) && plugins.length > 0) {
      return true;
    }
    const detected = await this.deps.detectPaths();
    const items = [
      ...detected ? [{
        label: "Use detected paths",
        detail: `${detected.dataFolder}  \u2022  ${detected.pluginsTxt}`
      }] : [],
      { label: "Choose manually\u2026" }
    ];
    const choice = await this.deps.showQuickPick(items);
    if (!choice) return false;
    let paths;
    if (choice.label === "Use detected paths" && detected) {
      paths = detected;
    } else {
      const dataFolder = await this.deps.showInputBox({ prompt: "Data folder path", value: detected?.dataFolder });
      if (!dataFolder) return false;
      const pluginsTxt = await this.deps.showInputBox({ prompt: "Plugins.txt path", value: detected?.pluginsTxt });
      if (!pluginsTxt) return false;
      paths = { dataFolder, pluginsTxt };
    }
    const { response } = await this.deps.client.POST("/session/load", {
      body: { dataFolderPath: paths.dataFolder, pluginsTxtPath: paths.pluginsTxt }
    });
    if (!response.ok) {
      this.deps.showErrorMessage(`Failed to load session: ${response.status}`);
      return false;
    }
    return true;
  }
};

// src/SessionController.ts
var SessionController = class {
  constructor(deps) {
    this.deps = deps;
    this.log = deps.log ?? (() => {
    });
  }
  deps;
  log;
  async getPlugins() {
    const { data } = await this.deps.client.GET("/plugins", {});
    return data ?? [];
  }
  async createPlugin(name) {
    const { response } = await this.deps.client.POST("/plugins/create", { body: { name } });
    if (!response.ok) {
      const text = await response.text();
      this.log(`[SessionController] createPlugin failed (${response.status}): ${text}`);
      this.deps.showError(`mEdit: Failed to create plugin \u2014 ${text}`);
      return;
    }
    this.deps.refreshTree();
  }
  async copyRecordTo(formKey, target) {
    const { response } = await this.deps.client.POST(
      "/records/{formKey}/copy-to/{targetPlugin}",
      { params: { path: { formKey, targetPlugin: target } } }
    );
    if (!response.ok) {
      const text = await response.text();
      this.log(`[SessionController] copyRecordTo failed (${response.status}): ${text}`);
      this.deps.showError(`mEdit: Copy failed \u2014 ${text}`);
      return;
    }
    this.deps.refreshTree();
  }
  async loadSession() {
    const loaded = await this.deps.makeWizard().run();
    if (!loaded) return;
    this.deps.setStatusText("$(check) mEdit: Ready");
    this.deps.refreshTree();
  }
  async setFilter(sql) {
    const error = await this.deps.repository.setFilter(sql);
    if (error) {
      this.deps.showError(`mEdit: Filter failed \u2014 ${error}`);
      return false;
    }
    this.deps.setFilterActive(true, sql);
    this.deps.refreshTree();
    return true;
  }
  async clearFilter() {
    await this.deps.repository.clearFilter();
    this.deps.setFilterActive(false);
    this.deps.refreshTree();
  }
  async syncFilterState() {
    const sql = await this.deps.repository.getActiveFilter();
    this.deps.setFilterActive(sql !== null, sql ?? void 0);
  }
  async onBackendConnected() {
    const loaded = await this.deps.makeWizard().run();
    if (!loaded) {
      this.deps.setStatusText("$(plug) mEdit: No session");
      this.deps.refreshTree();
      return;
    }
    const plugins = await this.getPlugins();
    const count = plugins.length;
    if (count === 0) {
      this.deps.showWarning(
        "mEdit: Session loaded but no plugins were found. Plugins.txt may be listing no plugins (common with vanilla post-NextGen FO4). Use MO2 or add plugins to Plugins.txt manually."
      );
    }
    this.deps.setStatusText(`$(check) mEdit: Ready (${count} plugins)`);
    this.deps.refreshTree();
  }
};

// src/PluginTreeProvider.ts
var vscode = __toESM(require("vscode"));
var PAGE_SIZE = 50;
var PluginNode = class extends vscode.TreeItem {
  constructor(plugin) {
    super(plugin.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.plugin = plugin;
    this.description = `[${plugin.loadOrderIndex}] ${plugin.recordCount.toLocaleString()} records`;
    this.tooltip = plugin.path;
    this.contextValue = plugin.isImmutable ? "pluginImmutable" : "plugin";
    if (plugin.isImmutable) {
      this.iconPath = new vscode.ThemeIcon("lock");
    }
  }
  plugin;
  kind = "plugin";
};
var RecordTypeNode = class extends vscode.TreeItem {
  constructor(plugin, recordType, count) {
    super(recordType, vscode.TreeItemCollapsibleState.Collapsed);
    this.plugin = plugin;
    this.recordType = recordType;
    this.description = count.toLocaleString();
    this.contextValue = "recordType";
  }
  plugin;
  recordType;
  kind = "recordType";
};
var RecordNode = class extends vscode.TreeItem {
  constructor(record) {
    const label = record.editorId ? `${record.editorId} [${record.formKey}]` : record.formKey;
    super(label, vscode.TreeItemCollapsibleState.None);
    this.record = record;
    this.contextValue = "record";
    this.command = {
      command: "mEdit.openEditor",
      title: "Open Record",
      arguments: [{ formKey: record.formKey, label }]
    };
  }
  record;
  kind = "record";
};
var LoadMoreNode = class extends vscode.TreeItem {
  constructor(parentNode, remaining) {
    super(`$(sync) Load more\u2026 (${remaining.toLocaleString()} remaining)`, vscode.TreeItemCollapsibleState.None);
    this.parentNode = parentNode;
    this.contextValue = "loadMore";
    this.command = {
      command: "mEdit.loadMore",
      title: "Load More",
      arguments: [this]
    };
  }
  parentNode;
  kind = "loadMore";
};
var PluginTreeProvider = class {
  constructor(repository, log) {
    this.repository = repository;
    this.log = log ?? (() => {
    });
  }
  repository;
  _onDidChangeTreeData = new vscode.EventEmitter();
  onDidChangeTreeData = this._onDidChangeTreeData.event;
  pageCache = /* @__PURE__ */ new Map();
  log;
  refresh() {
    this.pageCache.clear();
    this._onDidChangeTreeData.fire(void 0);
  }
  getTreeItem(element) {
    return element;
  }
  async getChildren(element) {
    if (!element) return this.fetchPlugins();
    if (element instanceof PluginNode) return this.fetchRecordTypes(element);
    if (element instanceof RecordTypeNode) return this.fetchRecords(element);
    return [];
  }
  async loadMore(node) {
    const parent = node.parentNode;
    const cacheKey = this.cacheKey(parent);
    const cached = this.pageCache.get(cacheKey) ?? { items: [], total: 0 };
    try {
      const result = await this.repository.getRecords(
        parent.plugin,
        parent.recordType,
        cached.items.length,
        PAGE_SIZE
      );
      this.pageCache.set(cacheKey, {
        items: [...cached.items, ...result.items],
        total: result.total
      });
    } catch (e) {
      this.log(`[PluginTreeProvider] loadMore(${parent.plugin}, ${parent.recordType}) failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    this._onDidChangeTreeData.fire(parent);
  }
  cacheKey(node) {
    return `${node.plugin}::${node.recordType}`;
  }
  async fetchPlugins() {
    try {
      const plugins = await this.repository.getPlugins();
      return plugins.map((p) => new PluginNode(p));
    } catch (e) {
      this.log(`[PluginTreeProvider] fetchPlugins failed: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }
  async fetchRecordTypes(node) {
    try {
      const types = await this.repository.getRecordTypes(node.plugin.name);
      return types.map((t) => new RecordTypeNode(node.plugin.name, t.type, t.count));
    } catch (e) {
      this.log(`[PluginTreeProvider] fetchRecordTypes(${node.plugin.name}) failed: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }
  async fetchRecords(node) {
    const cacheKey = this.cacheKey(node);
    let cached = this.pageCache.get(cacheKey);
    if (!cached) {
      try {
        cached = await this.repository.getRecords(node.plugin, node.recordType, 0, PAGE_SIZE);
        this.pageCache.set(cacheKey, cached);
      } catch (e) {
        this.log(`[PluginTreeProvider] fetchRecords(${node.plugin}, ${node.recordType}) failed: ${e instanceof Error ? e.message : String(e)}`);
        return [];
      }
    }
    const nodes = cached.items.map((r) => new RecordNode(r));
    if (cached.total > cached.items.length) {
      nodes.push(new LoadMoreNode(node, cached.total - cached.items.length));
    }
    return nodes;
  }
};

// src/PluginRepository.ts
function toPluginMetadata(r) {
  return {
    name: r.name ?? "",
    path: r.path ?? "",
    loadOrderIndex: r.loadOrderIndex ?? 0,
    isLight: r.isLight ?? false,
    isMaster: r.isMaster ?? false,
    masters: r.masters ?? [],
    recordCount: r.recordCount ?? 0,
    isImmutable: r.isImmutable ?? false
  };
}
function toRecordSummary(r) {
  return {
    formKey: r.formKey ?? "",
    plugin: r.plugin ?? "",
    loadOrderIndex: r.loadOrderIndex ?? 0,
    isWinner: r.isWinner ?? false,
    editorId: r.editorId ?? null
  };
}
function toRecordTypeCount(r) {
  return { type: r.type ?? "", count: r.count ?? 0 };
}
var ApiPluginRepository = class {
  constructor(client, log) {
    this.client = client;
    this.log = log ?? (() => {
    });
  }
  client;
  log;
  async getPlugins() {
    try {
      const { data } = await this.client.GET("/plugins", {});
      const raw = data ?? [];
      return raw.map(toPluginMetadata);
    } catch (e) {
      this.log(`[PluginRepository] getPlugins failed: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }
  async getRecordTypes(plugin) {
    try {
      const { data } = await this.client.GET("/plugins/{plugin}/record-types", {
        params: { path: { plugin } }
      });
      const raw = data ?? [];
      return raw.map(toRecordTypeCount);
    } catch (e) {
      this.log(`[PluginRepository] getRecordTypes(${plugin}) failed: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }
  async getRecords(plugin, type, offset, limit) {
    try {
      const { data } = await this.client.GET("/records", {
        params: { query: { plugin, type, offset, limit } }
      });
      const raw = data;
      return {
        items: (raw?.items ?? []).map(toRecordSummary),
        total: raw?.total ?? 0
      };
    } catch (e) {
      this.log(`[PluginRepository] getRecords(${plugin}, ${type}) failed: ${e instanceof Error ? e.message : String(e)}`);
      return { items: [], total: 0 };
    }
  }
  async setFilter(sql) {
    const { response } = await this.client.POST("/session/filter", { body: { sql } });
    if (!response.ok) {
      const text = await response.text();
      this.log(`[PluginRepository] setFilter failed (${response.status}): ${text}`);
      return text;
    }
    return null;
  }
  async clearFilter() {
    await this.client.DELETE("/session/filter", {});
  }
  async getActiveFilter() {
    const { data } = await this.client.GET("/session/filter", {});
    return data?.sql ?? null;
  }
};

// src/FilterCodeLensProvider.ts
var vscode2 = __toESM(require("vscode"));
var FilterCodeLensProvider = class {
  constructor(scriptsPath) {
    this.scriptsPath = scriptsPath;
  }
  scriptsPath;
  activeFilterSql = null;
  setActiveSql(sql) {
    this.activeFilterSql = sql;
  }
  provideCodeLenses(document) {
    if (!document.uri.fsPath.startsWith(this.scriptsPath)) return [];
    const range = new vscode2.Range(new vscode2.Position(0, 0), new vscode2.Position(0, 0));
    const docSql = document.getText().trim();
    const isActive = this.activeFilterSql !== null && docSql === this.activeFilterSql.trim();
    if (isActive) {
      return [new vscode2.CodeLens(range, {
        title: "\u2713 Active \u2014 click to clear",
        command: "mEdit.clearFilter"
      })];
    }
    return [new vscode2.CodeLens(range, {
      title: "\u25B6 Apply as Filter",
      command: "mEdit.setFilterFromDocument"
    })];
  }
};

// src/webviewHtml.ts
var crypto = __toESM(require("crypto"));
function buildWebviewHtml(params) {
  const { formKey, port, scriptUri, cspSource } = params;
  const nonce = crypto.randomBytes(16).toString("base64");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; script-src 'nonce-${nonce}' ${cspSource}; style-src ${cspSource} 'unsafe-inline'; connect-src http://localhost:${port};">
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">window.mEditFormKey = ${JSON.stringify(formKey ?? "")}; window.mEditBackendPort = ${port};</script>
  <script type="module" src="${scriptUri}"></script>
</body>
</html>`;
}

// src/messages.ts
var EXTENSION_TO_WEBVIEW = {
  LOAD_RECORD: "loadRecord"
};
var WEBVIEW_TO_EXTENSION = {
  OPEN_RECORD: "openRecord"
};

// src/extension.ts
var backendManager;
async function activate(context) {
  const cfg = vscode3.workspace.getConfiguration("mEdit");
  const port = cfg.get("backendPort") ?? 5172;
  const outputChannel = vscode3.window.createOutputChannel("mEdit");
  context.subscriptions.push(outputChannel);
  const log = (msg) => outputChannel.appendLine(`[${(/* @__PURE__ */ new Date()).toISOString()}] ${msg}`);
  const statusBarItem = vscode3.window.createStatusBarItem(vscode3.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBarItem);
  backendManager = new BackendManager({
    port,
    log,
    statusBar: {
      setText: (t) => {
        statusBarItem.text = t;
      },
      show: () => statusBarItem.show(),
      dispose: () => statusBarItem.dispose()
    }
  });
  const client = createApiClient(port);
  const repository = new ApiPluginRepository(client, log);
  const treeProvider = new PluginTreeProvider(repository, log);
  const openPanels = /* @__PURE__ */ new Map();
  const scriptsPathCfg = cfg.get("scriptsPath") ?? "";
  const scriptsPath = scriptsPathCfg || path2.join(os2.homedir(), ".medit", "scripts");
  fs2.mkdirSync(scriptsPath, { recursive: true });
  const pendingChangesSql = path2.join(scriptsPath, "pending-changes.sql");
  const presetSrc = path2.join(__dirname, "..", "extension", "scripts", "pending-changes.sql");
  if (!fs2.existsSync(pendingChangesSql) && fs2.existsSync(presetSrc))
    fs2.copyFileSync(presetSrc, pendingChangesSql);
  const filterProvider = new FilterCodeLensProvider(scriptsPath);
  const setFilterActive = (active, sql) => {
    void vscode3.commands.executeCommand("setContext", "mEdit.filterActive", active);
    filterProvider.setActiveSql(active ? sql ?? null : null);
  };
  const controller = new SessionController({
    client,
    repository,
    log,
    makeWizard: () => new SessionWizard({
      client,
      detectPaths: () => {
        const dataOverride = cfg.get("game.dataFolderPath") ?? "";
        const pluginsOverride = cfg.get("game.pluginsTxtPath") ?? "";
        if (dataOverride && pluginsOverride) {
          return Promise.resolve({ dataFolder: dataOverride, pluginsTxt: pluginsOverride });
        }
        return detectGamePaths();
      },
      showQuickPick: (items) => vscode3.window.showQuickPick(items, { placeHolder: "Select game path" }),
      showInputBox: (opts) => vscode3.window.showInputBox({ prompt: opts.prompt, value: opts.value }),
      showErrorMessage: (msg) => {
        void vscode3.window.showErrorMessage(msg);
      }
    }),
    refreshTree: () => treeProvider.refresh(),
    setStatusText: (t) => {
      statusBarItem.text = t;
    },
    showWarning: (msg) => {
      void vscode3.window.showWarningMessage(msg);
    },
    showError: (msg) => {
      void vscode3.window.showErrorMessage(msg);
    },
    setFilterActive
  });
  context.subscriptions.push(
    vscode3.languages.registerCodeLensProvider({ language: "sql" }, filterProvider),
    vscode3.window.registerTreeDataProvider("mEdit.pluginTree", treeProvider),
    vscode3.commands.registerCommand("mEdit.refreshTree", () => treeProvider.refresh()),
    vscode3.commands.registerCommand("mEdit.loadSession", () => controller.loadSession()),
    vscode3.commands.registerCommand("mEdit.reloadSession", () => treeProvider.refresh()),
    vscode3.commands.registerCommand("mEdit.openEditor", (args) => {
      openRecordPanel(context, openPanels, args?.label ?? args?.formKey ?? "mEdit", args?.formKey, port);
    }),
    vscode3.commands.registerCommand("mEdit.openCompare", () => {
      openRecordPanel(context, openPanels, "mEdit", void 0, port);
    }),
    vscode3.commands.registerCommand("mEdit.loadMore", (node) => treeProvider.loadMore(node)),
    vscode3.commands.registerCommand("mEdit.newPlugin", async () => {
      const name = await promptPluginName();
      if (name) await controller.createPlugin(name);
    }),
    vscode3.commands.registerCommand("mEdit.setFilter", async () => {
      const files = fs2.existsSync(scriptsPath) ? fs2.readdirSync(scriptsPath).filter((f) => f.endsWith(".sql")) : [];
      const NEW_FILTER_LABEL = "$(add) New filter\u2026";
      const items = [
        ...files.map((f) => ({ label: f, description: scriptsPath })),
        { label: NEW_FILTER_LABEL }
      ];
      const picked = await vscode3.window.showQuickPick(items, { placeHolder: "Select .sql filter file" });
      if (!picked) return;
      if (picked.label === NEW_FILTER_LABEL) {
        const doc = await vscode3.workspace.openTextDocument({ language: "sql" });
        await vscode3.window.showTextDocument(doc);
        return;
      }
      const filePath = path2.join(scriptsPath, picked.label);
      const sql = fs2.readFileSync(filePath, "utf8");
      await controller.setFilter(sql);
    }),
    vscode3.commands.registerCommand("mEdit.setFilterFromDocument", async () => {
      const editor = vscode3.window.activeTextEditor;
      if (!editor) return;
      const sql = editor.document.getText();
      await controller.setFilter(sql);
    }),
    vscode3.commands.registerCommand("mEdit.clearFilter", () => controller.clearFilter()),
    vscode3.commands.registerCommand("mEdit.copyAsOverrideInto", async (node) => {
      const formKey = node?.record?.formKey;
      if (!formKey) {
        vscode3.window.showErrorMessage("mEdit: No record selected.");
        return;
      }
      let allPlugins;
      try {
        allPlugins = await controller.getPlugins();
      } catch {
        vscode3.window.showErrorMessage("mEdit: Failed to fetch plugins.");
        return;
      }
      const mutablePlugins = allPlugins.filter((p) => !p.isImmutable);
      const NEW_PLUGIN_LABEL = "$(add) New Plugin\u2026";
      const items = [
        { label: NEW_PLUGIN_LABEL, description: "Create a new plugin and copy into it" },
        ...mutablePlugins.map((p) => ({ label: p.name, description: `[${p.loadOrderIndex}]` }))
      ];
      const picked = await vscode3.window.showQuickPick(items, { placeHolder: "Select target plugin" });
      if (!picked) return;
      let targetPlugin = picked.label;
      if (picked.label === NEW_PLUGIN_LABEL) {
        const name = await promptPluginName();
        if (!name) return;
        await controller.createPlugin(name);
        targetPlugin = name;
      }
      await controller.copyRecordTo(formKey, targetPlugin);
    })
  );
  backendManager.on("status", (status) => {
    if (status === "attached") {
      void controller.onBackendConnected().then(() => controller.syncFilterState());
    }
  });
  await backendManager.connect().catch((err) => {
    vscode3.window.showErrorMessage(`mEdit: Backend failed to start \u2014 ${err instanceof Error ? err.message : String(err)}`);
  });
}
function deactivate() {
  backendManager?.dispose();
}
function promptPluginName() {
  return vscode3.window.showInputBox({
    prompt: "Enter new plugin name (e.g. MyPatch.esp)",
    validateInput: (v) => {
      if (!v) return "Name is required";
      if (!/\.(esp|esm|esl)$/i.test(v)) return "Extension must be .esp, .esm, or .esl";
      return void 0;
    }
  });
}
var RECORD_PANEL_KEY = "__record_view__";
function openRecordPanel(context, openPanels, title, formKey, port) {
  const existing = openPanels.get(RECORD_PANEL_KEY);
  if (existing) {
    existing.title = title;
    existing.reveal();
    if (formKey) {
      existing.webview.postMessage({ type: EXTENSION_TO_WEBVIEW.LOAD_RECORD, formKey });
    }
    return;
  }
  const panel = vscode3.window.createWebviewPanel("mEdit", title, vscode3.ViewColumn.One, {
    enableScripts: true,
    localResourceRoots: [vscode3.Uri.file(path2.join(context.extensionPath, "out", "webview"))]
  });
  openPanels.set(RECORD_PANEL_KEY, panel);
  panel.onDidDispose(() => openPanels.delete(RECORD_PANEL_KEY));
  panel.webview.onDidReceiveMessage((msg) => {
    if (typeof msg === "object" && msg !== null && "type" in msg) {
      const m = msg;
      if (m.type === WEBVIEW_TO_EXTENSION.OPEN_RECORD && m.formKey) {
        vscode3.commands.executeCommand("mEdit.openEditor", { formKey: m.formKey, label: m.formKey });
      }
    }
  });
  const scriptUri = panel.webview.asWebviewUri(
    vscode3.Uri.file(path2.join(context.extensionPath, "out", "webview", "assets", "main.js"))
  );
  panel.webview.html = buildWebviewHtml({
    formKey,
    port,
    scriptUri: scriptUri.toString(),
    cspSource: panel.webview.cspSource
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
//# sourceMappingURL=extension.js.map
