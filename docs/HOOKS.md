# 本地提示词 Hooks

本地提示词 Hook 支持随 1.0.62 发布；已启用自动更新的旧版本可通过正式发布的更新清单升级。

LevelUpAgent 从 Tauri 应用数据目录读取 `hooks.json`。Windows 默认为 `%APPDATA%\com.levelup.agent\hooks.json`；真理 1.0.24 的 LevelUpAgent 目标会在这里安装所需配置和独立运行时。项目内的 `hooks.json` 不会被自动执行。

支持 `UserPromptSubmit` 和 `BeforeAgent` 两种事件，每组包含 `hooks` 数组。每个 Hook 使用 `argv` 参数数组直接启动程序，不经过 shell；用户提示词通过 UTF-8 JSON stdin 传递。`timeout` 单位为秒，限制在 1–15 秒，单次执行总预算为 20 秒。示例结构如下，路径需换成本人维护的程序：

```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "hooks": [{
        "name": "my-local-context",
        "argv": ["C:/MyTools/context.exe", "--json"],
        "timeout": 5
      }]
    }]
  }
}
```

输入字段包括 `hook_event_name`、`prompt`、`session_id` 和 `cwd`。程序 stdout 返回单个 JSON：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "本轮可使用的本地参考信息"
  }
}
```

`hookEventName` 如果提供，必须与当前事件一致。上下文会进入 Chat Completions、Responses、Anthropic Messages、Gemini 四类请求协议，不作为用户对话持久保存。同一次请求中的重复上下文只附加一次。`continue: false` 或 `decision: "block"` 可阻止该请求。

每次普通请求重新读取配置，包括 Harness 继续执行；孵化宠物的隔离流程保持自己的技能契约，不执行 Hook。已初始化的主题生成在非完全权限下跳过 Hook，完全权限下仍会执行 Hook。配置上限 128 KiB、进程输入输出各有 256 KiB 上限，附加上下文总量上限 32 KiB。超时会终止进程树，普通执行失败不会阻断模型请求。诊断记录状态码，不记录完整提示词或标准输出。

真理 Hook 的 `name` 为 `levelup-axion-hook`，用于避免旧内置路由重复执行。移除配置后，下次请求停止调用它；在真理中卸载会恢复已备份原件，修改冲突需按提示处理。

已验证：真实子进程输入输出、配置重载、卸载后停止调用、超时、异常输出、上下文去重、四类提供商请求体；前端检查 189 项通过，生产 NSIS 安装包构建通过。尚未用真实模型账号评估任务完成率。
