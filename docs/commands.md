# Commands

[Русская версия](commands-ru.md)

In the command palette they appear as **Haratsan: ...** (`Haratsan` category).

## Default keybindings

| Command           | Win / Linux  | macOS       |
| ----------------- | ------------ | ----------- |
| Open chat         | `Ctrl+Alt+G` | `Cmd+Alt+G` |
| Comment selection | `Ctrl+Alt+/` | `Cmd+Alt+/` |

You can change bindings: **File -> Preferences -> Keyboard Shortcuts** (search `Haratsan`).

Settings open from the Settings button in the chat header (no separate command or keybinding).

## Command list

### Haratsan: Comment selection

Available when there is a selection in the editor (context menu + hotkey).  
Pipeline: prompt -> LLM -> extract -> validate -> diff -> apply.  
See [comments.md](comments.md).

### Haratsan: Comment file

Comments for the entire open file. Editor context menu item (no default hotkey).

## Comment syntax by language

| Family   | Languages (examples)            | Comments                         |
| -------- | ------------------------------- | -------------------------------- |
| ts-style | JS, TS, Java, Go, Rust, C#, CSS | `//` `/* */`                     |
| hash     | Python, Ruby, Shell, YAML       | `#` (+ `=begin`/`=end` for Ruby) |
| html     | HTML, XML, Vue                  | `<!-- -->`                       |
| sql      | SQL                             | `--` `/* */`                     |
| lua      | Lua                             | `--` `--[[ ]]`                   |
| php      | PHP                             | `//` `#` `/* */`                 |

Unknown `languageId` is treated as ts-style.
