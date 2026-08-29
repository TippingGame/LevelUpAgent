# Skills And Agent Tools

LevelUpAgent discovers Skills from the following locations, in addition to the
bundled resources shipped with the application:

- bundled: `src-tauri/resources/skills/` in a source checkout, or
  `resources/skills/` beside the packaged executable;
- application data: `<app-data>/skills/`;
- user compatibility roots: `~/.agents/skills/`, `~/.codex/skills/`, and
  `~/.claude/skills/`;
- repository roots: `.agents/skills/`, `.levelup/skills/`, `.codex/skills/`,
  and `.claude/skills/` from the workspace up to its repository root.

The location inspector also shows the bundled read-only root, an optional
`CODEX_HOME/skills` root, and inherited repository roots. A new Skill defaults
to the current workspace when one is selected, otherwise to the user
`.agents/skills` root.

The desktop Skills dialog shows the resolved paths for the current machine.
`scan_skills`, `inspect_skill`, `create_skill`, `update_skill`, `install_skill`, and `delete_skill` use the same
registry as the dialog and as Agent turns. Updates create a backup under
`<app-data>/skill-backups/`; deletes move the Skill to
`<app-data>/skill-trash/` instead of deleting it permanently.

Valid Skills newly discovered under `<app-data>/skills/` are enabled
automatically on their first scan (including Skills installed by
LevelUpAxion). A later explicit disable is persisted and is never overridden
by rescans; bundled, workspace, and shared compatibility roots keep their
existing preference behavior.

When `CODEX_HOME` is set, its `skills/` directory is used for the Codex scope
and is mutable through the same host-validated operations. Without it, the
Codex scope falls back to `~/.codex/skills/`.

On Windows, Codex's installed system Skills are typically under
`C:\Users\<user>\.codex\skills\.system\`; LevelUpAgent does not modify that
directory. LevelUpAgent's own mutable application root is the app-data path
shown by the dialog, usually
`C:\Users\<user>\AppData\Roaming\com.levelup.agent\skills\`.

Bundled Skills currently include:

- `skill-creator`: author and validate reusable Skills;
- `skill-installer`: inspect and install local/HTTPS/GitHub Skills;
- `review-agent`: read-only, defect-first code and diff review;
- `web-research`: bounded, citation-oriented public web research;
- `browser-qa`: test local web applications in isolated Chromium;
- `mcp-operator`: configure and diagnose MCP servers;
- the existing layout, image-generation, and hatch-pet Skills.

The host owns permissions. Skill Markdown cannot grant access. Web results are
marked untrusted, remote/private web destinations are blocked, archives reject
path traversal and symbolic links, and bundled/Codex system Skills remain read
only. Full permission enables absolute paths for local file tools and automatic
external tool execution, while unknown credential-sensitive tools still require
an explicit approval.

The sandbox process tools (`start_process`, `list_processes`, `process_output`,
and `stop_process`) keep local dev servers alive for the duration of a task,
capture a bounded stdout/stderr tail, and bind process operations to the
selected workspace. This is a host-managed QA sandbox, not a VM or a security
container: the selected permission level still governs the command and its
filesystem access. The browser tool creates a temporary Chromium profile, binds CDP to loopback,
and exposes only bounded snapshot/wait/click/type/assert/console/screenshot/viewport
operations. File
URLs are restricted to the active workspace, session HTTP URLs can be narrowed
with `allowedDomains`, and assertions use CDP side-effect detection plus a
restricted expression filter that rejects common navigation, storage, and DOM
mutation calls. Public web and Skill downloads filter local/private DNS answers
before connecting, then re-check the response address. Set
`LEVELUP_BROWSER_EXECUTABLE` when Chrome is installed in a non-standard path.

The model-facing client capability rules, browser conformance checks, and
copy-ready manual acceptance prompts are defined in
[`CLIENT_CAPABILITIES.md`](CLIENT_CAPABILITIES.md).

MCP sessions can inspect `mcp_status`, register non-secret configuration with
`mcp_register`, and start/stop/remove saved servers from a conversation. The
registration tool deliberately rejects token-like values; put those values in
the MCP dialog so they are stored in the OS credential vault. Discovered MCP
descriptions and results are marked as external data and remain subject to
Harness approval policy.

Design references used for the browser boundary include
[`browser-use`](https://github.com/browser-use/browser-use),
[`OpenHands`](https://github.com/All-Hands-AI/OpenHands), and
[`agent-browser`](https://github.com/vercel-labs/agent-browser). LevelUpAgent
keeps their useful action/snapshot pattern while retaining its own durable
Harness ledger and permission policy.
