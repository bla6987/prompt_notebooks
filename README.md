# Prompt Notebooks

A customizable, reusable, toggleable Author's Note for SillyTavern.

Instead of one monolithic Author's Note, you keep a **library of named prompts** organized into
**notebooks** (with **tags**), and toggle each one **per chat** from a floating panel. Every prompt
is injected through the same core mechanism the native Author's Note uses
(`setExtensionPrompt`), so it supports **position, depth, and role** exactly like the AN.

## Scopes

Each prompt has a scope that decides *where* it applies:

| Scope | Applies in | Branches? |
|---|---|---|
| 🌐 **Global** | every chat | — |
| 🧵 **This thread** | only the exact current chat | **No** — stays out of branches |
| 🌿 **Thread + children** | this chat and any branch made from it | **Yes** |

"Thread + children" works because SillyTavern copies `chat_metadata` into a branch when it's
created (`saveChat`, `script.js`), so the lineage id this extension stamps rides along into children.

## Install

Copy or symlink this folder into your SillyTavern third-party extensions directory:

```
SillyTavern/data/<user>/extensions/prompt-notebooks
```

(or `public/scripts/extensions/third-party/prompt-notebooks` for an all-users install), then reload
SillyTavern. Open it from the **wand menu → Prompt Notebooks**, or run `/notebooks` (`/pnb`).

## Usage

- **＋** new prompt · **📓** new notebook · **⬇/⬆** export/import the library as JSON.
- Tick a prompt's checkbox to turn it on **for the current chat**. Out-of-scope prompts are dimmed.
- Click a prompt name (or **✎**) to edit text, tags, scope, position, depth, role, and frequency.
  Any field left blank **inherits** the notebook's default.
- **⚙** on a notebook edits its name and the defaults its prompts inherit.
- **Drag** a prompt to reorder it, or drop it onto another notebook's header to move it there.
  Order is meaningful: prompts sharing the same depth/position are concatenated in list order.
- In the editor, **Duplicate** clones a prompt (and reopens on the copy); **Delete prompt** removes it (with confirm).

### Per-chat text override
A prompt's text is shared, but you can override it **for the current chat only**. Open the editor while in
that chat → tick **"Use a different text in this chat"** and type the replacement. A `✎ chat` badge marks
prompts that have an override; the override rides into branches (it lives in chat metadata). Untick to revert.

### `{{notebook:Name}}` macro
Each notebook exposes a macro that expands to the joined text of its currently-**on** (in-scope + active)
prompts, e.g. `{{notebook:Lore}}`. Drop it into your existing Author's Note (or any macro-expanded field) to
pull a whole notebook in. Mark a notebook **Macro-only** (in **⚙**) so its prompts are delivered *only* via the
macro and never auto-injected — this avoids double-insertion when you mix the macro with the panel toggles.

### Slash commands
- `/notebooks` (`/pnb`) — toggle the panel
- `/pnb-on <name|id>` · `/pnb-off <name|id>` · `/pnb-toggle <name|id>`

## Storage
- **Library** (notebooks + prompts) → `extension_settings.promptNotebooks` (global, reusable across all chats).
- **Per-chat state** (active toggles, per-chat text overrides, lineage id) → `chat_metadata.promptNotebooks`.

## Known v0 limitations
- **Renaming a chat** changes its id, so a "This thread" binding to that chat will dangle (re-bind by editing the prompt).
- **Thread + children** set from a mid-tree branch binds to that chat's lineage, which is shared by the whole tree; and branches created *before* a lineage scope is set won't carry the id.
- Group chats are supported, but "This thread" uses the group's chat id.
