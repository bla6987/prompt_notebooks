const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const harness = fs.readFileSync(path.join(__dirname, 'harness.js'), 'utf8');

function setup(initialSettings) {
    const dom = new JSDOM('<div id="extensionsMenu"></div><textarea id="chat-input"></textarea>', { runScripts: 'outside-only', url: 'http://localhost' });
    const w = dom.window;
    w.structuredClone = structuredClone;
    w.eval(harness);
    if (initialSettings) w.harness.ctx.extensionSettings.promptNotebooks = structuredClone(initialSettings);
    w.eval(source);
    const h = w.harness;
    const q = selector => w.document.querySelector(selector);
    const click = selector => q(selector).click();
    const field = f => q(`[data-f="${f}"]`);
    const input = (f, value) => {
        const el = field(f);
        if (el.type === 'checkbox') el.checked = value; else el.value = value;
        el.dispatchEvent(new w.Event('input', { bubbles: true }));
    };
    if (!initialSettings) click('[data-act="add-prompt"]');
    return { dom, w, h, q, click, field, input, settings: h.ctx.extensionSettings.promptNotebooks, prompt: () => h.ctx.extensionSettings.promptNotebooks.prompts.find(p => p.id === h.ctx.extensionSettings.promptNotebooks.panel.selectedPromptId) };
}

test('editing is non-modal, autosaves, updates injections/macros, and preserves focus/selection/scroll', () => {
    const t = setup(); const text = t.field('text');
    assert.equal(t.h.calls.popups, 0);
    text.focus(); t.input('text', 'abcdef'); text.setSelectionRange(2, 4); text.scrollTop = 10;
    t.h.commands.get('pnb-off').callback({}, t.prompt().id);
    t.h.emitChat();
    assert.equal(t.field('text'), text);
    assert.equal(t.w.document.activeElement, text);
    assert.equal(text.selectionStart, 2); assert.equal(text.selectionEnd, 4); assert.equal(text.scrollTop, 10);
    assert.equal(t.prompt().text, 'abcdef');
    t.h.commands.get('pnb-on').callback({}, t.prompt().id);
    assert.equal(Object.values(t.h.ctx.extensionPrompts)[0].text, 'abcdef');
    assert.equal(t.h.macros.get('notebook:General')(), 'abcdef');
    assert.ok(t.h.calls.settings > 1);
    t.q('#chat-input').focus(); assert.equal(t.w.document.activeElement.id, 'chat-input');
    t.click('[data-act="close"]'); t.click('#pnb-launch');
    assert.equal(t.field('text').value, 'abcdef');
    t.dom.window.close();
});

test('per-chat overrides switch independently; stale events before CHAT_CHANGED cannot write into next chat', () => {
    const t = setup(); t.input('text', 'shared'); t.input('ovEnabled', true); t.input('text', 'only a');
    const id = t.prompt().id;
    assert.equal(t.prompt().text, 'shared');
    assert.equal(t.h.chats['chat-a'].promptNotebooks.overrides[id].text, 'only a');
    assert.equal(Object.values(t.h.ctx.extensionPrompts)[0].text, 'only a');
    t.h.switchChat('chat-b', false);
    t.input('text', 'stale a');
    assert.equal(t.h.chats['chat-a'].promptNotebooks.overrides[id].text, 'only a');
    assert.equal(t.h.chats['chat-b'].promptNotebooks.overrides[id], undefined);
    assert.equal(t.field('text').value, 'shared'); assert.equal(t.field('ovEnabled').checked, false);
    t.input('ovEnabled', true); t.input('text', 'only b');
    t.h.switchChat('chat-a'); assert.equal(t.field('text').value, 'only a');
    t.input('ovEnabled', false); assert.equal(t.field('text').value, 'shared');
    assert.equal(t.h.chats['chat-a'].promptNotebooks.overrides[id], undefined);
    assert.equal(t.h.chats['chat-b'].promptNotebooks.overrides[id].text, 'only b');
    t.dom.window.close();
});

test('metadata replacement and identical chat ids across characters reject stale override events', () => {
    const t = setup(); t.input('ovEnabled', true); t.input('text', 'original');
    const old = t.h.ctx.chatMetadata; t.h.ctx.chatMetadata = {}; t.input('text', 'wrong object');
    assert.equal(old.promptNotebooks.overrides[t.prompt().id].text, 'original');
    assert.equal(t.h.ctx.chatMetadata.promptNotebooks.overrides[t.prompt().id].text, 'original');
    t.input('ovEnabled', true); t.h.ctx.characterId = 1; t.input('text', 'wrong character');
    assert.notEqual(t.h.ctx.chatMetadata.promptNotebooks.overrides[t.prompt().id]?.text, 'wrong character');
    t.dom.window.close();
});

test('scope stays bound during ordinary edits and binds only when changed or explicitly rebound', () => {
    const t = setup(); t.input('scope', 'thread'); assert.equal(t.prompt().scopeRef, 'chat-a');
    t.h.switchChat('chat-b'); t.input('text', 'text from b'); t.input('depth', '8');
    assert.equal(t.prompt().scopeRef, 'chat-a'); assert.deepEqual(Object.keys(t.h.ctx.extensionPrompts), []);
    t.click('[data-f="rebind"]'); assert.equal(t.prompt().scopeRef, 'chat-b');
    t.input('scope', 'lineage');
    assert.equal(t.prompt().scopeRef, t.h.chats['chat-b'].promptNotebooks.lineageId);
    t.input('scope', 'global'); assert.equal(t.prompt().scopeRef, null);
    t.h.switchChat(null); t.input('scope', 'thread'); assert.equal(t.prompt().scope, 'global');
    assert.equal(t.field('ovEnabled').disabled, true);
    t.dom.window.close();
});

test('settings apply immediately, honor inheritance, reject invalid numbers, and leave details expanded', () => {
    const t = setup(); t.input('text', 'settings'); t.click('.pnb-prompt-settings summary');
    t.input('position', '2'); t.input('role', '1'); t.input('depth', '0'); t.input('interval', '2'); t.input('scan', true);
    let injection = Object.values(t.h.ctx.extensionPrompts)[0];
    assert.equal(injection.position, 2); assert.equal(injection.role, 1); assert.equal(injection.depth, 0); assert.equal(injection.scan, true);
    assert.equal(injection.filter(), false); t.h.ctx.chat.push({ is_user: true }); assert.equal(injection.filter(), true);
    t.input('depth', '-1'); assert.equal(t.prompt().depth, 0);
    t.input('interval', '0'); assert.equal(t.prompt().interval, 2);
    t.input('depth', ''); t.input('role', '__inherit__'); t.click('[data-f="inheritScan"]');
    injection = Object.values(t.h.ctx.extensionPrompts)[0];
    assert.equal(injection.depth, 4); assert.equal(injection.role, 0); assert.equal(injection.scan, false);
    assert.equal(t.q('.pnb-prompt-settings').open, true);
    t.dom.window.close();
});

test('duplicate uses latest shared changes, delete closes selection, and notebook gear opens settings', async () => {
    const t = setup(); t.input('text', 'latest'); t.input('name', 'Draft'); const original = t.prompt().id;
    t.click('[data-f="duplicate"]'); assert.equal(t.settings.prompts.length, 2);
    assert.notEqual(t.prompt().id, original); assert.equal(t.prompt().text, 'latest'); assert.equal(t.prompt().name, 'Draft (copy)');
    t.click('[data-f="delete"]'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(t.settings.prompts.length, 1); assert.equal(t.field('text'), null);
    t.click('[data-nb-edit]'); assert.equal(t.h.calls.popups, 1);
    t.dom.window.close();
});

test('moving notebooks updates inherited settings without losing text focus or scope binding', () => {
    const t = setup(); const nb = { id: 'nb-two', name: 'Other', defaults: { scope: 'thread', depth: 7, position: 1, role: 2, scan: true, interval: 1 } };
    t.settings.notebooks.push(nb); t.h.emitChat();
    t.input('notebookId', nb.id); assert.equal(t.prompt().scopeRef, 'chat-a');
    t.field('text').focus(); t.input('text', 'moved');
    const injection = Object.values(t.h.ctx.extensionPrompts)[0]; assert.equal(injection.depth, 7); assert.equal(injection.role, 2); assert.equal(injection.scan, true);
    t.h.switchChat('chat-b'); t.input('name', 'renamed'); assert.equal(t.prompt().scopeRef, 'chat-a');
    t.dom.window.close();
});

test('empty override falls back to shared text, disabling default activation removes injection', () => {
    const t = setup(); t.input('text', 'shared'); t.input('ovEnabled', true); t.input('text', '');
    assert.equal(Object.values(t.h.ctx.extensionPrompts)[0].text, 'shared');
    t.input('enabledByDefault', false); assert.equal(Object.keys(t.h.ctx.extensionPrompts).length, 0);
    t.dom.window.close();
});

test('drag order controls injection order, and dropping into a notebook preserves the open editor', async () => {
    const t = setup(); t.input('text', 'first'); const first = t.prompt().id;
    t.click('[data-act="add-prompt"]'); t.input('text', 'second'); const second = t.prompt().id;
    const transfer = { effectAllowed: '', setData() {}, getData: () => second };
    const dispatch = (el, name) => {
        const event = new t.w.Event(name, { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', { value: transfer });
        Object.defineProperty(event, 'clientY', { value: -1 }); el.dispatchEvent(event);
    };
    const text = t.field('text');
    dispatch(t.q(`.pnb-prompt[data-id="${second}"]`), 'dragstart');
    dispatch(t.q(`.pnb-prompt[data-id="${first}"]`), 'drop');
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(Array.from(t.settings.prompts, p => p.id), [second, first]);
    assert.deepEqual(Object.entries(t.h.ctx.extensionPrompts).sort().map(([, p]) => p.text), ['second', 'first']);
    assert.equal(t.field('text'), text);
    t.settings.notebooks.push({ id: 'other', name: 'Other', defaults: {} }); t.h.emitChat();
    dispatch(t.q(`.pnb-prompt[data-id="${second}"]`), 'dragstart');
    dispatch(t.q('.pnb-nb-head[data-id="other"]'), 'drop');
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(t.prompt().notebookId, 'other'); assert.equal(t.field('notebookId').value, 'other');
    t.dom.window.close();
});

test('import/export preserves settings and macros while leaving the selected text control intact', async () => {
    const t = setup(); t.input('text', 'original'); const text = t.field('text');
    const data = { notebooks: [{ id: 'imported-nb', name: 'Imported', macroOnly: true, defaults: { depth: 9 } }],
        prompts: [{ id: 'imported-p', notebookId: 'imported-nb', name: 'Imported prompt', text: 'macro text', tags: ['imported'], role: 1 }] };
    const file = new t.w.File([JSON.stringify(data)], 'library.json', { type: 'application/json' });
    const control = t.q('.pnb-file'); Object.defineProperty(control, 'files', { value: [file] });
    control.dispatchEvent(new t.w.Event('change', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(t.settings.prompts.length, 2); assert.equal(t.field('text'), text);
    assert.equal(t.h.macros.get('notebook:Imported')(), 'macro text');
    assert.equal(Object.values(t.h.ctx.extensionPrompts).some(p => p.text === 'macro text'), false);
    let blob, download;
    t.w.URL.createObjectURL = value => { blob = value; return 'blob:test'; };
    t.w.URL.revokeObjectURL = () => {};
    t.w.HTMLAnchorElement.prototype.click = function () { download = this.download; };
    t.click('[data-act="export"]'); assert.equal(download, 'prompt-notebooks.json');
    const reader = new t.w.FileReader();
    const exported = await new Promise(resolve => { reader.onload = () => resolve(JSON.parse(reader.result)); reader.readAsText(blob); });
    assert.equal(exported.prompts.find(p => p.id === 'imported-p').role, 1);
    assert.equal(exported.notebooks.find(p => p.id === 'imported-nb').defaults.depth, 9);
    assert.equal(exported.notebooks.find(p => p.id === 'imported-nb').macroOnly, true);
    t.dom.window.close();
});

test('new macro engine registers notebook with an argument and expands current toggles/overrides', async () => {
    const t = setup(); const registry = new Map();
    t.h.ctx.powerUserSettings = { experimental_macro_engine: true };
    t.h.ctx.macros = { register: (name, def) => { registry.set(name, def); return def; }, registry: { unregisterMacro: name => registry.delete(name) } };
    // A notebook mutation refreshes registrations, just as startup does.
    t.click('[data-act="add-notebook"]'); await new Promise(resolve => setImmediate(resolve));
    const macro = registry.get('notebook'); assert.ok(macro); assert.equal(macro.unnamedArgs[0].name, 'name');
    assert.equal(t.h.macros.size, 0);
    t.input('text', 'modern'); assert.equal(macro.handler({ unnamedArgs: ['General'] }), 'modern');
    t.input('ovEnabled', true); t.input('text', 'override'); assert.equal(macro.handler({ unnamedArgs: ['General'] }), 'override');
    t.h.commands.get('pnb-off').callback({}, t.prompt().id); assert.equal(macro.handler({ unnamedArgs: ['General'] }), '');
    t.dom.window.close();
});

test('leaving override text flushes metadata for its chat and stale blur cannot flush a different chat', () => {
    const t = setup(); const saved = []; t.h.ctx.saveMetadata = () => saved.push(t.h.ctx.chatMetadata);
    t.input('ovEnabled', true); t.field('text').focus(); t.input('text', 'latest a'); t.q('#chat-input').focus();
    assert.equal(saved.length, 1); assert.equal(saved[0], t.h.chats['chat-a']);
    t.field('text').focus(); t.h.switchChat('chat-b', false); t.q('#chat-input').focus();
    assert.equal(saved.length, 1);
    t.dom.window.close();
});

test('pending override recovery survives cancelled native saves and restores only the owning chat', () => {
    const t = setup(); t.input('text', 'shared'); t.input('ovEnabled', true); t.input('text', 'unsaved a');
    const id = t.prompt().id; const journal = t.settings.pendingOverrides;
    assert.equal(Object.keys(journal).length, 1);
    t.h.switchChat('chat-b'); assert.equal(t.field('text').value, 'shared');
    // Simulate loading chat A from disk before the cancelled native debounce saved its edit.
    t.h.chats['chat-a'] = {}; t.h.switchChat('chat-a');
    assert.equal(t.field('text').value, 'unsaved a'); assert.equal(t.field('ovEnabled').checked, true);
    const savedMetadata = structuredClone(t.h.chats['chat-a']);
    t.h.chats['chat-a'] = savedMetadata; t.h.switchChat('chat-a');
    assert.equal(Object.keys(journal).length, 0); // disk reload confirmed this revision
    const staleDiskMetadata = structuredClone(savedMetadata);
    t.input('ovEnabled', false); t.h.chats['chat-a'] = staleDiskMetadata; t.h.switchChat('chat-a');
    assert.equal(t.field('text').value, 'shared'); assert.equal(t.field('ovEnabled').checked, false);
    t.dom.window.close();
});


test('reloading extension settings recovers the last chat edit before native metadata reached disk', () => {
    const t = setup(); t.input('text', 'shared'); t.input('ovEnabled', true); t.input('text', 'persisted recovery');
    const snapshot = structuredClone(t.settings); t.dom.window.close();
    const reloaded = setup(snapshot);
    assert.equal(reloaded.field('text').value, 'persisted recovery');
    assert.equal(reloaded.field('ovEnabled').checked, true);
    reloaded.h.switchChat('chat-b'); assert.equal(reloaded.field('text').value, 'shared');
    reloaded.dom.window.close();
});

test('recovery keys distinguish characters and groups even when chat filenames are identical', () => {
    const t = setup(); t.input('text', 'shared'); t.input('ovEnabled', true); t.input('text', 'character zero');
    t.h.ctx.characterId = 1; t.h.ctx.chatMetadata = {}; t.h.emitChat();
    assert.equal(t.field('text').value, 'shared');
    t.input('ovEnabled', true); t.input('text', 'character one');
    t.h.ctx.groupId = 'group-one'; t.h.ctx.chatMetadata = {}; t.h.emitChat();
    assert.equal(t.field('text').value, 'shared');
    t.input('ovEnabled', true); t.input('text', 'group one');
    t.h.ctx.groupId = null; t.h.ctx.characterId = 0; t.h.ctx.chatMetadata = {}; t.h.emitChat();
    assert.equal(t.field('text').value, 'character zero');
    t.dom.window.close();
});

test('native shallow metadata updates do not retire recovery before a disk reload', () => {
    const t = setup(); t.input('text', 'shared'); t.input('ovEnabled', true); t.input('text', 'pending edit');
    const journal = t.settings.pendingOverrides;
    const text = t.field('text'); text.focus(); text.setSelectionRange(2, 4);
    // Native updateChatMetadata replaces the outer object, retaining each extension namespace.
    t.h.ctx.chatMetadata = { ...t.h.ctx.chatMetadata, note_prompt: 'native note' };
    t.h.emitChat();
    assert.equal(Object.keys(journal).length, 1);
    assert.equal(t.field('text'), text);
    assert.equal(t.w.document.activeElement, text);
    assert.equal(text.selectionStart, 2); assert.equal(text.selectionEnd, 4);
    // A replacement may also happen before any extension render/event.
    t.h.ctx.chatMetadata = { ...t.h.ctx.chatMetadata, note_depth: 4 };
    t.input('text', 'pending edit after metadata update');
    assert.equal(t.h.ctx.chatMetadata.promptNotebooks.overrides[t.prompt().id].text, 'pending edit after metadata update');
    t.h.chats['chat-a'] = {}; t.h.switchChat('chat-a');
    assert.equal(t.field('text').value, 'pending edit after metadata update');
    t.dom.window.close();
});

test('deleting a notebook also removes its pending chat recovery records', async () => {
    const t = setup(); t.input('ovEnabled', true); t.input('text', 'pending deletion');
    t.click('[data-act="add-notebook"]'); await new Promise(resolve => setImmediate(resolve));
    const first = t.settings.notebooks[0].id;
    const Original = t.h.ctx.Popup;
    t.h.ctx.Popup = class extends Original {
        constructor(element) { super(); this.element = element; }
        completeCancelled() {}
        async show() { this.element.querySelector('[data-f="delete"]').click(); return 0; }
    };
    t.click(`[data-nb-edit="${first}"]`); await new Promise(resolve => setImmediate(resolve));
    assert.equal(t.settings.prompts.length, 0);
    assert.equal(Object.keys(t.settings.pendingOverrides).length, 0);
    assert.equal(Object.keys(t.h.ctx.extensionPrompts).length, 0);
    t.dom.window.close();
});

test('a replacement chat with the same filename cannot inherit a deleted chat recovery patch', () => {
    const t = setup(); t.h.ctx.chatMetadata.integrity = 'original-chat';
    t.input('text', 'shared'); t.input('ovEnabled', true); t.input('text', 'deleted chat override');
    t.h.chats['chat-a'] = { integrity: 'replacement-chat' }; t.h.switchChat('chat-a');
    assert.equal(t.field('text').value, 'shared');
    assert.equal(t.field('ovEnabled').checked, false);
    assert.equal(Object.keys(t.settings.pendingOverrides).length, 0);
    assert.equal(Object.values(t.h.ctx.extensionPrompts)[0].text, 'shared');
    t.dom.window.close();
});
