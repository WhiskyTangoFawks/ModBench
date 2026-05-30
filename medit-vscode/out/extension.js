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
var vscode2 = __toESM(require("vscode"));
var path2 = __toESM(require("path"));

// src/BackendManager.ts
var import_node_events = require("node:events");
var http = __toESM(require("node:http"));
var childProcess = __toESM(require("node:child_process"));
var BackendManager = class extends import_node_events.EventEmitter {
  port;
  statusBar;
  binaryPath;
  pollIntervalMs;
  pollTimeoutMs;
  _mode = "unknown";
  _isHealthy = false;
  _process = null;
  constructor(opts) {
    super();
    this.port = opts.port;
    this.statusBar = opts.statusBar;
    this.binaryPath = opts.binaryPath ?? "";
    this.pollIntervalMs = opts.pollIntervalMs ?? 500;
    this.pollTimeoutMs = opts.pollTimeoutMs ?? 15e3;
    this.statusBar.setText("$(loading~spin) mEdit: Starting\u2026");
    this.statusBar.show();
  }
  get mode() {
    return this._mode;
  }
  get isHealthy() {
    return this._isHealthy;
  }
  async connect() {
    const healthy = await this.checkHealth();
    if (healthy) {
      this._mode = "attached";
      this._isHealthy = true;
      this.emitStatus("attached");
      return;
    }
    this.spawnProcess();
    await this.pollUntilHealthy();
  }
  setStatus(status) {
    this.emitStatus(status);
  }
  dispose() {
    if (this._process) {
      this._process.kill("SIGTERM");
      setTimeout(() => {
        if (this._process?.exitCode === null) {
          this._process.kill("SIGKILL");
        }
      }, 3e3);
    }
    this.statusBar.dispose();
  }
  checkHealth() {
    return new Promise((resolve) => {
      const req = http.get(`http://localhost:${this.port}/health`, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on("error", () => resolve(false));
    });
  }
  spawnProcess() {
    const proc = childProcess.spawn(
      this.binaryPath,
      ["--urls", `http://localhost:${this.port}`],
      { detached: false }
    );
    proc.stdout?.on("data", () => {
    });
    proc.stderr?.on("data", () => {
    });
    proc.on("exit", (code) => {
      if (this._isHealthy) {
        this._isHealthy = false;
        this.emitStatus("disconnected");
      }
    });
    this._process = proc;
    this._mode = "managed";
  }
  pollUntilHealthy() {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + this.pollTimeoutMs;
      const attempt = async () => {
        if (Date.now() >= deadline) {
          this._isHealthy = false;
          this.emitStatus("disconnected");
          reject(new Error("Backend did not become healthy within timeout"));
          return;
        }
        const healthy = await this.checkHealth();
        if (healthy) {
          this._isHealthy = true;
          this.emitStatus("managed");
          resolve();
        } else {
          setTimeout(attempt, this.pollIntervalMs);
        }
      };
      attempt();
    });
  }
  emitStatus(status) {
    const labels = {
      starting: "$(loading~spin) mEdit: Starting\u2026",
      attached: "$(plug) mEdit: Attached",
      managed: "$(plug) mEdit: Connected",
      "no-session": "$(plug) mEdit: No session",
      ready: "$(check) mEdit: Ready",
      disconnected: "$(error) mEdit: Disconnected"
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
      fetch: fetch2 = baseFetch,
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
        fetch: fetch2,
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
        response = await fetch2(request, requestInitExt);
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
    let paths = null;
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
  constructor(client) {
    this.client = client;
  }
  client;
  _onDidChangeTreeData = new vscode.EventEmitter();
  onDidChangeTreeData = this._onDidChangeTreeData.event;
  pageCache = /* @__PURE__ */ new Map();
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
    const cached = this.pageCache.get(parent) ?? { items: [], total: 0 };
    try {
      const { data } = await this.client.GET("/records", {
        params: {
          query: {
            plugin: parent.plugin,
            type: parent.recordType,
            limit: PAGE_SIZE,
            offset: cached.items.length
          }
        }
      });
      const result = data;
      if (result) {
        cached.items = [...cached.items, ...result.items];
        cached.total = result.total;
        this.pageCache.set(parent, cached);
      }
    } catch {
    }
    this._onDidChangeTreeData.fire(parent);
  }
  async fetchPlugins() {
    try {
      const { data } = await this.client.GET("/plugins", {});
      const plugins = data ?? [];
      return plugins.map((p) => new PluginNode(p));
    } catch {
      return [];
    }
  }
  async fetchRecordTypes(node) {
    try {
      const { data } = await this.client.GET("/plugins/{plugin}/record-types", {
        params: { path: { plugin: node.plugin.name } }
      });
      const types = data ?? [];
      return types.map((t) => new RecordTypeNode(node.plugin.name, t.type, t.count));
    } catch {
      return [];
    }
  }
  async fetchRecords(node) {
    let cached = this.pageCache.get(node);
    if (!cached) {
      try {
        const { data } = await this.client.GET("/records", {
          params: {
            query: {
              plugin: node.plugin,
              type: node.recordType,
              limit: PAGE_SIZE,
              offset: 0
            }
          }
        });
        const result = data;
        cached = result ?? { items: [], total: 0 };
        this.pageCache.set(node, cached);
      } catch {
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

// src/extension.ts
var backendManager;
async function activate(context) {
  const cfg = vscode2.workspace.getConfiguration("mEdit");
  const port = cfg.get("backendPort") ?? 5172;
  const statusBarItem = vscode2.window.createStatusBarItem(vscode2.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBarItem);
  backendManager = new BackendManager({
    port,
    statusBar: {
      setText: (t) => {
        statusBarItem.text = t;
      },
      show: () => statusBarItem.show(),
      dispose: () => statusBarItem.dispose()
    },
    binaryPath: path2.join(context.extensionPath, "backend", "BethesdaPluginService.Api")
  });
  const client = createApiClient(port);
  const treeProvider = new PluginTreeProvider(client);
  const openPanels = /* @__PURE__ */ new Map();
  context.subscriptions.push(
    vscode2.window.registerTreeDataProvider("mEdit.pluginTree", treeProvider),
    vscode2.commands.registerCommand("mEdit.refreshTree", () => treeProvider.refresh()),
    vscode2.commands.registerCommand("mEdit.loadSession", async () => {
      const wizard = makeWizard(client, cfg);
      const loaded = await wizard.run();
      if (loaded) {
        backendManager?.setStatus("ready");
        await warnIfEmpty(client);
        treeProvider.refresh();
      }
    }),
    vscode2.commands.registerCommand("mEdit.reloadSession", () => {
      treeProvider.refresh();
    }),
    vscode2.commands.registerCommand("mEdit.openEditor", (args) => {
      openRecordPanel(context, openPanels, args?.label ?? args?.formKey ?? "mEdit", args?.formKey, port);
    }),
    vscode2.commands.registerCommand("mEdit.openCompare", () => {
      openRecordPanel(context, openPanels, "mEdit", void 0, port);
    }),
    vscode2.commands.registerCommand("mEdit.loadMore", (node) => treeProvider.loadMore(node)),
    vscode2.commands.registerCommand("mEdit.newPlugin", async () => {
      await runNewPlugin(port, treeProvider);
    }),
    vscode2.commands.registerCommand("mEdit.copyAsOverrideInto", async (node) => {
      const formKey = node?.record?.formKey;
      if (!formKey) {
        vscode2.window.showErrorMessage("mEdit: No record selected.");
        return;
      }
      await runCopyAsOverrideInto(client, port, formKey, treeProvider);
    })
  );
  backendManager.on("status", async (status) => {
    if (status === "attached" || status === "managed") {
      const wizard = makeWizard(client, cfg);
      const loaded = await wizard.run();
      if (loaded) {
        const { data } = await client.GET("/plugins", {}).catch(() => ({ data: null }));
        const plugins = data;
        const count = Array.isArray(plugins) ? plugins.length : 0;
        if (count === 0) {
          await warnIfEmpty(client);
        }
        statusBarItem.text = `$(check) mEdit: Ready (${count} plugins)`;
      } else {
        statusBarItem.text = "$(plug) mEdit: No session";
      }
      treeProvider.refresh();
    }
  });
  await backendManager.connect().catch((err) => {
    vscode2.window.showErrorMessage(`mEdit: Backend failed to start \u2014 ${err.message}`);
  });
}
async function warnIfEmpty(client) {
  const { data } = await client.GET("/plugins", {}).catch(() => ({ data: null }));
  const plugins = data;
  if (Array.isArray(plugins) && plugins.length === 0) {
    vscode2.window.showWarningMessage(
      "mEdit: Session loaded but no plugins were found. Plugins.txt may be listing no plugins (common with vanilla post-NextGen FO4). Use MO2 or add plugins to Plugins.txt manually."
    );
  }
}
function makeWizard(client, cfg) {
  return new SessionWizard({
    client,
    detectPaths: () => {
      const dataOverride = cfg.get("game.dataFolderPath") ?? "";
      const pluginsOverride = cfg.get("game.pluginsTxtPath") ?? "";
      if (dataOverride && pluginsOverride) {
        return Promise.resolve({ dataFolder: dataOverride, pluginsTxt: pluginsOverride });
      }
      return detectGamePaths();
    },
    showQuickPick: (items) => vscode2.window.showQuickPick(items, { placeHolder: "Select game path" }),
    showInputBox: (opts) => vscode2.window.showInputBox({ prompt: opts.prompt, value: opts.value }),
    showErrorMessage: (msg) => vscode2.window.showErrorMessage(msg)
  });
}
function deactivate() {
  backendManager?.dispose();
}
async function runNewPlugin(port, treeProvider) {
  const name = await vscode2.window.showInputBox({
    prompt: "Enter new plugin name (e.g. MyPatch.esp)",
    validateInput: (v) => {
      if (!v) return "Name is required";
      if (!/\.(esp|esm|esl)$/i.test(v)) return "Extension must be .esp, .esm, or .esl";
      return void 0;
    }
  });
  if (!name) return void 0;
  try {
    const res = await fetch(`http://localhost:${port}/plugins/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name })
    });
    if (!res.ok) {
      const text = await res.text();
      vscode2.window.showErrorMessage(`mEdit: Failed to create plugin \u2014 ${text}`);
      return void 0;
    }
    treeProvider.refresh();
    return name;
  } catch (err) {
    vscode2.window.showErrorMessage(`mEdit: Failed to create plugin \u2014 ${err instanceof Error ? err.message : String(err)}`);
    return void 0;
  }
}
async function runCopyAsOverrideInto(client, port, formKey, treeProvider) {
  let mutablePlugins = [];
  try {
    const { data } = await client.GET("/plugins", {});
    const all = data ?? [];
    mutablePlugins = all.filter((p) => !p.isImmutable);
  } catch {
    vscode2.window.showErrorMessage("mEdit: Failed to fetch plugins.");
    return;
  }
  const NEW_PLUGIN_LABEL = "$(add) New Plugin\u2026";
  const items = [
    { label: NEW_PLUGIN_LABEL, description: "Create a new plugin and copy into it" },
    ...mutablePlugins.map((p) => ({ label: p.name, description: `[${p.loadOrderIndex}]` }))
  ];
  const picked = await vscode2.window.showQuickPick(items, { placeHolder: "Select target plugin" });
  if (!picked) return;
  let targetPlugin = picked.label;
  if (picked.label === NEW_PLUGIN_LABEL) {
    const created = await runNewPlugin(port, treeProvider);
    if (!created) return;
    targetPlugin = created;
  }
  try {
    const res = await fetch(
      `http://localhost:${port}/records/${encodeURIComponent(formKey)}/copy-to/${encodeURIComponent(targetPlugin)}`,
      { method: "POST" }
    );
    if (!res.ok) {
      const text = await res.text();
      vscode2.window.showErrorMessage(`mEdit: Copy failed \u2014 ${text}`);
      return;
    }
    treeProvider.refresh();
  } catch (err) {
    vscode2.window.showErrorMessage(`mEdit: Copy failed \u2014 ${err instanceof Error ? err.message : String(err)}`);
  }
}
var RECORD_PANEL_KEY = "__record_view__";
function openRecordPanel(context, openPanels, title, formKey, port) {
  const existing = openPanels.get(RECORD_PANEL_KEY);
  if (existing) {
    existing.title = title;
    existing.reveal();
    if (formKey) {
      existing.webview.postMessage({ type: "loadRecord", formKey });
    }
    return;
  }
  const panel = vscode2.window.createWebviewPanel("mEdit", title, vscode2.ViewColumn.One, {
    enableScripts: true,
    localResourceRoots: [vscode2.Uri.file(path2.join(context.extensionPath, "out", "webview"))]
  });
  openPanels.set(RECORD_PANEL_KEY, panel);
  panel.onDidDispose(() => openPanels.delete(RECORD_PANEL_KEY));
  panel.webview.onDidReceiveMessage((msg) => {
    if (typeof msg === "object" && msg !== null && "type" in msg) {
      const m = msg;
      if (m.type === "openRecord" && m.formKey) {
        vscode2.commands.executeCommand("mEdit.openEditor", { formKey: m.formKey, label: m.formKey });
      }
    }
  });
  const scriptUri = panel.webview.asWebviewUri(
    vscode2.Uri.file(path2.join(context.extensionPath, "out", "webview", "assets", "main.js"))
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
