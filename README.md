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
  Text updates its injection immediately; text-dependent search results and override badges refresh after a short typing pause.
  Closing the panel keeps your changes, and the selected prompt reopens with the panel, including after a reload.
  Large libraries show 100 prompt rows per page; Previous/Next reaches every match. Searches in libraries
  larger than 100 prompts wait for a short typing pause. Hidden panels and collapsed libraries release their rows.
- Expand **Prompt settings** for name, notebook, tags, scope, position, depth, role, frequency,
  World Info scanning, and default activation. Blank numeric fields and **Inherit** selections use the notebook defaults.
  **Use notebook scanning default** restores inherited scanning. Collapse **Prompt library** for more writing space.
- Changing the Scope or Notebook setting to a different effective scope binds to the current chat.
  Other edits preserve the existing binding; **Bind scope to this chat** explicitly rebinds it.
- **⚙** on a notebook edits its name and the defaults its prompts inherit. World Info scanning is included in these defaults.
- The floating panel stays within the viewport when you reopen it or resize the window.
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
- **Pending override recovery** → an IndexedDB journal scoped to the authenticated SillyTavern account,
  character/group, and exact chat id. Writes coalesce typing and commit one patch at a time. Only after a
  successful transaction is the fallback text removed from extension settings; settings keep compact
  revision numbers instead. Opening a chat reads its journal through a cursor, without loading other
  chats' text into RAM. Generation awaits recovery before applying notebook prompts.
- A fresh metadata reload confirms saved revisions and removes their journal entries. Recovering an
  edit or shallow-copying metadata does not count as confirmation. Chat integrity ids prevent recovery
  into a replacement chat that reuses a filename. New edits win over delayed recovery, and stale reads
  cannot update a different chat after a switch.
- If account identity or IndexedDB is unavailable, or a write fails, unconfirmed text stays in the
  existing settings recovery store. This safety fallback can exceed the normal residency bounds; it
  never drops unsaved edits to meet a RAM target. A failed read of a known disk-only override stops
  generation instead of using older text. Reload after restoring storage access to retry failed writes.
- Recovery is local to this browser and origin. Clearing site data removes this journal; confirmed chat
  metadata and shared prompts remain in SillyTavern's normal server storage. Recovery records are not
  included in library exports.

## Known v0 limitations
- **Renaming a chat** changes its id, so a "This thread" binding to that chat will dangle (use **Bind scope to this chat** to rebind it).
- **Thread + children** set from a mid-tree branch binds to that chat's lineage, which is shared by the whole tree; and branches created *before* a lineage scope is set won't carry the id.
- Group chats are supported, but "This thread" uses the group's chat id.

## Development checks

Run `npm install` and `npm test` for DOM integration tests covering autosave, focus/cursor preservation,
chat switching, scope bindings, injection settings, overrides, and library operations.
