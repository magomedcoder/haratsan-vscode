# Agent tools

[Русская версия](tools-ru.md)

**Agent** mode. Paths must stay inside the workspace. Models may use `/workspace/...` as a portable alias for the first workspace folder root.

`.gitignore` and `.haratsanignore` at the workspace root are respected (together with `deniedPaths` from settings). The agent does **not** bypass ignore “to see everything”. Details: [security.md](security.md).

Confirmation follows **Settings -> Security**: `approvalPolicy` (`allow` / `ask` / `review` / `deny`) and `autoApprove` (asks -> allow; denies stay; **review** on edits still requires Accept + diff). Capability toggles can disable terminal / file / web entirely.

**Edit confirm pipeline:** one central ask/review in `executeAgentTool` (Apply / Always / Skip, or Accept / Reject for `review`). Edit tools (`write_file`, `edit_file`, `apply_patch`, `apply_workspace_edit`, `edit_notebook`, `delete_file`) do **not** show a second Always/Apply card after that (`skipConfirm`). Exception: patching over user edits still forces a conflict confirm via `withForcedConfirm`.

## Layout (`src/features/agent/tools/`)

Builtin tools are registered via a **registry** and grouped by category folders. Shared helpers (`confirm.ts`, `postEdit.ts`, `webSearchBackends.ts`) stay at the top of `tools/`.

| Folder    | Tools (names)                                                                                                                                                                            |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fs/`     | `list_dir`, `read_file`, `write_file`, `apply_patch`, `edit_file`, `apply_workspace_edit`, `edit_notebook`, `delete_file`, `create_dir`                                                  |
| `search/` | `glob`, `grep`, `file_search`, `find_code`, `find_symbol`, `codebase_search`, `semantic_search`, `search_docs`, `project_map`, `pack_context`, `similar_code`                            |
| `shell/`  | `run_command`, `await_shell`, `run_tests`, `run_scratch` (+ `task` implementation)                                                                                                       |
| `ide/`    | `get_active_editor`, `get_open_editors`, `open_file`, `close_file`, `reveal_line`, `git_status`, `get_diagnostics`, `lsp`, `find_references`                                             |
| `plan/`   | `propose_plan`, `update_plan`, `write_plan`, `list_plans`, `plan_enter`, `plan_exit`, `switch_mode`                                                                                      |
| `meta/`   | `get_workspace_info`, todos / `ask_question` / `skill` / plugins / `task` / `generate_agent` / `register_ephemeral_tool` / `repo_health` / `test_impact` / web / logs / `design_inspect` |

**Adding a tool:** one file under the category + `registerTool(...)` in that category’s `index.ts` + a row in this doc. Prefer not changing `AgentSession` / `executeAgentTool` (exceptions: ephemeral cleanup, live-editor appendix).

**Local `.haratsan/tools`:** markdown tools are also registered dynamically into the same registry on each primary agent turn (`refreshDynamicTools`). Execute returns the file body only - **no JS**. Name collisions with builtins are skipped or prefixed `local_`. Ephemeral tools (`register_ephemeral_tool`) last for the current run and are cleared via `unregisterEphemeralTools()` at turn end.

Confirmations are a **card in Haratsan chat** (Apply / Skip / Stop or Apply / Reject). The chat panel is focused automatically; there is no separate tab.

| Tool                      | Action                                                                                                                   | Confirm                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `get_workspace_info`      | Workspace folders, name, document count                                                                                  | no                                                                   |
| `get_active_editor`       | Active editor: path, language, cursor, selection                                                                         | no                                                                   |
| `get_open_editors`        | Open tabs                                                                                                                | no                                                                   |
| `list_dir`                | List files/folders (excluding ignored)                                                                                   | no                                                                   |
| `read_file`               | Read a file (optional line range); PDF via `pdftotext` (+ first-page PNG via `pdftoppm` when `visionEnabled`)            | no                                                                   |
| `glob`                    | Find paths by glob                                                                                                       | no                                                                   |
| `grep`                    | Exact text / regex search in file contents                                                                               | no                                                                   |
| `find_code`               | Hybrid intent search (fans out to path/text/index/semantic/symbols, merges hits; dirty/recent boosts)                    | no                                                                   |
| `find_symbol`             | LSP symbol cache + TS outline (workspace storage `symbols.json` / `outline.json`)                                        | no                                                                   |
| `codebase_search`         | Search the local index (trigrams, workspace storage (`storageUri/index/`))                                               | no                                                                   |
| `project_map`             | Module tree + short summaries (TS outline exports when available); cache workspace storage `map/<key>/project.json`      | no                                                                   |
| `pack_context`            | Pack top find_code/index hits under char + token budget (`max_tokens`); hits include provenance                          | no                                                                   |
| `similar_code`            | Similar snippets via trigram overlap; token budget + provenance on hits                                                  | no                                                                   |
| `propose_plan`            | Step plan; kept in session (sticky)                                                                                      | Ask                                                                  |
| `update_plan`             | Step statuses / replace / clear active plan                                                                              | replace - Ask; otherwise no                                          |
| `write_file`              | Create / fully overwrite                                                                                                 | Central ask/review only (blocked if user edited after agent)         |
| `apply_patch`             | Replace `old_string` -> `new_string`                                                                                     | Central ask/review; extra Ask only when patching over user edits     |
| `edit_file`               | DSL: `content` -> write_file, or `old_string`/`new_string` -> apply_patch                                                | Same as underlying write/patch                                       |
| `apply_workspace_edit`    | Several edits atomically                                                                                                 | Central ask/review; extra Ask only when user edits exist on any file |
| `edit_notebook`           | Edit / insert Jupyter cell (`.ipynb`)                                                                                    | Central ask/review only                                              |
| `delete_file`             | Delete a file (not a folder)                                                                                             | Central ask only                                                     |
| `create_dir`              | Create a directory                                                                                                       | no                                                                   |
| `open_file`               | Open a file in the editor                                                                                                | no                                                                   |
| `close_file`              | Close a tab (not dirty)                                                                                                  | no                                                                   |
| `reveal_line`             | Jump to a line                                                                                                           | no                                                                   |
| `git_status`              | `git status` + `diff --stat` (no commit/push)                                                                            | no                                                                   |
| `get_diagnostics`         | TS/ESLint errors, etc.                                                                                                   | no                                                                   |
| `lsp`                     | definition / references / hover / symbols (0-based line/character)                                                       | no                                                                   |
| `find_references`         | Who references Y: LSP refs (+ definition); path+pos / path+symbol / symbol; multi-root `folder`/`root`; `limit`/`offset` | no                                                                   |
| `find_logs`               | Find `*.log` / `logs/` in the workspace                                                                                  | no                                                                   |
| `read_log_tail`           | Last N lines of a log file                                                                                               | no                                                                   |
| `open_browser`            | Open URL in VSCode Simple Browser                                                                                        | Ask                                                                  |
| `fetch_page`              | HTTP GET page text/HTML (Design Mode); annotates sourceMappingURL hints                                                  | Ask; remote (non-localhost) always confirms                          |
| `design_inspect`          | URL + CSS selector -> outerHTML + guessed source via class/id grep (not full click-to-code)                              | Ask (same as fetch_page)                                             |
| `web_search`              | Web search (`duckduckgo` \| `exa` \| `parallel` \| `http`)                                                               | Ask (confirmAlwaysOrSkip)                                            |
| `run_command`             | Command in workspace cwd (allow + denylist)                                                                              | Ask                                                                  |
| `run_scratch`             | Run a file under `.haratsan/scratch/**` only (node/python/bash by ext)                                                   | Ask                                                                  |
| `await_shell`             | Wait for background `run_command` job; optional `notify_on_output` regex                                                 | no                                                                   |
| `run_tests`               | Project tests (npm / go / cargo / pytest)                                                                                | Ask                                                                  |
| `list_plugins`            | List local `.haratsan/tools` and `.haratsan/plugins` (no npm/JS)                                                         | no                                                                   |
| `plugin`                  | Load a local plugin/tool description by name into context                                                                | no                                                                   |
| `register_ephemeral_tool` | Register a markdown-only tool for this run (no JS; auto-cleared)                                                         | no                                                                   |
| `repo_health`             | MVP: TS/JS import-cycle heuristics + orphan files (JSON)                                                                 | no                                                                   |
| `test_impact`             | Suggest related `*test*` / `__tests__` from paths or git dirty                                                           | no                                                                   |

## Notes

- Local plugins/tools: see [architecture.md](architecture.md#local-plugins--tools-mvp). Catalog is injected into the system prompt; JS is not executed.
- Chat modes **Debug** / **Design** are enabled via slash commands `/debug` / `/design` (same agent loop with a focused system prompt). Debug prefers `find_logs` + `read_log_tail` + diagnostics; Design uses `open_browser` + `fetch_page` / `design_inspect` (no JS execution / no live DOM clicks). Full browser click-to-code is not wired - see `features/design/designVisual.ts`.
- Mid-turn: when `shareMode=auto`, each tool-loop iteration refreshes a short live-editor appendix (file + selection snippet) in the system prompt.
- Scratch: write scripts under `.haratsan/scratch/` (scaffold dir) and run via `run_scratch` only - **no** arbitrary JS eval from `.haratsan/tools` / ephemeral tools.
- Quality: `repo_health` (import cycles + orphans), `test_impact` (related tests). Eval suite: `src/test/eval/` - retrieval quality gate (precision@k / hit-rate / simpleScore, offline trigram) + permissions/confirm smoke; run `npm test -- --grep eval` or `npm run test:eval` (no live LLM / no remote embeddings).
- Multiple files: start with `propose_plan` -> `.haratsan/plan.md`; progress via `update_plan`. The plan survives **Clear** chat.
- Large file: short `write_file` scaffold, then `apply_patch` in chunks.
- After successful `write_file` / `apply_patch`, if the file has diagnostics, the tool result appends a short nudge (tool still succeeds). Opt-in `formatAfterEdit` in settings runs `editor.action.formatDocument` after those edits.
- Optional setting `primaryTools` (tool names, one per line): when non-empty, only those tools are offered to the primary agent (empty filter falls back to all). Subagents ignore this list.
- Subagent tool `task` (`explore` / `general` / `scout` / presets / `.haratsan/agents/`):
  - `prompt` - single job; or `prompts[]` - fan-out (read-only research by default).
  - `max_parallel` - concurrency for `prompts[]` (default 3, max 6).
  - `background` / `run_in_background` - return job ids immediately; parent is not blocked.
  - `allow_mutating_parallel` - required for `prompts[]` on non-readonly agents (e.g. `general`); each job gets its own worktree.
  - `synthesize` - write aggregate markdown under `.haratsan/reports/` (default **true** in Project mode).
  - `open_child_session` - create a child chat tab (parent<->child Teams UI).
  - `resume_job_id` - restart a previous aborted/error job (same id prefix).
  - `cleanup_worktree` - after successful **readonly** job, remove the created worktree (default **true** for explore/scout; never auto-deletes mutating worktrees). Teams UI can also cleanup finished worktrees.
  - Optional git worktree via setting `worktreesEnabled` or arg `use_worktree`. Creates branch under `.haratsan/worktrees/<slug>/` (fallback: sibling `*.haratsan-worktrees/`). Optional `worktreeStartCommand` runs once after create. Non-git workspace -> skipped, normal subagent.
- Project overview: `project_map` for a cached module tree; prefer `find_code` (intent: `symbol` \| `path` \| `text` \| `mixed`) to fan out across path/text/index/semantic/symbols; `find_symbol` for LSP cache; `pack_context` / `similar_code` for task-scoped packs and duplicates; `codebase_search` for the trigram index alone; exact grep - `grep` / `glob`.
- If the user edited a file after the agent: full `write_file` is rejected; patch via `apply_patch` / `apply_workspace_edit` after a fresh `read_file`.
- `run_command` without shell/pipe. Blocked binaries come from `deniedCommands`. Eval / git write / package install stay blocked in code. Confirm via `approvalPolicy` / `autoApprove` (Security settings).
- After an agent turn you can **Restore snapshot**.
- Secrets in tool results are masked by regexps from settings (if set).

Command policy details: [security.md](security.md#commands-run_command).
