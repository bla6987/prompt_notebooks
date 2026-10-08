/**
 * Prompt Notebooks — a customizable, reusable, toggleable Author's Note for SillyTavern.
 *
 * Each "prompt" is injected through the SAME core primitive the native Author's Note uses
 * (context.setExtensionPrompt -> extension_prompts), so it supports position / depth / role
 * exactly like the AN. Prompts live in a global library (extension_settings) organized into
 * notebooks + tags, and are toggled per-chat. A prompt's SCOPE decides where it applies:
 *
 *   - global           -> every chat
 *   - thread           -> only the exact current chat (does NOT propagate to branches)
 *   - thread+children  -> this chat and any branch made from it (rides chat_metadata.lineageId,
 *                         which SillyTavern copies into branches on saveChat)
 *
 * No imports: we use the stable global accessor `SillyTavern.getContext()`.
 */
(function () {
    'use strict';

    const NS = 'promptNotebooks';            // extension_settings + chat_metadata namespace
    const KEY_PREFIX = 'pnb_';               // setExtensionPrompt key prefix
    const INTERCEPTOR = 'promptNotebooksInterceptor';

    // Mirror of SillyTavern's enums (public/script.js)
    const POSITION = { AFTER_SCENARIO: 0, IN_CHAT: 1, BEFORE_SCENARIO: 2 };
    const ROLE = { SYSTEM: 0, USER: 1, ASSISTANT: 2 };
    const SCOPE = { GLOBAL: 'global', THREAD: 'thread', LINEAGE: 'lineage' };

    const POSITION_LABELS = { 0: 'After scenario', 1: 'In-chat @ depth', 2: 'Before scenario' };
    const ROLE_LABELS = { 0: 'System', 1: 'User', 2: 'Assistant' };
    const SCOPE_LABELS = { global: 'Global', thread: 'This thread', lineage: 'Thread + children' };
    const SCOPE_ICON = { global: '🌐', thread: '🧵', lineage: '🌿' };

    const NOTEBOOK_DEFAULTS = () => ({
        scope: SCOPE.GLOBAL,
        position: POSITION.IN_CHAT,
        depth: 4,
        role: ROLE.SYSTEM,
        scan: false,
        interval: 1,
    });

    let initialized = false;
    const hydratedNamespaces = new WeakSet();
    let overrideRevision = 0;
    let $panel = null;
    let editor = null;                       // selected prompt + the chat its controls belong to
    let dragId = null;                         // prompt id currently being drag-reordered
    let appliedKeys = new Set();               // extension_prompt keys we set last apply (for cleanup)

    const getCtx = () => globalThis.SillyTavern?.getContext?.();
    const uuid = () => (getCtx()?.uuidv4?.() ?? ('id-' + Math.abs(hashStr(String(performance.now()) + Object.keys({}).length)).toString(36)));
    function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; } return h; }
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    // ──────────────────────────────────────────────────────────── settings store

    function getSettings() {
        const ctx = getCtx();
        const all = ctx.extensionSettings;
        if (!all[NS]) {
            all[NS] = {
                version: 1,
                notebooks: [{ id: uuid(), name: 'General', defaults: NOTEBOOK_DEFAULTS(), collapsed: false }],
                prompts: [],
                panel: { x: 80, y: 80, w: 340, h: 460, open: false, search: '', tagFilter: [] },
            };
        }
        const s = all[NS];
        s.notebooks ??= [];
        s.prompts ??= [];
        s.panel ??= { x: 80, y: 80, w: 340, h: 460, open: false, search: '', tagFilter: [] };
        if (!s.notebooks.length) s.notebooks.push({ id: uuid(), name: 'General', defaults: NOTEBOOK_DEFAULTS(), collapsed: false });
        for (const nb of s.notebooks) { nb.defaults = Object.assign(NOTEBOOK_DEFAULTS(), nb.defaults || {}); nb.macroOnly ??= false; }
        return s;
    }
    const saveSettings = () => getCtx().saveSettingsDebounced();

    function getNotebook(id) { return getSettings().notebooks.find(n => n.id === id); }
    function notebookOf(prompt) { return getNotebook(prompt.notebookId) || getSettings().notebooks[0]; }

    /** Effective value of a field: prompt override (non-null) else notebook default. */
    function eff(prompt, field) {
        const v = prompt[field];
        if (v !== null && v !== undefined) return v;
        return notebookOf(prompt).defaults[field];
    }

    // ──────────────────────────────────────────────────────── per-chat metadata

    /** The chat_metadata namespace for the current chat. Mints a lineageId so branches inherit it. */
    function chatMeta() {
        const ctx = getCtx();
        const meta = ctx.chatMetadata;
        if (!meta) return null;
        if (!meta[NS]) meta[NS] = {};
        const m = meta[NS];
        m.active ??= {};
        m.overrides ??= {};
        m.overrideRevisions ??= {};
        // Native metadata saves are debounced and can be cancelled by a fast chat switch.
        // Recover only this chat's pending edits, then retire them once a reload confirms the revision.
        // updateChatMetadata shallow-copies the outer object without loading from disk.
        // Only a fresh namespace can confirm a persisted revision.
        if (!hydratedNamespaces.has(m)) {
            hydratedNamespaces.add(m);
            const s = getSettings();
            const key = overrideChatKey(ctx);
            const pending = key ? s.pendingOverrides?.[key] : null;
            if (pending) {
                let recovered = false;
                for (const [id, patch] of Object.entries(pending)) {
                    const replacedChat = patch.integrity && meta.integrity && patch.integrity !== meta.integrity;
                    if (replacedChat || !s.prompts.some(p => p.id === id) || (m.overrideRevisions[id] ?? 0) >= patch.revision) {
                        delete pending[id];
                    } else {
                        if (patch.text) m.overrides[id] = { text: patch.text }; else delete m.overrides[id];
                        m.overrideRevisions[id] = patch.revision;
                        recovered = true;
                    }
                }
                if (!Object.keys(pending).length) delete s.pendingOverrides[key];
                saveSettings();
                if (recovered) ctx.saveMetadataDebounced();
            }
        }
        if (!m.lineageId) {
            m.lineageId = uuid();
            ctx.saveMetadataDebounced();
        }
        return m;
    }

    function overrideChatKey(ctx = getCtx()) {
        const chatId = ctx.getCurrentChatId?.();
        if (!chatId) return null;
        const owner = ctx.groupId != null ? ['group', ctx.groupId]
            : ['character', ctx.characters?.[ctx.characterId]?.avatar ?? ctx.characterId];
        return JSON.stringify([...owner, chatId]);
    }

    function scopeContext() {
        const ctx = getCtx();
        const chatId = ctx.getCurrentChatId?.();
        const m = chatId ? chatMeta() : null;
        return { chatId: chatId ?? null, lineageId: m?.lineageId ?? null, active: m?.active ?? {}, overrides: m?.overrides ?? {} };
    }

    // ──────────────────────────────────────────────────────── scope resolution

    function effScope(prompt) { return eff(prompt, 'scope') || SCOPE.GLOBAL; }

    function isVisible(prompt, sc) {
        const scope = effScope(prompt);
        if (scope === SCOPE.GLOBAL) return true;
        if (!sc.chatId) return false;
        if (scope === SCOPE.THREAD) return prompt.scopeRef === sc.chatId;
        if (scope === SCOPE.LINEAGE) return prompt.scopeRef === sc.lineageId;
        return false;
    }

    /** Is the prompt ON in this chat? Per-chat override falls back to the prompt's default. */
    function isActive(prompt, sc) {
        const ov = sc.active[prompt.id];
        return ov === undefined ? (prompt.enabledByDefault !== false) : !!ov;
    }

    /** Effective injected text in this chat: per-chat override falls back to the prompt's own text. */
    function effText(prompt, sc) {
        return sc.overrides?.[prompt.id]?.text ?? prompt.text ?? '';
    }

    // ─────────────────────────────────────────────────────────── injection apply

    // Key encodes the prompt's list index (zero-padded) so the core's Object.keys().sort() in
    // getExtensionPrompt merges same-level prompts in YOUR drag order, not by random uuid.
    function promptKey(p, idx) { return KEY_PREFIX + String(idx).padStart(5, '0') + '_' + p.id; }

    function intervalFilter(interval) {
        const n = Number(interval) || 1;
        if (n <= 1) return null;
        return () => {
            const chat = getCtx().chat || [];
            const userCount = chat.filter(m => m && m.is_user).length;
            return userCount > 0 && (userCount % n === 0);
        };
    }

    /** Re-evaluate every prompt and push it into the core extension_prompts registry (in list order). */
    function applyInjections() {
        const ctx = getCtx();
        if (!ctx?.setExtensionPrompt) return;
        const s = getSettings();
        const sc = scopeContext();
        // Drop the keys we set last time — indices/text may have changed, so re-key cleanly.
        for (const k of appliedKeys) { try { delete ctx.extensionPrompts[k]; } catch { /* noop */ } }
        appliedKeys = new Set();
        s.prompts.forEach((p, idx) => {
            const text = effText(p, sc);
            // macroOnly notebooks are delivered via {{notebook:Name}}, never auto-injected
            const on = !notebookOf(p).macroOnly && isVisible(p, sc) && isActive(p, sc) && String(text).length > 0;
            if (!on) return;
            const key = promptKey(p, idx);
            ctx.setExtensionPrompt(
                key,
                String(text),
                Number(eff(p, 'position')),
                Number(eff(p, 'depth')),
                !!eff(p, 'scan'),
                Number(eff(p, 'role')),
                intervalFilter(eff(p, 'interval')),
            );
            appliedKeys.add(key);
        });
    }

    function clearPromptKey(id) {
        const all = getCtx()?.extensionPrompts || {};
        for (const k of Object.keys(all)) {
            if (k.startsWith(KEY_PREFIX) && k.endsWith('_' + id)) {
                try { delete all[k]; } catch { /* noop */ }
                appliedKeys.delete(k);
            }
        }
    }

    // ────────────────────────────────────────────────────────────── prompt CRUD

    function addNotebook(name) {
        const s = getSettings();
        const nb = { id: uuid(), name: name || 'Notebook', defaults: NOTEBOOK_DEFAULTS(), collapsed: false, macroOnly: false };
        s.notebooks.push(nb); saveSettings(); refreshMacros(); return nb;
    }
    function deleteNotebook(id) {
        const s = getSettings();
        if (s.notebooks.length <= 1) { toast('Keep at least one notebook.', 'warning'); return; }
        for (const p of s.prompts.filter(p => p.notebookId === id)) deletePrompt(p.id);
        s.notebooks = s.notebooks.filter(n => n.id !== id);
        saveSettings(); refreshMacros(); applyInjections();
    }

    function newPrompt(notebookId) {
        return {
            id: uuid(),
            notebookId: notebookId || getSettings().notebooks[0].id,
            name: 'New prompt',
            text: '',
            tags: [],
            // null => inherit from notebook defaults
            scope: null, scopeRef: null,
            position: null, depth: null, role: null, scan: null, interval: null,
            enabledByDefault: true,
        };
    }
    function upsertPrompt(p) {
        const s = getSettings();
        const i = s.prompts.findIndex(x => x.id === p.id);
        if (i >= 0) s.prompts[i] = p; else s.prompts.push(p);
        saveSettings(); applyInjections();
    }
    function deletePrompt(id) {
        const s = getSettings();
        s.prompts = s.prompts.filter(p => p.id !== id);
        clearPromptKey(id);
        for (const [key, patches] of Object.entries(s.pendingOverrides || {})) {
            delete patches[id];
            if (!Object.keys(patches).length) delete s.pendingOverrides[key];
        }
        const sc = scopeContext(); delete sc.active[id]; delete sc.overrides[id];
        if (sc.chatId) getCtx().saveMetadataDebounced();
        saveSettings(); applyInjections();
    }

    function toggleActive(promptId, value) {
        const m = chatMeta();
        if (!m) { toast('Open a chat first.', 'info'); return; }
        m.active[promptId] = value;
        getCtx().saveMetadataDebounced();
        applyInjections();
    }

    /** Set (or clear, with empty text) a per-chat text override for a prompt. */
    function setOverride(promptId, text) {
        const m = chatMeta();
        if (!m) { toast('Open a chat first.', 'info'); return; }
        m.overrides ??= {};
        if (text && text.length) m.overrides[promptId] = { text }; else delete m.overrides[promptId];
        const key = overrideChatKey();
        if (key) {
            // Store a small recovery patch rather than saving snapshots of whole chats.
            const revision = overrideRevision = Math.max(Date.now(), overrideRevision + 1, (m.overrideRevisions[promptId] ?? 0) + 1);
            m.overrideRevisions[promptId] = revision;
            const s = getSettings();
            s.pendingOverrides ??= {};
            (s.pendingOverrides[key] ??= {})[promptId] = { text: text || '', revision, integrity: getCtx().chatMetadata.integrity ?? null };
            saveSettings();
        }
        getCtx().saveMetadataDebounced();
        applyInjections();
    }

    /** Reorder a prompt before/after a target (adopting the target's notebook). */
    function movePrompt(id, targetId, after) {
        if (id === targetId) return;
        const s = getSettings();
        const from = s.prompts.findIndex(p => p.id === id);
        if (from < 0) return;
        const [moved] = s.prompts.splice(from, 1);
        let to = s.prompts.findIndex(p => p.id === targetId);
        if (to < 0) { s.prompts.push(moved); }
        else { moved.notebookId = s.prompts[to].notebookId; if (after) to += 1; s.prompts.splice(to, 0, moved); }
        saveSettings(); applyInjections(); render();
    }

    /** Move a prompt into another notebook (appended after that notebook's last prompt). */
    function moveToNotebook(id, notebookId) {
        const s = getSettings();
        const from = s.prompts.findIndex(p => p.id === id);
        if (from < 0 || s.prompts[from].notebookId === notebookId) return;
        const [moved] = s.prompts.splice(from, 1);
        moved.notebookId = notebookId;
        let lastIdx = -1;
        s.prompts.forEach((p, i) => { if (p.notebookId === notebookId) lastIdx = i; });
        s.prompts.splice(lastIdx + 1, 0, moved);
        saveSettings(); applyInjections(); render();
    }

    // ─────────────────────────────────────────── notebook macros: {{notebook:Name}}

    const macroKeys = new Set();
    let modernMacroRegistered = false;

    /** Joined text of the currently ON (in-scope + active) prompts in a notebook, with overrides. */
    function notebookText(name) {
        const s = getSettings();
        const nb = s.notebooks.find(n => n.name === name);
        if (!nb) return '';
        const sc = scopeContext();
        return s.prompts
            .filter(p => p.notebookId === nb.id && isVisible(p, sc) && isActive(p, sc))
            .map(p => effText(p, sc))
            .filter(t => t && t.length)
            .join('\n');
    }

    /** Keep one {{notebook:<Name>}} macro registered per notebook (diffed to limit churn). */
    function refreshMacros() {
        const ctx = getCtx();
        if (!ctx?.registerMacro) return;
        if (ctx.macros?.register && ctx.powerUserSettings?.experimental_macro_engine) {
            for (const k of macroKeys) { ctx.unregisterMacro(k); }
            macroKeys.clear();
            if (!modernMacroRegistered) {
                const registered = ctx.macros.register('notebook', {
                    description: 'Joined active Prompt Notebooks text for the named notebook.',
                    unnamedArgs: [{ name: 'name', type: 'string', description: 'Notebook name' }],
                    handler: ({ unnamedArgs: [name] }) => notebookText(name),
                });
                modernMacroRegistered = !!registered;
            }
            return;
        }
        if (modernMacroRegistered) {
            ctx.macros?.registry?.unregisterMacro('notebook');
            modernMacroRegistered = false;
        }
        const want = new Map();
        for (const nb of getSettings().notebooks) want.set('notebook:' + nb.name, nb.name);
        for (const k of [...macroKeys]) if (!want.has(k)) { try { ctx.unregisterMacro(k); } catch { /* noop */ } macroKeys.delete(k); }
        for (const [k, name] of want) if (!macroKeys.has(k)) {
            try { ctx.registerMacro(k, () => notebookText(name), 'Prompt Notebooks: ' + name); macroKeys.add(k); } catch { /* noop */ }
        }
    }

    /** Bind a prompt's effective scope to the current chat (sets scopeRef when needed). */
    function resolveScopeRef(prompt) {
        const scope = effScope(prompt);
        if (scope === SCOPE.GLOBAL) { prompt.scopeRef = null; return true; }
        const ctx = getCtx();
        const chatId = ctx.getCurrentChatId?.();
        if (!chatId) { toast('Open the chat you want to bind this prompt to.', 'warning'); return false; }
        prompt.scopeRef = scope === SCOPE.LINEAGE ? chatMeta().lineageId : chatId;
        return true;
    }

    function toast(msg, type = 'info') {
        try { globalThis.toastr?.[type]?.(msg, 'Prompt Notebooks'); } catch { console.log('[PromptNotebooks]', msg); }
    }

    // ─────────────────────────────────────────────────────────────── import/export

    function exportLibrary() {
        const s = getSettings();
        const data = JSON.stringify({ notebooks: s.notebooks, prompts: s.prompts }, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'prompt-notebooks.json';
        a.click();
        URL.revokeObjectURL(a.href);
    }
    function importLibrary(file) {
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const data = JSON.parse(String(reader.result));
                const s = getSettings();
                if (Array.isArray(data.notebooks)) {
                    for (const nb of data.notebooks) {
                        nb.id ??= uuid(); nb.defaults = Object.assign(NOTEBOOK_DEFAULTS(), nb.defaults || {});
                        if (!s.notebooks.find(n => n.id === nb.id)) s.notebooks.push(nb);
                    }
                }
                if (Array.isArray(data.prompts)) {
                    for (const p of data.prompts) {
                        p.id ??= uuid();
                        if (!s.notebooks.find(n => n.id === p.notebookId)) p.notebookId = s.notebooks[0].id;
                        if (!s.prompts.find(x => x.id === p.id)) s.prompts.push(p);
                    }
                }
                saveSettings(); refreshMacros(); applyInjections(); render();
                toast('Library imported.', 'success');
            } catch (e) { toast('Import failed: ' + e.message, 'error'); }
        };
        reader.readAsText(file);
    }

    // ──────────────────────────────────────────────────────────────────── UI: panel

    function buildPanel() {
        const s = getSettings();
        $panel = document.createElement('div');
        $panel.id = 'pnb-panel';
        $panel.className = 'pnb-panel';
        $panel.style.left = s.panel.x + 'px';
        $panel.style.top = s.panel.y + 'px';
        $panel.style.width = s.panel.w + 'px';
        $panel.style.height = s.panel.h + 'px';
        $panel.style.display = s.panel.open ? 'flex' : 'none';
        $panel.innerHTML = `
            <div class="pnb-header" data-drag>
                <span class="pnb-grip">⠿</span>
                <span class="pnb-title">Prompt Notebooks</span>
                <span class="pnb-spacer"></span>
                <span class="pnb-btn" data-act="add-prompt" title="New prompt">＋</span>
                <span class="pnb-btn" data-act="add-notebook" title="New notebook">📓</span>
                <span class="pnb-btn" data-act="export" title="Export">⬇</span>
                <span class="pnb-btn" data-act="import" title="Import">⬆</span>
                <span class="pnb-btn" data-act="close" title="Close">✕</span>
            </div>
            <input class="pnb-search text_pole" placeholder="Search prompts…" />
            <div class="pnb-tags"></div>
            <div class="pnb-editor-host"></div>
            <details class="pnb-library" open><summary>Prompt library</summary><div class="pnb-list"></div></details>
            <div class="pnb-resize" data-resize></div>
            <input type="file" class="pnb-file" accept="application/json" hidden />
        `;
        document.body.appendChild($panel);

        $panel.querySelector('.pnb-search').value = s.panel.search || '';
        wirePanelEvents();
        render();
    }

    function wirePanelEvents() {
        const s = getSettings();

        $panel.addEventListener('click', (e) => {
            const act = e.target.closest('[data-act]')?.dataset.act;
            if (!act) return;
            if (act === 'close') return togglePanel(false);
            if (act === 'add-notebook') return promptNotebookName();
            if (act === 'export') return exportLibrary();
            if (act === 'import') return $panel.querySelector('.pnb-file').click();
            if (act === 'add-prompt') return openEditor(newPrompt());
        });

        $panel.querySelector('.pnb-file').addEventListener('change', (e) => {
            if (e.target.files?.[0]) importLibrary(e.target.files[0]);
            e.target.value = '';
        });

        const search = $panel.querySelector('.pnb-search');
        search.addEventListener('input', () => { s.panel.search = search.value; saveSettings(); render(); });

        // list interactions (delegated)
        const list = $panel.querySelector('.pnb-list');
        list.addEventListener('click', onListClick);
        list.addEventListener('change', onListChange);
        list.addEventListener('dragstart', onDragStart);
        list.addEventListener('dragover', onDragOver);
        list.addEventListener('drop', onDrop);
        list.addEventListener('dragend', onDragEnd);
        $panel.querySelector('.pnb-tags').addEventListener('click', onTagFilterClick);

        makeDraggable();
        makeResizable();
    }

    function onListChange(e) {
        const cb = e.target.closest('input.pnb-toggle');
        if (cb) toggleActive(cb.dataset.id, cb.checked);
    }
    function onListClick(e) {
        const nbEdit = e.target.closest('[data-nb-edit]');
        if (nbEdit) { openNotebookEditor(getNotebook(nbEdit.dataset.nbEdit)); return; }
        const head = e.target.closest('.pnb-nb-head');
        if (head) {
            const nb = getNotebook(head.dataset.id);
            nb.collapsed = !nb.collapsed; saveSettings(); render(); return;
        }
        const editBtn = e.target.closest('[data-edit]');
        if (editBtn) {
            const p = getSettings().prompts.find(x => x.id === editBtn.dataset.edit);
            if (p) openEditor(structuredClone(p)); return;
        }
    }
    function onTagFilterClick(e) {
        const t = e.target.closest('[data-tag]')?.dataset.tag;
        if (!t) return;
        const s = getSettings();
        const i = s.panel.tagFilter.indexOf(t);
        if (i >= 0) s.panel.tagFilter.splice(i, 1); else s.panel.tagFilter.push(t);
        saveSettings(); render();
    }

    // ───────────────────────────────────────────────── drag-to-reorder handlers

    function clearDragMarks() {
        $panel?.querySelectorAll('.pnb-drop-before, .pnb-drop-after, .pnb-drop-into')
            .forEach(el => el.classList.remove('pnb-drop-before', 'pnb-drop-after', 'pnb-drop-into'));
    }
    function onDragStart(e) {
        const row = e.target.closest('.pnb-prompt');
        if (!row) return;
        dragId = row.dataset.id;
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', dragId); } catch { /* noop */ }
        row.classList.add('pnb-dragging');
    }
    function onDragOver(e) {
        if (!dragId) return;
        const row = e.target.closest('.pnb-prompt');
        const head = e.target.closest('.pnb-nb-head');
        if (!row && !head) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        clearDragMarks();
        if (row) {
            const after = e.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2;
            row.classList.add(after ? 'pnb-drop-after' : 'pnb-drop-before');
        } else {
            head.classList.add('pnb-drop-into');
        }
    }
    function onDrop(e) {
        if (!dragId) return;
        e.preventDefault();
        const id = dragId;   // capture: onDragEnd nulls dragId before the deferred move runs
        const row = e.target.closest('.pnb-prompt');
        const head = e.target.closest('.pnb-nb-head');
        clearDragMarks();
        // Defer the reorder + re-render: mutating the list during 'drop' destroys the drag
        // source, so 'dragend' never fires and the browser stays stuck in drag mode (freeze).
        // setTimeout(0) runs after both drop and dragend have completed.
        if (row && row.dataset.id !== id) {
            const after = e.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2;
            const targetId = row.dataset.id;
            setTimeout(() => movePrompt(id, targetId, after), 0);
        } else if (head) {
            const notebookId = head.dataset.id;
            setTimeout(() => moveToNotebook(id, notebookId), 0);
        }
    }
    function onDragEnd() {
        dragId = null;
        clearDragMarks();
        $panel?.querySelectorAll('.pnb-dragging').forEach(el => el.classList.remove('pnb-dragging'));
    }

    function allTags() {
        const set = new Set();
        for (const p of getSettings().prompts) (p.tags || []).forEach(t => set.add(t));
        return [...set].sort();
    }

    function matchesFilter(p, s, sc) {
        const q = (s.panel.search || '').toLowerCase().trim();
        if (q) {
            const hay = (p.name + ' ' + p.text + ' ' + (p.tags || []).join(' ')).toLowerCase();
            if (!hay.includes(q)) return false;
        }
        if (s.panel.tagFilter.length) {
            if (!s.panel.tagFilter.every(t => (p.tags || []).includes(t))) return false;
        }
        return true;
    }

    function render() {
        if (!$panel) return;
        const s = getSettings();
        const sc = scopeContext();

        // tag filter row
        const tags = allTags();
        $panel.querySelector('.pnb-tags').innerHTML = tags.length
            ? tags.map(t => `<span class="pnb-tag ${s.panel.tagFilter.includes(t) ? 'active' : ''}" data-tag="${esc(t)}">#${esc(t)}</span>`).join('')
            : '';

        const list = $panel.querySelector('.pnb-list');
        let html = '';
        for (const nb of s.notebooks) {
            const prompts = s.prompts.filter(p => p.notebookId === nb.id && matchesFilter(p, s, sc));
            html += `<div class="pnb-nb">
                <div class="pnb-nb-head" data-id="${nb.id}">
                    <span class="pnb-caret">${nb.collapsed ? '▸' : '▾'}</span>
                    <span class="pnb-nb-name">${esc(nb.name)}${nb.macroOnly ? ' <span class="pnb-chip" title="Macro-only — delivered via the {{notebook:Name}} macro">macro</span>' : ''}</span>
                    <span class="pnb-nb-count">${prompts.length}</span>
                    <span class="pnb-btn small" data-nb-edit="${nb.id}" title="Notebook settings">⚙</span>
                </div>`;
            if (!nb.collapsed) {
                if (!prompts.length) html += `<div class="pnb-empty">No prompts</div>`;
                for (const p of prompts) {
                    const visible = isVisible(p, sc);
                    const on = visible && isActive(p, sc);
                    const scope = effScope(p);
                    const hasOv = !!sc.overrides?.[p.id];
                    html += `<div class="pnb-prompt ${visible ? '' : 'out-of-scope'}" draggable="true" data-id="${p.id}" title="${visible ? 'Drag to reorder' : 'Not in scope for this chat'}">
                        <label class="pnb-check">
                            <input type="checkbox" class="pnb-toggle" data-id="${p.id}" ${on ? 'checked' : ''} ${visible ? '' : 'disabled'} />
                        </label>
                        <span class="pnb-pname" data-edit="${p.id}">${esc(p.name)}${hasOv ? ' <span class="pnb-chip ov" title="Custom text in this chat">✎ chat</span>' : ''}</span>
                        <span class="pnb-chips">
                            <span class="pnb-chip" title="Scope">${SCOPE_ICON[scope]} ${esc(SCOPE_LABELS[scope])}</span>
                            <span class="pnb-chip">d${esc(eff(p, 'depth'))}</span>
                            <span class="pnb-chip">${esc(ROLE_LABELS[eff(p, 'role')])}</span>
                        </span>
                        <span class="pnb-btn small" data-edit="${p.id}" title="Edit">✎</span>
                    </div>`;
                }
            }
            html += `</div>`;
        }
        list.innerHTML = html;
        syncEditor();
    }

    async function promptNotebookName() {
        const ctx = getCtx();
        const name = await ctx.Popup.show.input('New notebook', 'Notebook name:');
        if (name) { addNotebook(name); render(); }
    }

    // ─────────────────────────────────────────────────────────────── editor popups

    function field(label, inner) { return `<div class="pnb-field"><label>${label}</label>${inner}</div>`; }
    function selectFor(map, value) {
        return Object.entries(map).map(([v, l]) => `<option value="${v}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`).join('');
    }
    const INHERIT = '__inherit__';
    function inheritSelect(map, value, defLabel) {
        const opts = `<option value="${INHERIT}" ${value === null || value === undefined ? 'selected' : ''}>Inherit (${esc(defLabel)})</option>`
            + Object.entries(map).map(([v, l]) => `<option value="${v}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`).join('');
        return opts;
    }

    function editorContext() {
        const ctx = getCtx();
        return { chatId: ctx.getCurrentChatId?.() ?? null, metadata: ctx.chatMetadata,
            namespace: ctx.chatMetadata?.[NS], characterId: ctx.characterId, groupId: ctx.groupId };
    }

    function sameEditorChat(binding) {
        const now = editorContext();
        const sameMetadata = binding.metadata === now.metadata
            || (binding.namespace && binding.namespace === now.namespace);
        return binding.chatId === now.chatId && sameMetadata
            && binding.characterId === now.characterId && binding.groupId === now.groupId;
    }

    function openEditor(p) {
        if (!getSettings().prompts.some(x => x.id === p.id)) {
            if (!resolveScopeRef(p)) return;
            upsertPrompt(p);
        }
        getSettings().panel.selectedPromptId = p.id;
        editor = null;
        togglePanel(true);
        $panel.querySelector('[data-f="text"]')?.focus();
    }

    // The editor is separate from the library: list refreshes never replace its controls.
    function syncEditor() {
        const host = $panel.querySelector('.pnb-editor-host');
        const s = getSettings();
        const p = s.prompts.find(x => x.id === s.panel.selectedPromptId);
        if (!p) {
            editor = null;
            host.innerHTML = '<div class="pnb-editor-empty">Select a prompt or press ＋ to write one.</div>';
            return;
        }
        if (!editor || editor.id !== p.id || !sameEditorChat(editor)) {
            const sc = scopeContext();
            editor = { id: p.id, ...editorContext(), overrideEnabled: !!sc.overrides[p.id] };
            buildEditor(host, p);
        }
        updateEditor(p);
    }

    function buildEditor(host, p) {
        const d = notebookOf(p).defaults;
        host.innerHTML = `<div class="pnb-editor pnb-inline-editor">
            <div class="pnb-editor-heading"><strong data-editor-title></strong><span class="pnb-autosave">Saves as you type</span></div>
            <label class="pnb-inline"><input type="checkbox" data-f="ovEnabled" /> Use a different text in this chat</label>
            ${field('Prompt text', '<textarea aria-label="Prompt text" class="text_pole" data-f="text" rows="6"></textarea>')}
            <div class="pnb-scopehint" data-text-hint></div>
            <details class="pnb-prompt-settings"><summary>Prompt settings</summary>
                ${field('Name', '<input aria-label="Prompt name" class="text_pole" data-f="name" />')}
                ${field('Notebook', '<select aria-label="Notebook" data-f="notebookId"></select>')}
                ${field('Tags (comma-separated)', '<input class="text_pole" data-f="tags" />')}
                <div class="pnb-row">
                    ${field('Scope', `<select data-f="scope">${inheritSelect(SCOPE_LABELS, p.scope, SCOPE_LABELS[d.scope])}</select>`)}
                    ${field('Position', `<select data-f="position">${inheritSelect(POSITION_LABELS, p.position, POSITION_LABELS[d.position])}</select>`)}
                </div>
                <div class="pnb-row">
                    ${field('Depth', '<input type="number" min="0" step="1" class="text_pole" data-f="depth" />')}
                    ${field('Role', `<select data-f="role">${inheritSelect(ROLE_LABELS, p.role, ROLE_LABELS[d.role])}</select>`)}
                    ${field('Frequency', '<input type="number" min="1" step="1" class="text_pole" data-f="interval" />')}
                </div>
                <label class="pnb-inline"><input type="checkbox" data-f="scan" /> <span data-scan-label>Allow World Info scanning</span></label>
                <button type="button" class="menu_button" data-f="inheritScan">Use notebook scanning default</button>
                <label class="pnb-inline"><input type="checkbox" data-f="enabledByDefault" /> Enabled by default in scoped chats</label>
                <div class="pnb-scopehint" data-scope-hint></div>
                <button type="button" class="menu_button" data-f="rebind">Bind scope to this chat</button>
                <div class="pnb-actions"><button type="button" class="menu_button" data-f="duplicate">Duplicate</button><button type="button" class="menu_button" data-f="delete">Delete prompt</button></div>
            </details>
        </div>`;
        const binding = editor;
        host.addEventListener('input', onEditorInput);
        host.addEventListener('change', onEditorInput);
        host.addEventListener('focusout', onEditorBlur);
        // Assigning onclick avoids accumulating handlers as different prompts are selected.
        host.onclick = async (e) => {
            const action = e.target.closest('button[data-f]')?.dataset.f;
            if (!action || editor !== binding || !sameEditorChat(binding)) return;
            const src = getSettings().prompts.find(x => x.id === binding.id);
            if (!src) return;
            if (action === 'duplicate') {
                const copy = structuredClone(src);
                copy.id = uuid(); copy.name += ' (copy)';
                upsertPrompt(copy); openEditor(copy);
            } else if (action === 'delete') {
                if (await getCtx().Popup.show.confirm('Delete prompt', `Delete "${esc(src.name)}"?`)) {
                    deletePrompt(src.id); render();
                }
            } else if (action === 'rebind') {
                if (resolveScopeRef(src)) { upsertPrompt(src); render(); }
            } else if (action === 'inheritScan') {
                src.scan = null; upsertPrompt(src); render();
            }
        };
    }

    function updateEditor(p) {
        const el = $panel.querySelector('.pnb-editor-host');
        const get = f => el.querySelector(`[data-f="${f}"]`);
        const d = notebookOf(p).defaults;
        const set = (f, value) => { const control = get(f); if (document.activeElement !== control) control.value = value; };
        el.querySelector('[data-editor-title]').textContent = p.name || 'Untitled';
        const notebook = get('notebookId');
        const options = getSettings().notebooks.map(n => `<option value="${esc(n.id)}">${esc(n.name)}</option>`).join('');
        if (notebook.innerHTML !== options) notebook.innerHTML = options;
        set('notebookId', p.notebookId);
        set('name', p.name);
        set('tags', (p.tags || []).join(', '));
        for (const f of ['scope', 'position', 'role']) {
            const labels = { scope: SCOPE_LABELS, position: POSITION_LABELS, role: ROLE_LABELS }[f];
            get(f).querySelector('option').textContent = `Inherit (${labels[d[f]]})`;
            set(f, p[f] ?? INHERIT);
        }
        for (const f of ['depth', 'interval']) { set(f, p[f] ?? ''); get(f).placeholder = d[f]; }
        get('enabledByDefault').checked = p.enabledByDefault !== false;
        get('scan').checked = !!eff(p, 'scan');
        el.querySelector('[data-scan-label]').textContent = `Allow World Info scanning${p.scan == null ? ' (inherited)' : ''}`;
        const ov = get('ovEnabled');
        ov.disabled = !editor.chatId;
        ov.checked = editor.overrideEnabled;
        set('text', editor.overrideEnabled ? (scopeContext().overrides[p.id]?.text ?? p.text ?? '') : (p.text ?? ''));
        el.querySelector('[data-text-hint]').textContent = editor.overrideEnabled
            ? 'Text for this chat only. Blank uses the shared text.' : 'Shared text — used wherever this prompt applies.';
        el.querySelector('[data-text-hint]').title = editor.overrideEnabled ? editor.chatId : '';
        el.querySelector('[data-scope-hint]').textContent = effScope(p) === SCOPE.GLOBAL ? 'Applies to every chat.'
            : `Bound to ${effScope(p) === SCOPE.THREAD ? 'thread' : 'lineage'}: ${p.scopeRef || '(unbound)'}. Text edits keep this binding.`;
        get('rebind').hidden = effScope(p) === SCOPE.GLOBAL;
    }

    function onEditorBlur(e) {
        if (!editor || !sameEditorChat(editor)) return;
        // Flush the native debounce when leaving chat-specific text (e.g. to switch chats).
        if (e.target.dataset.f === 'text' && editor.overrideEnabled) {
            Promise.resolve(getCtx().saveMetadata?.()).catch(error => console.error('[Prompt Notebooks] metadata save', error));
        }
        if (e.target.dataset.f === 'name') {
            const prompt = getSettings().prompts.find(x => x.id === editor.id);
            if (prompt) { prompt.name = prompt.name.trim() || 'Untitled'; saveSettings(); render(); }
        }
    }

    function onEditorInput(e) {
        const f = e.target.dataset.f;
        if (!f || !editor) return;
        // A chat can change before CHAT_CHANGED is emitted. Reject stale controls even in that gap.
        if (!sameEditorChat(editor)) { editor = null; render(); return; }
        const p = getSettings().prompts.find(x => x.id === editor.id);
        if (!p) return;
        const control = e.target;
        if (f === 'ovEnabled') {
            editor.overrideEnabled = control.checked;
            if (control.checked) setOverride(p.id, p.text || ''); else setOverride(p.id, '');
            render(); return;
        }
        if (f === 'text' && editor.overrideEnabled) {
            setOverride(p.id, control.value); render(); return;
        }
        const previousScope = effScope(p);
        const next = { ...p };
        if (f === 'text' || f === 'name') next[f] = control.value;
        else if (f === 'tags') next.tags = control.value.split(',').map(t => t.trim()).filter(Boolean);
        else if (f === 'scope' || f === 'position' || f === 'role') {
            next[f] = control.value === INHERIT ? null : (f === 'scope' ? control.value : Number(control.value));
        } else if (f === 'depth' || f === 'interval') {
            if (!control.validity.valid) return;
            next[f] = control.value === '' ? null : Number(control.value);
        } else if (f === 'scan' || f === 'enabledByDefault') next[f] = control.checked;
        else if (f === 'notebookId') next.notebookId = control.value;
        else return;
        if (effScope(next) !== previousScope && !resolveScopeRef(next)) {
            control.value = p[f] ?? INHERIT;
            updateEditor(p); return;
        }
        upsertPrompt(next);
        render();
    }

    async function openNotebookEditor(nb) {
        const ctx = getCtx();
        const d = nb.defaults;
        const el = document.createElement('div');
        el.className = 'pnb-editor';
        el.innerHTML = `
            ${field('Notebook name', `<input class="text_pole" data-f="name" value="${esc(nb.name)}" />`)}
            <div class="pnb-defhdr">Defaults (inherited by prompts unless overridden)</div>
            <div class="pnb-row">
                ${field('Scope', `<select data-f="scope">${selectFor(SCOPE_LABELS, d.scope)}</select>`)}
                ${field('Position', `<select data-f="position">${selectFor(POSITION_LABELS, d.position)}</select>`)}
            </div>
            <div class="pnb-row">
                ${field('Depth', `<input type="number" min="0" class="text_pole" data-f="depth" value="${d.depth}" />`)}
                ${field('Role', `<select data-f="role">${selectFor(ROLE_LABELS, d.role)}</select>`)}
                ${field('Frequency', `<input type="number" min="1" class="text_pole" data-f="interval" value="${d.interval}" />`)}
            </div>
            <label class="pnb-inline"><input type="checkbox" data-f="macroOnly" ${nb.macroOnly ? 'checked' : ''} /> Macro-only — don't auto-inject; deliver via the macro below</label>
            <div class="pnb-scopehint">Embed in your Author's Note (or anywhere macros expand): <code>{{notebook:${esc(nb.name)}}}</code></div>
            <div class="pnb-actions"><span class="menu_button" data-f="delete">Delete notebook</span></div>
        `;
        const get = (f) => el.querySelector(`[data-f="${f}"]`);
        let wantDelete = false;
        const popup = new ctx.Popup(el, ctx.POPUP_TYPE.CONFIRM, '', { okButton: 'Save', cancelButton: 'Cancel' });
        get('delete').addEventListener('click', () => { wantDelete = true; popup.completeCancelled(); });
        const result = await popup.show();
        if (wantDelete) {
            if (await ctx.Popup.show.confirm('Delete notebook', `Delete "${esc(nb.name)}" and its prompts?`)) { deleteNotebook(nb.id); render(); }
            return;
        }
        if (result !== ctx.POPUP_RESULT.AFFIRMATIVE) return;

        nb.name = get('name').value.trim() || nb.name;
        nb.macroOnly = !!get('macroOnly').checked;
        nb.defaults = {
            scope: get('scope').value,
            position: Number(get('position').value),
            depth: Number(get('depth').value),
            role: Number(get('role').value),
            interval: Number(get('interval').value),
            scan: d.scan ?? false,
        };
        saveSettings(); refreshMacros(); applyInjections(); render();
    }

    // ─────────────────────────────────────────────────────────── drag & resize

    function makeDraggable() {
        const header = $panel.querySelector('[data-drag]');
        let sx, sy, ox, oy, dragging = false;
        header.addEventListener('pointerdown', (e) => {
            if (e.target.closest('[data-act]')) return;
            dragging = true; sx = e.clientX; sy = e.clientY;
            const r = $panel.getBoundingClientRect(); ox = r.left; oy = r.top;
            header.setPointerCapture(e.pointerId);
        });
        header.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            const x = Math.max(0, ox + e.clientX - sx);
            const y = Math.max(0, oy + e.clientY - sy);
            $panel.style.left = x + 'px'; $panel.style.top = y + 'px';
        });
        header.addEventListener('pointerup', (e) => {
            if (!dragging) return; dragging = false;
            header.releasePointerCapture(e.pointerId);
            const s = getSettings(); s.panel.x = parseInt($panel.style.left); s.panel.y = parseInt($panel.style.top); saveSettings();
        });
    }
    function makeResizable() {
        const grip = $panel.querySelector('[data-resize]');
        let sx, sy, ow, oh, sizing = false;
        grip.addEventListener('pointerdown', (e) => {
            sizing = true; sx = e.clientX; sy = e.clientY;
            const r = $panel.getBoundingClientRect(); ow = r.width; oh = r.height;
            grip.setPointerCapture(e.pointerId); e.stopPropagation();
        });
        grip.addEventListener('pointermove', (e) => {
            if (!sizing) return;
            $panel.style.width = Math.max(260, ow + e.clientX - sx) + 'px';
            $panel.style.height = Math.max(220, oh + e.clientY - sy) + 'px';
        });
        grip.addEventListener('pointerup', (e) => {
            if (!sizing) return; sizing = false; grip.releasePointerCapture(e.pointerId);
            const s = getSettings(); s.panel.w = parseInt($panel.style.width); s.panel.h = parseInt($panel.style.height); saveSettings();
        });
    }

    function togglePanel(force) {
        const s = getSettings();
        if (!$panel) buildPanel();
        s.panel.open = force === undefined ? !s.panel.open : !!force;
        $panel.style.display = s.panel.open ? 'flex' : 'none';
        if (s.panel.open) render();
        saveSettings();
    }

    // ────────────────────────────────────────────────────────────── launcher + cmds

    function addLauncher() {
        const menu = document.getElementById('extensionsMenu');
        if (menu && !document.getElementById('pnb-launch')) {
            const item = document.createElement('div');
            item.id = 'pnb-launch';
            item.className = 'list-group-item flex-container flexGap5 interactable';
            item.tabIndex = 0;
            item.innerHTML = `<span style="margin-right:6px;">📓</span><span>Prompt Notebooks</span>`;
            item.addEventListener('click', () => togglePanel());
            menu.appendChild(item);
        }
    }

    function registerCommands() {
        const ctx = getCtx();
        const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = ctx;
        const byName = (q) => getSettings().prompts.find(p => p.name.toLowerCase() === String(q).toLowerCase() || p.id === q);

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'notebooks', aliases: ['pnb'],
            callback: () => { togglePanel(); return ''; },
            helpString: 'Toggle the Prompt Notebooks panel.',
        }));
        const mk = (name, fn, help) => SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name, callback: (_, v) => { const p = byName(v); if (!p) { toast('No prompt: ' + v, 'warning'); return ''; } fn(p); return p.name; },
            unnamedArgumentList: [new SlashCommandArgument('prompt name or id', [ARGUMENT_TYPE.STRING], true)],
            helpString: help,
        }));
        mk('pnb-on', (p) => toggleActive(p.id, true), 'Turn a prompt ON in the current chat.');
        mk('pnb-off', (p) => toggleActive(p.id, false), 'Turn a prompt OFF in the current chat.');
        mk('pnb-toggle', (p) => toggleActive(p.id, !isActive(p, scopeContext())), 'Toggle a prompt in the current chat.');
    }

    // ───────────────────────────────────────────────────────────────────── init

    function onChatChanged() {
        if (getCtx().getCurrentChatId?.()) chatMeta();   // stamp lineageId only when a chat is open
        applyInjections();
        render();
    }

    async function init() {
        if (initialized) return;
        const ctx = getCtx();
        if (!ctx?.eventSource) { setTimeout(init, 300); return; }
        initialized = true;

        getSettings();
        addLauncher();
        registerCommands();
        refreshMacros();
        buildPanel();   // build now (hidden unless panel.open) so a persisted-open panel survives reload

        const { eventSource, eventTypes } = ctx;
        eventSource.on(eventTypes.CHAT_CHANGED, onChatChanged);
        // Re-add the launcher if the menu is rebuilt
        eventSource.on(eventTypes.APP_READY, addLauncher);

        applyInjections();
        console.log('[Prompt Notebooks] initialized');
    }

    // Authoritative pre-generation apply (runs at script.js:4538, before AN + prompt assembly)
    globalThis[INTERCEPTOR] = async function (/* chat, contextSize, abort, type */) {
        try { if (initialized) applyInjections(); } catch (e) { console.error('[Prompt Notebooks] interceptor', e); }
    };

    if (globalThis.jQuery) jQuery(() => init()); else setTimeout(init, 500);
})();
