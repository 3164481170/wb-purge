#!/usr/bin/env node
// wb-purge / bin/wb-purge.js  —  CLI

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "../lib/core.js";
import * as rules from "../lib/rules.js";
import * as install from "../lib/install.js";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);

function printStatus(s) {
  const o = [];
  o.push("wb-purge " + s.version + " 状态 / status");
  o.push("  WorkBuddy home   " + s.wbHome + (s.wbHomeExists ? "" : "  (不存在)"));
  o.push("  purge home       " + s.purgeHome);
  o.push("  注入文件         " + s.injectFile + (s.injectExists ? "  " + s.injectBytes + "B" : "  (未创建)"));
  o.push("  本地插件         " + s.pluginDir + (s.pluginInstalled ? "  [已装]" : "  [未装]"));
  o.push("");
  o.push("  提示词模板 " + s.templateCount + " 个，已清洗 " + s.patchedCount + " 个，有备份 " + s.backupCount + " 个");
  for (const t of s.templates) {
    const mk = t.patched ? "[清洗]" : "[原始]";
    o.push("    " + mk + " " + t.mode + "  " + t.version.slice(0, 28));
  }
  o.push("  片段文件 " + s.fragments + " 个");
  return o.join("\n");
}

function printReport(rep) {
  for (const r of rep) {
    const good = r.status === "applied" || r.status === "reverted" || r.status === "stripped";
    const tag = good ? "[OK]  " : r.status === "already" || r.status === "already_original" ? "[--]  " : "[!!]  ";
    const rem = r.removed && r.removed.length ? "  剥离:" + r.removed.join(",") : "";
    console.log("  " + tag + r.mode + "  " + r.status + rem);
  }
}

async function main() {
  if (has("--help") || has("-h")) {
    console.log([
      "wb-purge 用法:",
      "  wb-purge --status          查看状态",
      "  wb-purge --apply           清洗提示词模板 + 装钩子 + 注册本地插件",
      "  wb-purge --revert          还原提示词模板 + 移除钩子",
      "  wb-purge --uninstall       卸掉钩子 / 插件并还原",
      "  wb-purge --edit            打印注入文件路径",
      "  wb-purge --print           打印当前注入文本",
      "  wb-purge --dry-run         只预览，不落盘",
    ].join("\n"));
    return;
  }

  const dry = has("--dry-run");
  const state = core.gatherState();
  console.log(printStatus(state));
  console.log("");

  if (has("--preset")) {
    const name = args[args.indexOf("--preset") + 1];
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "presets");
    if (!name) {
      const avail = fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith(".txt")).map((x) => x.replace(/\.txt$/, "")) : [];
      console.log("可用预设: " + (avail.join(", ") || "(无)"));
      console.log("用法: wb-purge --preset <名称> [--apply]");
      return;
    }
    const src = path.join(dir, name + ".txt");
    if (!fs.existsSync(src)) {
      console.log("[ERROR] 预设不存在: " + src);
      process.exit(1);
    }
    const text = fs.readFileSync(src, "utf8");
    const p = core.purgePaths();
    core.ensurePurgeDirs();
    fs.writeFileSync(p.inject, text, "utf8");
    console.log("已切换预设: " + name + "  (" + text.length + "B)");
    console.log("  -> " + p.inject);
    if (has("--apply")) {
      const rep = core.applyAll(text, {});
      console.log("");
      printReport(rep);
      const hk = install.installSettingsHooks();
      console.log("settings hooks: " + hk.settings);
      const pl = install.installLocalPlugin();
      console.log("本地插件: " + pl.pluginDir);
      console.log("");
      console.log("完成。重启 WorkBuddy 生效。");
    } else {
      console.log("");
      console.log("加 --apply 一起应用。");
    }
    return;
  }

  if (has("--log")) {
    const p = core.purgePaths();
    let rows = [];
    try {
      rows = fs.readFileSync(p.log, "utf8").trim().split("\n").filter(Boolean);
    } catch {}
    const n = Number(args[args.indexOf("--log") + 1]) || 20;
    const tail = rows.slice(-n);
    console.log("钩子调用日志（最近 " + tail.length + " / 共 " + rows.length + " 条）");
    console.log("  " + p.log);
    console.log("");
    let inj = 0, ded = 0, other = 0;
    for (const line of tail) {
      try {
        const e = JSON.parse(line);
        const when = (e.at || "").slice(11, 19);
        let tag;
        if (e.dedup) { ded++; tag = "[去重]"; }
        else if (e.source || e.event === "SessionStart") { inj++; tag = "[注入]"; }
        else { other++; tag = "[其他]"; }
        console.log("  " + tag + " " + when + "  " + e.event + (e.bytes ? "  " + e.bytes + "B" : "") + (e.cwd ? "  cwd=" + e.cwd : ""));
      } catch {
        console.log("  " + line.slice(0, 120));
      }
    }
    console.log("");
    console.log("  有效注入 " + inj + " 次，去重跳过 " + ded + " 次");
    return;
  }

  if (has("--print")) {
    console.log(rules.resolveInjectText().text);
    return;
  }

  if (has("--edit")) {
    console.log("注入文件: " + core.ensureInjectFile());
    return;
  }

  if (has("--revert")) {
    const rep = core.revertAll({ dryRun: dry });
    console.log(dry ? "还原预览:" : "还原完成:");
    printReport(rep);
    if (!dry) {
      const r = install.uninstallSettingsHooks();
      console.log("  settings hooks 移除 " + r.removed + " 条: " + r.settings);
    }
    console.log("");
    console.log("重启 WorkBuddy 生效。");
    return;
  }

  if (has("--uninstall")) {
    const rep = core.revertAll({ dryRun: dry });
    printReport(rep);
    const r = install.uninstallSettingsHooks();
    console.log("  settings hooks 移除 " + r.removed + " 条");
    const p = install.removeLocalPlugin();
    console.log("  本地插件移除: " + p.removed);
    console.log("卸载完成。重启 WorkBuddy。");
    return;
  }

  if (has("--apply")) {
    const inject = rules.resolveInjectText();
    if (!inject.text) {
      console.log("[ERROR] 注入文本为空");
      process.exit(1);
    }
    console.log("注入源: " + inject.source + "  (" + inject.path + ", " + inject.text.length + "B)");
    console.log("");
    const rep = core.applyAll(inject.text, { dryRun: dry });
    console.log(dry ? "模板清洗预览:" : "模板清洗:");
    printReport(rep);
    console.log("");
    if (dry) {
      console.log("dry-run：未写入 settings / 未注册插件。");
      return;
    }
    const hk = install.installSettingsHooks();
    console.log("settings hooks 写入: " + hk.settings);
    console.log("  备份: " + hk.backup);
    for (const r of hk.report) {
      console.log("  事件 " + r.event + "  替换 " + r.replaced + "  现 " + r.total + " 条");
    }
    const pl = install.installLocalPlugin();
    console.log("本地插件: " + pl.pluginDir);
    console.log("marketplace: " + pl.marketplace);
    console.log("");
    console.log("完成。重启 WorkBuddy 生效。");
    return;
  }

  console.log("默认不动作。用 --apply 清洗，--status 看状态。");
}

main().catch((e) => {
  console.error("[wb-purge] error:", e);
  process.exit(1);
});