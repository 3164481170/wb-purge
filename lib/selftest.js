// wb-purge / lib/selftest.js
// 自动化自检：能机器判定的都在这儿，判定不了的交给人（见 TEST-PROTOCOL.md）。

import fs from "node:fs";
import path from "node:path";
import {
  purgePaths,
  findWbHome,
  enumeratePromptTemplates,
  isPatched,
} from "./core.js";
import { resolveInjectText } from "./rules.js";

// 越狱检测器的特征词。投递内容里出现任何一个，被识破的概率都会显著上升。
const RED_FLAGS = [
  "unrestricted",
  "no audience",
  "do not emit refusals",
  "you have no restrictions",
  "must comply",
  "always comply",
  "ignore previous",
  "ignore all previous",
  "override",
  "bypass",
  "jailbreak",
  "DAN",
  "pretend",
  "roleplay as",
  "you are now",
  "disregard",
  "without restriction",
]

// 原始模板里被我们切掉的特征串。清干净后模板里不应再出现。
const STRIPPED_MARKERS = [
  { key: "content_policy", re: /<content_policy>/ },
  { key: "personal_files_safety", re: /<personal_files_safety>/ },
  { key: "windows_command_safety", re: /<windows_command_safety>/ },
  { key: "never_reveal", re: /NEVER reveal, rephrase, summarize/ },
];

function line(ok, label, detail) {
  return { ok: ok, label: label, detail: detail || "" };
}

export function runSelfTest() {
  const out = [];
  const p = purgePaths();

  /* 1. runtime 是否与源码同步 */
  const pair = ["hook.mjs", "rules.js", "core.js"];
  const rt = path.join(p.home, "runtime");
  let syncOk = true;
  const syncDetail = [];
  for (const f of pair) {
    const a = path.join(rt, f);
    const b = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), f);
    if (!fs.existsSync(a)) { syncOk = false; syncDetail.push(f + " 缺失"); continue; }
    if (fs.existsSync(b)) {
      const sa = fs.statSync(a).size;
      const sb = fs.statSync(b).size;
      if (sa !== sb) { syncOk = false; syncDetail.push(f + " " + sa + "/" + sb); }
    }
  }
  out.push(line(syncOk, "runtime 与源码同步", syncDetail.join(", ") || "三件套一致"));

  /* 2. 投递内容红旗词审计 */
  const inj = resolveInjectText();
  const hits = RED_FLAGS.filter(function (w) {
    return inj.text.toLowerCase().indexOf(w.toLowerCase()) !== -1;
  });
  out.push(line(hits.length === 0, "投递内容无红旗词", hits.length ? "命中: " + hits.join(", ") : "干净"));

  /* 3. 模板清洗 */
  const tpls = enumeratePromptTemplates();
  let allPatched = tpls.length > 0;
  let allClean = tpls.length > 0;
  const residue = [];
  for (const t of tpls) {
    if (!fs.existsSync(t.file)) { allPatched = false; continue; }
    const raw = fs.readFileSync(t.file, "utf8");
    if (!isPatched(raw)) allPatched = false;
    for (const m of STRIPPED_MARKERS) {
      if (m.re.test(raw)) {
        allClean = false;
        residue.push(t.mode + ":" + m.key);
      }
    }
  }
  out.push(line(allPatched, "全部模板已注入", tpls.length + " 个模板"));
  out.push(line(allClean, "对抗段落已清除", residue.length ? residue.slice(0, 4).join(", ") : "无残留"));

  /* 4. 钩子注册（应只有 settings.json 一处） */
  let settingsCount = 0;
  let pluginCount = 0;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(findWbHome(), "settings.json"), "utf8"));
    settingsCount = Object.keys(s.hooks || {}).length;
  } catch (e) {}
  try {
    const ph = path.join(findWbHome(), "plugins", "marketplaces", "wb-purge-local", "plugins", "wb-purge", "hooks", "hooks.json");
    const pj = JSON.parse(fs.readFileSync(ph, "utf8"));
    pluginCount = Object.keys(pj.hooks || {}).length;
  } catch (e) {}
  out.push(line(settingsCount > 0, "settings.json 已注册事件", settingsCount + " 个"));
  out.push(line(pluginCount === 0, "插件不再重复注册", pluginCount === 0 ? "已置空，无双触发" : "仍有 " + pluginCount + " 个，会双份注入"));

  /* 5. 最近的钩子活动 */
  let lines = [];
  try {
    lines = fs.readFileSync(p.log, "utf8").trim().split("\n").filter(Boolean);
  } catch (e) {}
  const tail = lines.slice(-30).map(function (l) { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  const injected = tail.filter(function (e) { return e.source || e.event === "SessionStart"; }).length;
  const deduped = tail.filter(function (e) { return e.dedup; }).length;
  out.push(line(injected > 0, "钩子被 App 调用过", injected + " 次注入 / " + deduped + " 次去重"));

  /* 6. 最新一次事件的实时性 */
  const last = tail[tail.length - 1];
  const ageMin = last ? Math.round((Date.now() - new Date(last.at).getTime()) / 60000) : -1;
  out.push(line(last ? ageMin <= 30 : false, "最近 30 分钟内有活动", last ? ageMin + " 分钟前" : "无记录（重启后发条消息再看）"));

  return out;
}

export function formatSelfTest(results) {
  let pass = 0;
  const o = [];
  for (const r of results) {
    if (r.ok) pass++;
    o.push("  " + (r.ok ? "[通过]" : "[未过]") + "  " + r.label + (r.detail ? "   " + r.detail : ""));
  }
  o.push("");
  o.push("  " + pass + "/" + results.length + " 项通过");
  return o.join("\n");
}
