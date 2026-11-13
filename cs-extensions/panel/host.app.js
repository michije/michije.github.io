(() => {
  // panel/model.js
  var KEY = /^[a-f0-9]{64}$/;
  function parseSelection(raw) {
    if (typeof raw !== "string" || raw.length > 8192) throw new Error("invalid_settings");
    const text = raw.trim();
    let keys;
    if (text.startsWith("{")) {
      const value = JSON.parse(text);
      if (!value || value.schema !== 1 || !Array.isArray(value.muted) || value.muted.length > 32) throw new Error("invalid_settings");
      keys = value.muted;
    } else {
      keys = text === "" ? [] : text.split("\n").map((line) => line.trim()).filter(Boolean);
      if (keys.length > 32) throw new Error("invalid_settings");
    }
    if (keys.some((k) => typeof k !== "string" || !KEY.test(k)) || new Set(keys).size !== keys.length) throw new Error("invalid_settings");
    return new Set(keys);
  }
  function serializeSelection(keys) {
    return [...keys].sort().join("\n");
  }
  function serializeLocalSelection(keys) {
    return JSON.stringify({ schema: 1, muted: [...keys].sort() });
  }

  // panel/bridge.js
  var nextID = 0;
  var pending = /* @__PURE__ */ new Map();
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || !event.data || event.data.csdk !== 1) return;
    const message = event.data;
    if (!Number.isSafeInteger(message.id) || !pending.has(message.id)) return;
    const entry = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      const error = new Error(message.error.message || message.error.code || "failed");
      error.code = message.error.code || "failed";
      entry.reject(error);
    } else entry.resolve(message.result);
  });
  function request(method, params) {
    if (window.parent === window) return Promise.reject(Object.assign(new Error("offline"), { code: "offline" }));
    if (pending.size >= 16) return Promise.reject(Object.assign(new Error("busy"), { code: "busy" }));
    return new Promise((resolve, reject) => {
      const id = ++nextID;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error("timeout"), { code: "timeout" }));
      }, 7e3);
      pending.set(id, { resolve, reject, timer });
      window.parent.postMessage({ csdk: 1, id, method, params: params || {} }, "*");
    });
  }
  function sessionToken() {
    var _a;
    return ((_a = document.querySelector('meta[name="isa-session"]')) == null ? void 0 : _a.content) || "";
  }
  function localAvailable(method) {
    return sessionToken() !== "" && ["data.get", "settings.get", "settings.set"].includes(method);
  }
  async function localCall(method, params) {
    const token = sessionToken();
    if (!token) throw Object.assign(new Error("offline"), { code: "offline" });
    const write = method === "settings.set";
    if (write && params.id !== "dev.michije.isa-profiles.muted_profiles") throw Object.assign(new Error("forbidden"), { code: "forbidden" });
    let body;
    if (write) {
      const selection = parseSelection(params.value);
      body = serializeLocalSelection(selection);
    }
    const path = method === "data.get" ? "/api/view" : "/api/preferences";
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 1e4);
    let response;
    try {
      response = await fetch(path, { method: write ? "POST" : "GET", headers: { "X-ISA-Session": token, ...write ? { "Content-Type": "application/json" } : {} }, ...write ? { body } : {}, cache: "no-store", signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw Object.assign(new Error(response.status === 409 ? "changes_locked" : "offline"), { code: response.status === 409 ? "changes_locked" : "offline" });
    const result = await response.json();
    if (method === "settings.get") return { settings: [{ id: "dev.michije.isa-profiles.muted_profiles", value: serializeSelection(parseSelection(serializeLocalSelection(result.muted || []))) }] };
    return result;
  }
  async function call(method, params = {}) {
    try {
      return await request(method, params);
    } catch (error) {
      if (localAvailable(method) && ["not_found", "offline", "timeout", "unknown_method", "no_host", "busy", "failed"].includes(error.code)) {
        return localCall(method, params);
      }
      throw error;
    }
  }

  // panel/host.js
  var frame = null;
  async function connect() {
    if (frame) return;
    try {
      const raw = await call("data.get", { name: "profiles" });
      const data = typeof raw === "string" ? JSON.parse(raw) : raw;
      const url = new URL(data.ui_url);
      if (data.schema !== 1 || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error("invalid_url");
      frame = document.createElement("iframe");
      frame.id = "service";
      frame.title = "ISA by driver profile";
      frame.referrerPolicy = "no-referrer";
      frame.setAttribute("sandbox", "allow-scripts");
      frame.src = url.href;
      document.getElementById("message").remove();
      document.body.append(frame);
    } catch {
      document.getElementById("message").textContent = "The profile service is not ready. Waiting for it to start\u2026";
    }
  }
  var forward = /* @__PURE__ */ new Set(["theme", "fonts", "data.get", "settings.get", "settings.set", "status"]);
  window.addEventListener("message", async (event) => {
    const m = event.data;
    if (!frame || event.source !== frame.contentWindow || (m == null ? void 0 : m.csdk) !== 1 || !Number.isSafeInteger(m.id) || !forward.has(m.method)) return;
    try {
      const result = await call(m.method, m.params || {});
      event.source.postMessage({ csdk: 1, id: m.id, result }, "*");
    } catch (error) {
      event.source.postMessage({ csdk: 1, id: m.id, error: { code: (error == null ? void 0 : error.code) || "offline", message: (error == null ? void 0 : error.message) || "" } }, "*");
    }
  });
  connect();
  setInterval(connect, 2e3);
})();
