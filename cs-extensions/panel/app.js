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
  function validateView(value) {
    if (!value || value.schema !== 1 || typeof value.can_edit !== "boolean" || !Number.isSafeInteger(value.updated) || !Array.isArray(value.profiles) || value.profiles.length > 32) throw new Error("invalid_state");
    const seen = /* @__PURE__ */ new Set();
    for (const p of value.profiles) {
      if (!p || typeof p.key !== "string" || !KEY.test(p.key) || seen.has(p.key) || typeof p.name !== "string" || p.name.length > 160 || typeof p.current !== "boolean" || typeof p.muted !== "boolean") throw new Error("invalid_state");
      seen.add(p.key);
    }
    return value;
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
      const selection2 = parseSelection(params.value);
      body = serializeLocalSelection(selection2);
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
  async function localSelection() {
    const token = sessionToken();
    if (!token) return null;
    try {
      const response = await fetch("/api/preferences", { headers: { "X-ISA-Session": token }, cache: "no-store" });
      if (!response.ok) return null;
      const result = await response.json();
      return parseSelection(serializeLocalSelection(result.muted || []));
    } catch {
      return null;
    }
  }
  async function mirrorLocal(keys) {
    const token = sessionToken();
    if (!token) return;
    try {
      await fetch("/api/preferences", { method: "POST", headers: { "X-ISA-Session": token, "Content-Type": "application/json" }, body: serializeLocalSelection(keys), cache: "no-store" });
    } catch {
    }
  }

  // panel/panel.js
  var $ = (id) => document.getElementById(id);
  var SETTING_ID = "dev.michije.isa-profiles.muted_profiles";
  var view = null;
  var selection = /* @__PURE__ */ new Set();
  var saving = false;
  var connected = false;
  var polling = false;
  var saveError = null;
  var errors = { changes_locked: "Changes are locked. Wait until the vehicle is ready and parked.", offline: "Connection lost. Your last selection is still saved.", legacy_conflict: "Another ISA helper is active. Disable it first.", settings_error: "Saving is unavailable on this vehicle. The list below is read-only for now.", storage_error: "Your selection could not be saved.", retrying: "Retrying the mute setting.", invalid_state: "The driver profiles could not be read.", forbidden: "CS did not allow this change." };
  function problem(code, context = "save") {
    $("error").textContent = (context === "save" && code === "not_found" ? "CS has not registered this package's profile selection setting (not_found). Your change was not saved." : errors[code]) || (context === "load" ? code === "not_found" ? "The profile service has not provided any data. Update the package or enable it again." : "Profile data could not be loaded. Please try again." : "The change could not be saved. Please try again.");
    $("error").hidden = false;
  }
  function fresh() {
    return view && Math.abs(Date.now() / 1e3 - view.updated) < 12;
  }
  function editable() {
    return connected && fresh() && view.can_edit && !saving;
  }
  function render() {
    const list = $("profiles");
    list.replaceChildren();
    list.setAttribute("aria-busy", String(!connected));
    const profiles = (view == null ? void 0 : view.profiles) || [];
    $("empty").hidden = profiles.length > 0;
    $("empty").textContent = connected ? "No driver profiles available." : "Loading profiles\u2026";
    for (const profile of profiles) {
      const row = document.createElement("label");
      row.className = "profile" + (!editable() ? " disabled" : "") + (saving ? " saving" : "");
      const info = document.createElement("span");
      info.className = "profile-info";
      const name = document.createElement("span");
      name.className = "profile-name";
      name.textContent = profile.name;
      info.append(name);
      if (profile.current) {
        const tag = document.createElement("span");
        tag.className = "current";
        tag.textContent = "Current";
        info.append(tag);
      }
      const wrap = document.createElement("span");
      wrap.className = "check-wrap";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selection.has(profile.key);
      checkbox.disabled = !editable();
      checkbox.setAttribute("aria-label", `Mute ISA for ${profile.name}`);
      checkbox.addEventListener("change", () => save(profile.key, checkbox.checked));
      wrap.append(checkbox);
      row.append(info, wrap);
      list.append(row);
    }
    let text = "Connecting\u2026", kind = "";
    if (saving) {
      text = "Saving selection\u2026";
      kind = "pending";
    } else if (!connected || !fresh()) {
      text = "Connection lost";
    } else if (view.state === "legacy_conflict") {
      text = "Another ISA helper is active";
    } else if (view.state === "settings_error") {
      text = "Read-only \xB7 saving unavailable";
    } else if (view.pending) {
      text = "Selection saved \xB7 applies when parked";
      kind = "pending";
    } else if (!view.can_edit) {
      text = "Changes are currently locked";
    } else {
      text = "Selection saved";
      kind = "good";
    }
    $("status").textContent = text;
    $("dot").className = "dot " + kind;
  }
  async function refresh() {
    var _a;
    if (polling || saving) return;
    polling = true;
    try {
      const [data, settings] = await Promise.all([call("data.get", { name: "view" }), call("settings.get")]);
      const next = validateView(typeof data === "string" ? JSON.parse(data) : data);
      const setting = (_a = settings == null ? void 0 : settings.settings) == null ? void 0 : _a.find((s) => s.id === SETTING_ID);
      const raw = Array.isArray(setting == null ? void 0 : setting.value) ? setting.value.join("\n") : setting == null ? void 0 : setting.value;
      if (typeof raw !== "string") throw new Error("invalid_settings");
      selection = parseSelection(raw);
      if (selection.size === 0) {
        const local = await localSelection();
        if (local && local.size > 0) selection = local;
      }
      view = next;
      connected = true;
      $("error").hidden = !saveError;
      if (saveError) problem(saveError);
      else if (errors[view.state]) problem(view.state, "load");
    } catch (error) {
      connected = false;
      problem(error.message, "load");
    } finally {
      polling = false;
      render();
    }
  }
  async function save(key, checked) {
    if (!editable()) {
      render();
      return;
    }
    saving = true;
    saveError = null;
    $("error").hidden = true;
    const wanted = new Set(selection);
    checked ? wanted.add(key) : wanted.delete(key);
    const known = new Set(view.profiles.map((p) => p.key));
    for (const value of wanted) if (!known.has(value)) wanted.delete(value);
    selection = wanted;
    render();
    try {
      await call("settings.set", { id: SETTING_ID, value: serializeSelection(wanted) });
      await mirrorLocal(wanted);
    } catch (error) {
      saveError = error.message;
      problem(saveError);
    } finally {
      saving = false;
      render();
      await refresh();
    }
  }
  async function boot() {
    try {
      const theme = await call("theme");
      const mode = { day: "light", night: "dark", light: "light", dark: "dark" }[theme == null ? void 0 : theme.mode];
      if (mode) document.documentElement.dataset.theme = mode;
      const fonts = await call("fonts");
      if (typeof fonts === "string") {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = fonts;
        document.head.append(link);
      }
    } catch {
    }
    await refresh();
    setInterval(refresh, 2e3);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) refresh();
    });
  }
  boot();
})();
