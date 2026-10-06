# Changelog

[Русская версия](CHANGELOG-ru.md)

## dev (Development version)

- **Index storage:** codebase index + project map moved to VS Code `storageUri` (no longer written under `.haratsan/index` / `.haratsan/map`; no migration of old project files)
- **Rename:** product renamed from Gen to **Haratsan** (UI, commands, settings, config paths)
- **Index / semantic:** stable remote embeddings (batch+retry+timeout, persistent `.haratsan/index/vectors.json` cache by content-hash); `localEmbeddingsMode=vector` local dense hash index; offline eval + paraphrases, `recallAtK`, local-vector gate

## 0.5.0 (30 September 2026)

- **Secrets:** unified SecretStorage vault; `webSearchApiKey` no longer in JSON/settings layers (migrate + clear UI); LLM apiKey via same vault
- **Permissions:** opt-in `persistAlwaysAllow` - Always patterns survive reloads (workspaceState); Permissions UI list/clear
- **Index:** Merkle `dirDigests` content-hash skip (size+mtime gate; path+size alone no longer skips); incremental outline/symbols per-file (debounced watcher; full rebuild after fullIndex)
- **Outline:** multi-language MVP - non-JS via LSP `DocumentSymbolProvider` (no Tree-sitter); TS/JS still `createSourceFile`; regex fallback only when LSP empty
- **Tools:** `repo_health` / `test_impact` - fewer false positives, `ignore[]` + `watcherIgnore`, 60s report cache, ranked test hits with reason/score
- **Tools:** `pack_context` / `similar_code` - token budget (`max_tokens` / `maxTokens`) with lowest-score eviction; structured provenance on each hit (path, line range, tool, reason, score, estimatedTokens); `pack_context` JSON now includes `hits` (+ keeps `text`)
- **Tools:** `find_references` multi-root (`folder`/`root`), optional path (workspace symbols), `limit`/`offset`/`page` paging with `total`/`hasMore`/`nextOffset`
- **Mentions:** paths with spaces via quotes / backticks (`@file "my dir/a.ts"`, `@file:"..."`, `` @file:`...` ``); autocomplete and paste quote spaced paths; unquoted mentions unchanged
- **Permissions:** policy `review` on edits shows unified diff in ConfirmCard before Apply (Accept / Reject / Always); no longer heuristic allow for non-risky paths; `autoApprove` does not skip review
- **Index UI:** cancel in-progress fullIndex (`cancelled` state); per-file partial failure keeps saved chunks + `partialErrors`; Repair/Rebuild for corrupt manifest / missing `dirDigests` (Settings -> Agent -> Indexing)
- **Eval:** retrieval quality gate (precision@k / hit-rate / simpleScore, fail thresholds) on offline trigram corpus + merge fixtures; permissions/confirm smoke in `src/test/eval/`; run `npm test -- --grep eval` or `npm run test:eval` (no remote embeddings)
- **Mentions:** `@Docs` / `@past` / `@terminals` - rank by query/arg relevance + per-kind token quotas (docs 3k / past 2.5k / terminals 2.5k) with lowest-score eviction before turn-level `fitMentionsToBudget`
- **Slash:** `$ARGUMENTS` / `$n` validation + frontmatter `arguments:` hint; autocomplete leaves `/cmd ` ready for args
- **Tests:** permission confirm matrix (ask/deny/always/skip/abort * edits/shell + web stubs; toolsFallback Continue/Stop; continueLoopOnDeny) via pure `confirmDecision` helpers - no live LLM
- **Permissions:** unified edit confirm pipeline - no duplicate Always/Apply after central ask/review (`shouldSkipToolConfirm` / `skipConfirm`); stable `awaiting_confirm` + busyDetail; overwrite-user-edits still forces confirm; compatible with batch Allow remaining
- **Permissions:** batch edit confirm - several edits in one turn get **Allow remaining edits** on ConfirmCard (turn-scoped; Always / Reject / review diff unchanged; shell and sensitive `.env*` still ask)
- **Shell:** streaming partial stdout/stderr for long `run_command` / `run_tests` / `run_scratch` (tool card + busyDetail, 120ms throttle); AbortSignal cancel without status races
- **Teams UI:** ResearchJobsPanel + Teams - subagent job cards (status / interrupt / attach transcript), parent<->child session linking
- **Subagents:** `task` `background` / interrupt / resume; `prompts[]` fan-out; `allow_mutating_parallel` for mutating parallel (per-job worktree); scout/explore `cleanup_worktree` + Teams bulk cleanup
- **Project:** `synthesize` writes aggregate reports under `.haratsan/reports/`
- **Debug:** live terminal capture via Shell Integration (`onDidStartTerminalShellExecution` stream + exit/cmd meta); ANSI stripped; Debug Mode auto-injects terminal tails (unless `@terminals` already present); `@terminals` ranks failed exits higher
- **Shell / PowerShell:** `run_scratch` supports `.ps1` via `pwsh -File` (fallback `powershell`); file-based `pwsh`/`bash` script invoke allowed even when binary is in `deniedCommands`; `-Command`/`-c` still blocked; Windows worktree start prefers `pwsh` (fallback `cmd.exe`)
- **Shell / notify_on_output:** match only **new** job output (no false positive on prior buffer); ANSI stripped; busyDetail/partial preview while watching / on MATCH
- **Shell / profiles:** `.haratsan/shell.json` env templates + named profiles (`pathPrepend`/`pathAppend`); applied on `run_command` / `run_tests` / `run_scratch` before `shell.env` hook; select via tool `profile`, `HARATSAN_SHELL_PROFILE`, or `defaultProfile`
- **Sessions:** `tabEvictionPolicy` (`closeOldestIdle` default / `block`) - at `maxTabCount`, new/fork/handoff closes oldest idle tabs (never current or busy)
- **Sessions / compact:** lossless `exportArchive` persisted under ExtensionContext.storageUri (`export-archives/`); banner + `/restore-archive` to restore full history after compact; archive cleared on clear/delete/restore

## 0.4.0 (11 September 2026)

- **Context / compact (prod path):** mention token budgets + per-kind eviction (`@codebase` first); preflight trim before complete; tool model-path cap `toolOutputModelMaxChars` (default 2000); overflow **one** shrink+retry; `midLoopAutoCompact` default on (rule-based); `llmAutoCompact` default **off**; `/compact` preview + undo; near-budget / n_ctx warn banners + `/compact` CTA; budget breakdown in header
- **Parallel research:** `task` accepts `prompts[]` (+ `max_parallel`) for read-only fan-out; busy status while research runs; aggregate JSON results
- **Tools:** `list_code_definition_names` (outline top-level defs, multi-root); `new_task` handoff to a new chat tab
- **Mentions:** `@problems`, `@git-changes` (staged/unstaged pack); outline search across all workspace folders
- **IDE:** Explain / Improve selection; Add to Haratsan from editor / terminal / notebook cells; unified `haratsan.addToChat`
- **Plan <-> Act:** settings `planModel` / `actModel`; `/deep-planning`; Plan->Act handoff unchanged + model routing by mode
- **Checkpoints:** `/undo files|task` restore modes; `/compare` QuickPick (Files / Task / both / open diff); `backgroundEditMode` setting
- **Permissions:** quick approval presets (Ask all / Dev / Allow most)
- **Worktrees:** command `Haratsan: Manage worktrees` (list / open / remove under `.haratsan/worktrees/`)
- Plugins: `run_plugin` - spawn declared `command`/`args` or `bin` under workspace only (shell confirm; no host `require`); discover `package.json` `haratsan`/`haratsanAgent` and `.haratsan/npm-plugins.json` in `list_plugins` (no require/execute)
- Project polish: «Project lead» badge, stronger team-lead / `/project` prompt, synthesize reminder after `task`
- Chat mode **project**: team-lead prompt, slash `/project`, mutating tools blocked (like multitask)
- **Tool confirm UX:** status `awaiting_confirm` on tool card + busy line; pretty JSON args in confirm/card; one central ask before execute; ConfirmCard pinned in composer dock; ask before text-only fallback when server rejects tools
- **Index/codebase MVP:** `localEmbeddingsMode` (`off`|`trigram`); `embeddingsBaseUrl` / `embeddingsModel`; TS outline -> `.haratsan/index/outline.json`; tools `find_references`, `design_inspect`; PDF text + up to 3 page PNGs via `pdftoppm`; outline/symbols debounce on watcher
- Context: n_ctx probe + budget UI + hygiene; Merkle/LSP symbols/`@map`; `edit_file` / scratch / ephemeral / `repo_health`
- `smallModel`: shared `resolveSmallModel` for title agent + compact/summary

## 0.3.0 (7 September 2026)

- **Context overflow:** parse `exceed_context_size_error` (incl. nested llama.cpp JSON); preflight estimate + shrink; auto-compact before turn; limited retry; `contextOverflowPolicy` on Request settings; clear user-facing errors instead of raw HTTP 400
- Permissions v2: approval policy UI (`allow` / `ask` / `review` / `deny`), Always + suggested pattern, session allowlist, auto-approve, continue-on-deny, capability toggles
- Confirm card: **Always** button + pattern hint; provider allow/deny patterns (`providerUsePolicy`)
- Managed admin policy: lock security keys via `HARATSAN_ADMIN_POLICY` / `/etc/gen/policy.json` (Settings shows a read-only banner)
- Slash modes: `/debug` `/design` `/plan` `/ask` `/agent`; also `/export` `/init` `/compact` `/new` `/undo` `/sessions` `/models`
- **Plan** mode: read-only edits; shell ask-or-deny (`planShellPolicy`); Plan<->Agent handoff banner and reminders
- Multitask mode + `plan_enter` / `plan_exit` / `switch_mode`; WritePlan artifacts under `.haratsan/plans/`
- Experimental code-mode: opt-in `execute` tool runs JSON (no host JS eval)
- Skills & rules: `AGENTS.md` / `.haratsanrules`, skills discovery + `skill` tool, `/init`; Settings Rules/Skills page
- Personas: Chat dropdown + Settings Personas page (`.haratsan/personas/`); Agents page to clone builtin presets into `.haratsan/agents/`
- Local plugins/tools discovery under `.haratsan/tools` and `.haratsan/plugins` (catalog + `list_plugins` / `plugin`)
- Project scaffold: Enable / `/init` creates `.haratsan/{agents,commands,plugins,skills,tools,references,plans}`
- Config layers: user `~/.config/gen/config.json` + project `.haratsan/config.json`; JSON schemas + VSCode validation
- Hooks: Settings page for `.haratsan/hooks.json`; events `beforeSubmit` / `beforeShell` / `session.diff` / `session.compacting` / `shell.env` / `file.watcher`
- Subagents: `task` (`explore` / `general`), nesting limit, optional git worktrees + start command after create
- Tools: `glob`, `grep`, `file_search`, `web_search`, `todo_write` / `todo_read`, `ask_question`, `edit_notebook`, `lsp`, `semantic_search` / `search_docs`
- Web search backends: DuckDuckGo, Exa, Parallel, or custom HTTP; model-routed patch (GPT keeps `apply_patch`)
- Shell: cwd persist, background `run_command` + `await_shell` (`notify_on_output`), per-tool Stop + timeout countdown, cwd/exit/`line N` on cards
- Mentions: `@git` `@branch_diff` `@rules` `@link` `@code` `@Docs` `@agent` `@terminals` `@past` `@alias`/`@ref`; paste path `@file`; `!command`; Ctrl+L selection
- Chat UX: multi-session + fork, concurrent tab runs, per-session drafts, AskQuestion / Todo panel, thinking toggle, in-chat model picker, context ring, notify sound
- Review: pending-changes bar with file tree + per-file Accept/Reject; CodeLens Keep/Undo on hunks; git-sync auto-Keep; edit message + revertFiles
- Indexing: toggles + engine status (CPU trigram / remote embeddings); optional OTEL spans for LLM calls
- Settings UI: split screens (Chat / Agent / Indexing / Permissions); grouped nav (Main / More); all sections always visible; clearer field toggles
- Usage page: token ledger by model (totals/sort); Quota (OAuth) placeholder
- Settings search; deep-links to VSCode Settings/Keybindings; sidebar or bottom panel (`chatViewLocation`); light/HC polish
- LLM: honor `Retry-After` on 429/5xx with visible retry status; parallel read-only tool batches; tool output truncation
- Images/attachments: paste/drag + vision; `read_file` images; auto-resize limits; export/import sessions; lossless archive after compact

## 0.2.0 (3 September 2026)

- Context Engine + `@file` / `@folder` / `@codebase` mentions in chat (Composer autocomplete)
- Docs: English docs without `-ru` suffix; Russian docs as `*-ru.md` with EN/RU cross-links
- Security setting `deniedCommands`: move `run_command` binary denylist from code into settings
- Fix **No prompt** (`open`): skip confirm dialogs for commands, plan, and overwrite of user edits
- Agent iteration limit: `0` means unlimited
- Localization: chat/settings webview + host UI strings via `l10n/bundle.l10n*.json` (EN/RU; add more locales by dropping in a new bundle)
- Opt-in project setup: do not create `.haratsan/` on folder open; Gen chat shows **Create config & index** (writes `.haratsan/config.json` + builds index)
- Composer context chips for `@file` / `@folder` / `@codebase` (pick from autocomplete, remove before send)
- Edit a user chat message; history after it is trimmed and the turn is resent
- Per-hunk Accept / Reject on agent file diffs in the chat tool card
- Settings: disable `.haratsan/plan.md` sync (`planWriteToFile`); on restart the plan loads from file, not workspaceState
- Chat modes **Debug** / **Design**: log tools (`find_logs`, `read_log_tail`) and Simple Browser / `fetch_page`
- **`.haratsanrules`** - optional workspace rules file injected into agent, ask, and comment prompts
- Chat turn queue while busy (Composer **Queue**; **Stop** / **Clear** drop the queue); session token totals logged to agent Output

## 0.1.0 (24 August 2026)

- Chat and agent in the bottom panel (`ask` / `agent`)
  - streaming responses (when the server supports it)
  - `Stop` and `Clear` buttons
  - clearing chat history does not overwrite saved storage after a cancelled request
  - token usage display (API usage): in the chat header and under messages
- Agent loop and UX
  - LLM -> tool calls -> tool execution -> results returned
  - tool-call cards in chat (pending/ok/denied/error)
  - diff preview for edits in comment mode (and patch-first approach)
  - multi-file plan: `propose_plan` -> `.haratsan/plan.md` (sticky, survives chat clear) + `update_plan` + “Open” card / manual edit with diff for the model
  - local codebase index (`.haratsan/index/`) + `codebase_search` tool
  - checkpoints: file snapshot before an agent turn and restore offer
  - custom confirmation: card in the Haratsan chat for agent, comments, and checkpoints (no separate tab, no native MessageBox)
  - collaborative editing: snapshot after write/patch, block full `write_file` over user-diff, confirm when patching over user edits
  - audit in `Output` (`Haratsan`): tool, path/details (with redaction), duration, ok/error/denied
- Workspace tools (sandboxed)
  - `list_dir`, `read_file`, `search_files`, `write_file`, `apply_patch`, `delete_file`, `create_dir`
  - path sandbox: block paths outside the workspace (`..`, symlink escape, paths outside workspace)
  - `.gitignore` / `.haratsanignore` at workspace root (`ignore` package, no `git check-ignore` per tool call)
  - confirmation for dangerous operations (write/patch/delete, etc.)
  - read-only git tools (`git_status`), diagnostics (`get_diagnostics`)
  - commands/terminal with allow/denylist policies
- LLM client
  - API key stored in `SecretStorage` (Settings -> API key)
  - authorization via `Authorization: Bearer` (or configurable header and scheme)
  - retry for `429` and `5xx` with backoff (preserving error/cause)
  - request cancellation: separate handling for timeout vs abort
  - request logs in `Output` (`Haratsan LLM`) without body or key
  - (optional) background log files: `llm.log` / `agent.log` with a non-blocking queue
- Product settings (main editor window, not the chat webview panel)
  - settings split into pages: General, Chat & Agent, Requests, Comments, Security, Logs
  - “Reset to defaults” button
  - load models from `baseUrl`
- Commands and localization
  - `Haratsan` category in the command palette
  - default keybindings: `Ctrl+Alt+G` - open chat; `Ctrl+Alt+/` - comment selection
  - EN/RU: `package.nls` (manifest) and `vscode.l10n` (extension host messages)
- Comment pipeline
  - commands: comment selection; comment entire file (editor context menu)
  - streaming generation with character progress (when the server supports it)
  - few-shot examples by language family (JS/TS, Python, HTML, SQL, Lua, PHP, etc.)
  - optional extra system prompt in Comments settings
  - extract code from model response (including the last markdown block)
  - validate “do not change logic” + preview/diff before apply
  - on validation failure - “Apply anyway” only, no regular Apply
  - stale edit: check `document.version` and selection text before apply
  - diff UX: language highlighting in virtual docs, modal confirmation, clear virtual docs after closing diff
  - comment generation respects file language and strip rules per language
