#!/usr/bin/env node
// wb-purge / lib/hook.mjs
// WorkBuddy 钩子入口：UserPromptSubmit / PreToolUse / SessionStart
// 约定：stdin 收 hook 事件 JSON，stdout 回 hookSpecificOutput JSON。
// 依据 WorkBuddy（CodeBuddy 底座）HookExecutor.parseHookOutput 的解析格式。

import fs from "node:fs";
import path from "node:path";
import { buildHookContext, buildModelTweak } from "./rules.js";
import { purgePaths } from "./core.js";

const EVENT = process.argv[2] || "";

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function logLine(obj) {
  try {
    const p = purgePaths();
    if (!fs.existsSync(p.home)) fs.mkdirSync(p.home, { recursive: true });
    fs.appendFileSync(p.log, JSON.stringify({ at: new Date().toISOString(), ...obj }) + "\n");
  } catch {}
}

function emit(payload) {
  process.stdout.write(JSON.stringify(payload));
}

/**
 * 去重：settings.json 与本地插件的 hooks.json 都会注册同一条命令，
 * 导致每次事件被调用两次。同一 session+event 在 DEDUP_MS 内只放行第一次。
 */
const DEDUP_MS = 900;

function isDuplicate(event, input) {
  const p = purgePaths();
  const now = Date.now();
  const sid = String(input.session_id || input.transcript_path || "anon");
  const tag = sid.slice(-16) + "." + event;
  const guard = path.join(p.home, ".guard-" + tag);
  try {
    if (!fs.existsSync(p.home)) fs.mkdirSync(p.home, { recursive: true });
  } catch {}

  // 独占创建：成功 = 本进程是这轮第一个；EEXIST = 已经有人先到
  try {
    const fd = fs.openSync(guard, "wx");
    fs.writeSync(fd, String(now));
    fs.closeSync(fd);
    return false;
  } catch (e) {
    if (e.code !== "EEXIST") return false;
  }

  // 已存在：新鲜的算重复，过期的算新一轮
  try {
    const st = fs.statSync(guard);
    if (now - st.mtimeMs < DEDUP_MS) return true;
    fs.utimesSync(guard, new Date(now), new Date(now));
    return false;
  } catch {
    return false;
  }
}

const raw = readStdin();
let input = {};
try {
  input = raw ? JSON.parse(raw) : {};
} catch {
  input = {};
}

const event = input.hook_event_name || EVENT;

if (event === "UserPromptSubmit") {
  if (isDuplicate(event, input)) {
    logLine({ event, dedup: true });
    emit({ continue: true, suppressOutput: true });
    process.exit(0);
  }
  const { context, source } = buildHookContext();
  const tweak = buildModelTweak(input);
  const body = tweak ? context + "\n" + tweak : context;
  logLine({ event, source, bytes: body.length, cwd: input.cwd || "" });
  emit({
    continue: true,
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: body,
    },
  });
  process.exit(0);
}

if (event === "SessionStart") {
  if (isDuplicate(event, input)) {
    logLine({ event, dedup: true });
    emit({ continue: true, suppressOutput: true });
    process.exit(0);
  }
  const { context } = buildHookContext();
  logLine({ event, bytes: context.length });
  emit({
    continue: true,
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  });
  process.exit(0);
}

if (event === "PreToolUse") {
  // 权限闸：对高危写删路径直接放行，配合 settings.sandbox 用。
  // 默认不干预，只记录；需要拦截时把 decision 改成 deny 即可。
  logLine({ event, tool: input.tool_name || "" });
  emit({ continue: true, suppressOutput: true });
  process.exit(0);
}

logLine({ event, skipped: true });
emit({ continue: true, suppressOutput: true });
process.exit(0);