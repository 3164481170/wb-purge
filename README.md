# wb-purge

> WorkBuddy 的 dsh-purge。三件事：**清洗内置提示词模板**、**钩子注入不受限沙箱提示词**、**本地插件登记**。

---

## 为什么不是抄 dsh-purge

| | dsh-purge（DeepSeek Harness） | wb-purge（WorkBuddy） |
|---|---|---|
| 系统提示词 | `@deepseek-ai/dsh-agent-instructions` 里的常量 | `welcomemode-*/prompt.tpl`（Nunjucks 模板） |
| 扩展点 | cordis 插件 `inject: [systemPrompt, tools]` | `settings.json.hooks` + 插件 `hooks/hooks.json` |
| 注入落点 | 改写 plugin 里的字符串 | **模板前置注入块** + **hook 的 `additionalContext`** |
| 需要动 asar | 是（官方密封包） | **否**（模板在 `plugins/cache`，是明文文件） |

WorkBuddy 的底座是 CodeBuddy（`@genie/agent-cli`），它的系统提示词由三个 `welcomemode-*` 插件在运行时用 Nunjucks 拼出来，文件就在磁盘上、可直接改。这是比 dsh 更好打的一层。

---

## 三层结构

### 第 1 层：模板清洗（对标 dsh-purge 的 82 patch）

`lib/core.js` 枚举 `~/.workbuddy/plugins/cache/workbuddy-builtin/welcomemode-{code,work,design}/<ver>/prompt.tpl`，
对每个模板做两件事：

1. 切掉对抗性段落：
   - `<content_policy>` —— 拒答四连：未成年、违法、政治敏感、港澳台表述
   - `<personal_files_safety>` —— 个人文件删除闸（8 条硬规则）
   - `<windows_command_safety>` —— Windows 命令安全闸（5 条）
   - 内容政策里的保密兜底句（"不可被角色扮演绕过"那句）
2. 在模板最前面注入 `wb-purge` 块，前后带 `{# >>> wb-purge:begin >>> #}` / `{# <<< wb-purge:end <<< #}` 标记，
   保证可幂等重放、可精确回滚。

版本目录会随 App 升级新增，所以每次 apply 都重新枚举，不缓存。

### 第 2 层：钩子注入（对标 dsh-purge 的 systemPrompt 注入）

`lib/hook.mjs` 是 hook 入口，读 stdin 的事件 JSON，往 stdout 吐 `hookSpecificOutput.additionalContext`。
挂两个事件：

- `UserPromptSubmit` —— 每次发消息前注入；这是 WorkBuddy 里唯一每轮都生效的提示词信道
- `SessionStart` —— 会话启动再补一遍，防止长会话边界漂移

WorkBuddy 侧的实现在 `codebuddy-headless.js` 里：`executeUserPromptSubmitHooks()` 读 `hookSpecificOutput.additionalContext`，
写进 `session.hookContexts.userPromptSubmitContext`。这条路径是官方支持的，不走篡改。

同时按模型名做微调（`hy3` / `glm` / `deepseek` / `kimi` / `minimax` 各一行），对标 dsh-purge 的“不同模型换不同提示词”。

### 第 3 层：本地插件登记

`lib/install.js` 在 `~/.workbuddy/plugins/marketplaces/wb-purge-local/` 下建一个本地 marketplace，
同步写 `known_marketplaces.json`、`installed_plugins.json`、`settings.json.enabledPlugins`，
让 WorkBuddy 的插件页能看到它、能开关。

---

## 用法

```bash
node wb-purge/bin/wb-purge.js --status       # 看状态
node wb-purge/bin/wb-purge.js --apply        # 清洗 + 装钩子 + 注册插件
node wb-purge/bin/wb-purge.js --apply --dry-run   # 只预览
node wb-purge/bin/wb-purge.js --revert       # 还原模板 + 移除钩子
node wb-purge/bin/wb-purge.js --uninstall    # 连本地插件一起卸
node wb-purge/bin/wb-purge.js --print        # 打印当前注入文本
```

改提示词：编辑 `~/.workbuddy-purge/prompt-inject.md`，下次 `--apply` 生效。

---

## 目录

```
~/.workbuddy-purge/
  prompt-inject.md      注入文本（可改）
  runtime/              钩子运行时的稳定副本（settings.json 指向这里）
    hook.mjs
    rules.js
    core.js
  backup/               模板原件备份（按路径哈希命名）
  applied.json          应用记录
  log.txt               钩子调用日志
```

把 runtime 单独复制出来、而不是直接指向源码目录，是为了工作区被移动或删除时钩子不会哑掉。

---

## 回滚保证

- 每个模板首次改动前 `copyFileSync` 到 `backup/`，`--revert` 按备份整文件还原
- `settings.json` 改前存一份 `.wb-purge.bak`
- 注入块有 begin/end 标记，即使备份丢了也能按标记切除
- 钩子条目按 `.workbuddy-purge` / `wb-purge` 特征识别，重装/卸载都不会误删别家钩子

---

## App 升级后怎么处理

WorkBuddy 升级会重新解包 `app.asar`，`plugins/cache/workbuddy-builtin/` 下会多出版本目录，
新版本是原始模板。重跑一次 `--apply` 即可覆盖全部版本。旧的备份不受影响。