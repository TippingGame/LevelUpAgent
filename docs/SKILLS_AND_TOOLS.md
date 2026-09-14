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

Explicit local file paths in a submitted composer message are imported through
the same managed attachment pipeline as selected or dropped files. Recognized
paths include drive paths, quoted paths with spaces, `file://` URLs, Unix
absolute paths, and `./` or `../` paths relative to the selected workspace.
Paths have no extension allowlist, including dotfiles and extensionless files.
Quoted paths are exact; unquoted paths use the longest existing filename so
spaces in names and trailing prose can coexist. Existing files appear as message attachments, including files outside
the workspace explicitly supplied by the user. Directories and missing paths
remain text so a request to create a new file can proceed. Each file may be up
to 64 MiB, including empty files. Supported images are sent as images; reliably
decoded text and PDF/Office text are extracted up to the existing context limits.
Unrecognized binary formats, unparseable documents and text/documents above
20 MiB use original-file references for local tools. These references preserve
bytes and safe filenames, including extensions, under `.levelup-attachments/`.
Text and document context also includes an original-file reference when a
workspace is available. Repeated tool calls preserve edits to working copies.
Import does not execute files or automatically unpack arbitrary archives, and
file contents remain untrusted data. A file reference does not imply that the
model has decoded the format or that the necessary local software is installed.
For image editing, `generate_images.referenceImagePaths` accepts existing local
images and sends their actual bytes through the media provider adapter. These
model-supplied paths follow the tool's current workspace/Full permission scope;
hatch jobs continue to obtain their references from their prepared manifest.

Provider `stream_read_error` failures retain their upstream error codes and use
the bounded reconnect policy before output begins. An interrupted partial reply
is preserved instead of being replayed automatically. The conversation displays
an upstream stream interruption message, distinct from a local file permission
failure, while completed tool results remain in history.

The sandbox process tools (`start_process`, `list_processes`, `process_output`,
and `stop_process`) keep local dev servers alive for the duration of a task,
capture a bounded stdout/stderr tail, and bind process operations to the
selected workspace. Up to eight processes may run concurrently. Starting a
process or listing processes retains the 64 most recently observed completed
records, including output and exit codes; stopping a process also preserves its
recent output. Completed records do not consume running-process slots. IDs are
local to the current application run and are not restored after a restart.
An unavailable ID returns a recoverable tool error directing the Agent to
`list_processes`, rather than aborting the task. This is a host-managed QA
sandbox, not a VM or a security container: the selected permission level still
governs the command and its filesystem access. Full permission may use `workdir`
outside the workspace without changing which workspace owns the process.
The browser tool creates a temporary Chromium profile, binds CDP to loopback,
and exposes only bounded snapshot/wait/click/type/assert/console/screenshot/viewport
operations. File
URLs may point outside the active workspace under Full permission; other modes
restrict them to the workspace. Session HTTP URLs can be narrowed
with `allowedDomains`, and assertions use CDP side-effect detection plus a
restricted expression filter that rejects common navigation, storage, and DOM
mutation calls. Public web and Skill downloads filter local/private DNS answers
before connecting, then re-check the response address. Set
`LEVELUP_BROWSER_EXECUTABLE` when Chrome is installed in a non-standard path.

In Agent and Goal modes, the host preloads `browser-qa` when the current request
clearly targets a web implementation or when the current user turn modifies a
browser-facing file such as HTML, CSS, JSX, TSX, Vue, or Svelte. If the model
tries to finish without a browser inspection result after that change, Harness
injects a bounded sequence of completion continuations so lower-effort models
can progress through server startup, browser startup, and inspection even when
approvals pause the run. This behavior is provider-neutral and does not raise
the selected reasoning effort. Browser and managed-process actions retain the
normal approval policy; Full permission is required for them to run without an
approval pause.

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
