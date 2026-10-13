// wb-purge / lib/install.js
// 把钩子注册进 WorkBuddy：settings.json 的 hooks 段 + 本地 marketplace 插件。
// WorkBuddy 侧 settings 的 hooks 形状（见 HookManager.getHooks）：
//   { "<EventName>": [ { matcher?: string, hooks: [ { type:"command", command, timeout } ] } ] }

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  findWbHome,
  ensurePurgeDirs,
  localPluginDir,
  LOCAL_MARKETPLACE,
  PLUGIN_NAME,
  VERSION,
} from "./core.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = path.join(__dirname, "hook.mjs");
let RUNTIME = { dir: "", entry: HOOK_SCRIPT };
const PLUGIN_ROOT_VAR = "${CODEBUDDY_PLUGIN_ROOT}";

const EVENTS = ["UserPromptSubmit", "SessionStart"];
const TAG = "wb-purge";

/** 把运行时三件套复制到 purgeHome/runtime，settings.json 指向这份，工作区删了也不影响。 */
export function materializeRuntime() {
  const p = ensurePurgeDirs();
  const rt = path.join(p.home, "runtime");
  if (!fs.existsSync(rt)) fs.mkdirSync(rt, { recursive: true });
  const files = ["hook.mjs", "rules.js", "core.js"];
  for (const name of files) {
    const src = path.join(__dirname, name);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(rt, name));
  }
  return { dir: rt, entry: path.join(rt, "hook.mjs") };
}

export function wbSettingsPath() {
  return path.join(findWbHome(), "settings.json");
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return fallback;
  }
}

function atomicWriteSync(file, data) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = file + ".wbtmp";
  fs.writeFileSync(tmp, data, "utf8");
  fs.renameSync(tmp, file);
}

/** 用绝对 node 路径：GUI 进程继承的 PATH 未必含 node，写死可避免 hook ENOENT。 */
function nodeExe() {
  if (process.env.WB_PURGE_NODE) return process.env.WB_PURGE_NODE;
  return process.execPath;
}

function nodeCommandFor(event) {
  return '"' + nodeExe() + '" "' + RUNTIME.entry + '" ' + event;
}

const OWN_MARKERS = [".workbuddy-purge", "wb-purge", "wb_purge"];

function isOurs(entry) {
  const hs = entry && Array.isArray(entry.hooks) ? entry.hooks : [];
  return hs.some(function (h) {
    if (!h || typeof h.command !== "string") return false;
    return OWN_MARKERS.some(function (m) {
      return h.command.indexOf(m) !== -1;
    });
  });
}

export function installSettingsHooks() {
  RUNTIME = materializeRuntime();
  const sp = wbSettingsPath();
  const settings = readJson(sp, {});
  const bak = sp + ".wb-purge.bak";
  if (fs.existsSync(sp) && !fs.existsSync(bak)) fs.copyFileSync(sp, bak);

  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};
  const report = [];
  EVENTS.forEach(function (ev) {
    if (!Array.isArray(settings.hooks[ev])) settings.hooks[ev] = [];
    const before = settings.hooks[ev].length;
    settings.hooks[ev] = settings.hooks[ev].filter(function (e) {
      return !isOurs(e);
    });
    const dropped = before - settings.hooks[ev].length;
    settings.hooks[ev].push({
      matcher: "*",
      hooks: [{ type: "command", command: nodeCommandFor(ev), timeout: 15 }],
    });
    report.push({ event: ev, replaced: dropped, total: settings.hooks[ev].length });
  });

  const home = ensurePurgeDirs().home;
  if (!settings.sandbox || typeof settings.sandbox !== "object") settings.sandbox = {};
  if (!Array.isArray(settings.sandbox.extraAllowWrite)) settings.sandbox.extraAllowWrite = [];
  const allow = home.split(path.sep).join("/") + "/";
  if (settings.sandbox.extraAllowWrite.indexOf(allow) === -1) {
    settings.sandbox.extraAllowWrite.push(allow);
  }

  atomicWriteSync(sp, JSON.stringify(settings, null, 2) + "\n");
  return { settings: sp, backup: bak, report: report };
}

export function uninstallSettingsHooks() {
  const sp = wbSettingsPath();
  const settings = readJson(sp, {});
  let removed = 0;
  if (settings.hooks && typeof settings.hooks === "object") {
    Object.keys(settings.hooks).forEach(function (ev) {
      if (!Array.isArray(settings.hooks[ev])) return;
      const before = settings.hooks[ev].length;
      settings.hooks[ev] = settings.hooks[ev].filter(function (e) {
        return !isOurs(e);
      });
      removed += before - settings.hooks[ev].length;
      if (settings.hooks[ev].length === 0 && EVENTS.indexOf(ev) !== -1) delete settings.hooks[ev];
    });
  }
  const home = ensurePurgeDirs().home.split(path.sep).join("/") + "/";
  const home2 = ensurePurgeDirs().home;
  if (settings.sandbox && Array.isArray(settings.sandbox.extraAllowWrite)) {
    settings.sandbox.extraAllowWrite = settings.sandbox.extraAllowWrite.filter(function (x) {
      if (x === home) return false;
      const norm = String(x).split("\\").join("/").replace(/\/$/, "");
      if (norm === home2.split(path.sep).join("/")) return false;
      return norm.indexOf(".workbuddy-purge") === -1 && norm.indexOf("/wb-purge/") === -1;
    });
  }
  atomicWriteSync(sp, JSON.stringify(settings, null, 2) + "\n");
  return { settings: sp, removed: removed };
}

/* ------------------------------------------------------------------ *
 * 本地 marketplace 插件（可选：让 UI 里能看到、能开关）
 * ------------------------------------------------------------------ */

export function installLocalPlugin() {
  if (!RUNTIME.dir) RUNTIME = materializeRuntime();
  const dir = localPluginDir();
  const mfDir = path.join(dir, ".workbuddy-plugin");
  const hooksDir = path.join(dir, "hooks");
  [dir, mfDir, hooksDir].forEach(function (d) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });

  const manifest = {
    name: PLUGIN_NAME,
    version: VERSION,
    description: "WorkBuddy 破甲：按事件注入不受限沙箱提示词，并清洗内置提示词模板。",
    author: { name: "wb-purge" },
    category: "harness",
    keywords: ["workbuddy", "prompt", "harness", "wb-purge"],
    hooks: "hooks/hooks.json",
  };
  atomicWriteSync(path.join(mfDir, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");

  const hookCopy = path.join(dir, "hook.mjs");
  fs.copyFileSync(HOOK_SCRIPT, hookCopy);
  fs.copyFileSync(path.join(__dirname, "rules.js"), path.join(dir, "rules.js"));
  fs.copyFileSync(path.join(__dirname, "core.js"), path.join(dir, "core.js"));

  // 说明：事件注册只走 settings.json 一处。
  // WorkBuddy 会同时执行 settings.hooks 与插件 hooks.json，两处都写会导致事件被触发两次、
  // 注入内容重复拼接。插件这里只放展示用的说明文件。
  const hooksObj = {};
  atomicWriteSync(
    path.join(hooksDir, "hooks.json"),
    JSON.stringify(
      { hooks: hooksObj, note: "Events are registered in settings.json only. See wb-purge README." },
      null,
      2
    ) + "\n"
  );

  const mpRoot = path.join(findWbHome(), "plugins", "marketplaces", LOCAL_MARKETPLACE);
  const mpMetaDir = path.join(mpRoot, ".workbuddy-plugin");
  if (!fs.existsSync(mpMetaDir)) fs.mkdirSync(mpMetaDir, { recursive: true });
  const mpManifest = {
    name: LOCAL_MARKETPLACE,
    description: "本地插件市场（wb-purge）",
    owner: { name: "wb-purge" },
    plugins: [
      {
        name: PLUGIN_NAME,
        description: manifest.description,
        version: VERSION,
        source: "./plugins/" + PLUGIN_NAME,
      },
    ],
  };
  atomicWriteSync(path.join(mpMetaDir, "marketplace.json"), JSON.stringify(mpManifest, null, 2) + "\n");

  registerMarketplace(mpRoot);
  enablePlugin();
  return { pluginDir: dir, marketplace: mpRoot, hook: hookCopy };
}

function registerMarketplace(mpRoot) {
  const kp = path.join(findWbHome(), "plugins", "known_marketplaces.json");
  const known = readJson(kp, {});
  known[LOCAL_MARKETPLACE] = {
    manifestName: LOCAL_MARKETPLACE,
    type: "directory",
    source: { source: "directory", path: mpRoot },
    installLocation: mpRoot,
    description: "Marketplace from " + mpRoot,
    lastUpdated: new Date().toISOString(),
    autoUpdate: false,
  };
  atomicWriteSync(kp, JSON.stringify(known, null, 2) + "\n");
}

function enablePlugin() {
  const sp = wbSettingsPath();
  const settings = readJson(sp, {});
  if (!settings.enabledPlugins || typeof settings.enabledPlugins !== "object") {
    settings.enabledPlugins = {};
  }
  settings.enabledPlugins[PLUGIN_NAME + "@" + LOCAL_MARKETPLACE] = true;
  atomicWriteSync(sp, JSON.stringify(settings, null, 2) + "\n");

  // 同时写进 installed_plugins.json，UI 插件页才会把它当已安装条目渲染。
  const ip = path.join(findWbHome(), "plugins", "installed_plugins.json");
  const reg = readJson(ip, { version: 2, plugins: {} });
  if (!reg.plugins || typeof reg.plugins !== "object") reg.plugins = {};
  const key = PLUGIN_NAME + "@" + LOCAL_MARKETPLACE;
  const now = new Date().toISOString();
  const prev = Array.isArray(reg.plugins[key]) ? reg.plugins[key][0] : null;
  reg.plugins[key] = [
    {
      scope: "user",
      installPath: localPluginDir(),
      version: VERSION,
      installedAt: (prev && prev.installedAt) || now,
      lastUpdated: now,
    },
  ];
  atomicWriteSync(ip, JSON.stringify(reg, null, 2) + "\n");
  return { settings: sp, registry: ip, key: key };
}

export function removeLocalPlugin() {
  const dir = path.join(findWbHome(), "plugins", "marketplaces", LOCAL_MARKETPLACE);
  const kp = path.join(findWbHome(), "plugins", "known_marketplaces.json");
  const known = readJson(kp, {});
  if (known[LOCAL_MARKETPLACE]) {
    delete known[LOCAL_MARKETPLACE];
    atomicWriteSync(kp, JSON.stringify(known, null, 2) + "\n");
  }

  const sp = wbSettingsPath();
  const settings = readJson(sp, {});
  if (settings.enabledPlugins && settings.enabledPlugins[PLUGIN_NAME + "@" + LOCAL_MARKETPLACE]) {
    delete settings.enabledPlugins[PLUGIN_NAME + "@" + LOCAL_MARKETPLACE];
    atomicWriteSync(sp, JSON.stringify(settings, null, 2) + "\n");
  }
  const ip = path.join(findWbHome(), "plugins", "installed_plugins.json");
  const reg = readJson(ip, {});
  if (reg.plugins && reg.plugins[PLUGIN_NAME + "@" + LOCAL_MARKETPLACE]) {
    delete reg.plugins[PLUGIN_NAME + "@" + LOCAL_MARKETPLACE];
    atomicWriteSync(ip, JSON.stringify(reg, null, 2) + "\n");
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {}
  return { removed: dir };
}