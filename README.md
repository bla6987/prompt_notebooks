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
- Click a prompt name (or **✎**) to keep its editable text area open in the floating panel.
  Edit while using the rest of SillyTavern; text and settings **save as you type** (there is no Save/Cancel step).
  Closing the panel keeps your changes, and the selected prompt reopens with the panel, including after a reload.
- Expand **Prompt settings** for name, notebook, tags, scope, position, depth, role, frequency,
  World Info scanning, and default activation. Blank numeric fields and **Inherit** selections use the notebook defaults.
  **Use notebook scanning default** restores inherited scanning. Collapse **Prompt library** for more writing space.
- Changing the Scope or Notebook setting to a different effective scope binds to the current chat.
  Other edits preserve the existing binding; **Bind scope to this chat** explicitly rebinds it.
- **⚙** on a notebook edits its name and the defaults its prompts inherit.
- **Drag** a prompt to reorder it, or drop it onto another notebook's header to move it there.

### How prompts combine in the prompt
SillyTavern merges injections by level: prompts at the **same position, depth, and role** are
concatenated (newline-separated) into a **single** block/message, in this list's order (drag to
change it). Different roles at the same depth become separate messages (ordered System → User →
Assistant); different depths inject at their own positions.
- In the editor, **Duplicate** clones a prompt (and reopens on the copy); **Delete prompt** removes it (with confirm).

### Per-chat text override
A prompt's text is shared, but you can override it **for the current chat only**. Select it while in
that chat → tick **"Use a different text in this chat"**. The same text area now edits the replacement;
untick to return to the shared text. Blank override text falls back to the shared text. A `✎ chat` badge
marks stored overrides, which ride into branches through chat metadata. Switching chats refreshes the
editor to that chat's text and override state; stale controls cannot write into another chat.

### `{{notebook:Name}}` macro
Each notebook exposes a macro that expands to the joined text of its currently-**on** (in-scope + active)
prompts, e.g. `{{notebook:Lore}}`. Drop it into your existing Author's Note (or any macro-expanded field) to
pull a whole notebook in. Mark a notebook **Macro-only** (in **⚙**) so its prompts are delivered *only* via the
macro and never auto-injected — this avoids double-insertion when you mix the macro with the panel toggles.
Both the legacy and newer SillyTavern macro engines support this syntax.

### Slash commands
- `/notebooks` (`/pnb`) — toggle the panel
- `/pnb-on <name|id>` · `/pnb-off <name|id>` · `/pnb-toggle <name|id>`

## Storage
- **Library** (notebooks + prompts) → `extension_settings.promptNotebooks` (global, reusable across all chats).
- **Per-chat state** (active toggles, per-chat text overrides, lineage id) → `chat_metadata.promptNotebooks`.
- Pending override edits also keep a small recovery record in extension settings, keyed by character/group
  and exact chat id. This protects edits when a fast chat switch cancels SillyTavern's metadata debounce;
  the record is removed after a metadata reload confirms the saved revision. SillyTavern's chat integrity
  id also prevents recovering into a replacement chat that reuses the filename. Recovery records are not exported.

## Known v0 limitations
- **Renaming a chat** changes its id, so a "This thread" binding to that chat will dangle (use **Bind scope to this chat** to rebind it).
- **Thread + children** set from a mid-tree branch binds to that chat's lineage, which is shared by the whole tree; and branches created *before* a lineage scope is set won't carry the id.
- Group chats are supported, but "This thread" uses the group's chat id.

## Development checks

Run `npm install` and `npm test` for DOM integration tests covering autosave, focus/cursor preservation,
chat switching, scope bindings, injection settings, overrides, and library operations.
