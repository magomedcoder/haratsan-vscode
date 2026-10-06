# Code comments

[Русская версия](comments-ru.md)

Commands:

- **Haratsan: Comment selection** - selected fragment (`Ctrl+Alt+/` / `Cmd+Alt+/`)
- **Haratsan: Comment file** - entire open file (context menu)

## Pipeline

1. **Size limit** - fragment must not exceed `maxInputChars` from settings.
2. **Prompt** - system + few-shot for the language family + code; optional extra system prompt from settings.
3. **LLM** - streaming (if the server supports it) with character progress; cancel via Progress notification.
4. **Extract** - code from the response (including the last markdown fenced block).
5. **Validate** - after stripping comments, code must match the original.
6. **Diff** (if preview is on) - virtual docs with language highlighting, modal Apply / Reject.
7. **Stale edit** - before apply, check `document.version` and selection text.
8. **Apply** - `WorkspaceEdit` over the original range.

## Validation

If the model changed more than comments:

- without preview - only **Apply anyway** / **Cancel**;
- with preview - the diff dialog shows **Apply anyway** instead of regular Apply.

## Diff UX

- Virtual documents (`gen-comment:`) are not cleared while the diff tab is open.
- Language highlighting follows `languageId`.
- Confirmation is modal.

## Settings

See **Chat Comments** in [settings.md](settings.md): style, preview, extra prompt.

## Languages

Strip/comment syntax - [commands.md](commands.md#comment-syntax-by-language).
