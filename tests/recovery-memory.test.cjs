const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function rig({ identity = 'account-a', storage = true } = {}) {
    const timers = new Set();
    let identityFetches = 0;
    let current = 'chat-a';
    const chats = { 'chat-a': {}, 'chat-b': {} };
    const settings = { notebooks: [{ id: 'nb', name: 'Book' }], prompts: [{ id: 'p', notebookId: 'nb', name: 'Prompt', text: 'shared' }], panel: {} };
    const ctx = {
        extensionSettings: { promptNotebooks: settings }, chatMetadata: chats[current], characterId: 0, groupId: null,
        getCurrentChatId: () => current, uuidv4: () => 'lineage', saveSettingsDebounced() {}, saveMetadataDebounced() {},
    };
    const sandbox = {
        SillyTavern: { getContext: () => ctx }, console: { log() {}, warn() {}, error() {} }, performance, AbortController,
        indexedDB: storage ? {} : undefined, IDBKeyRange: { only: value => value },
        fetch: async () => { identityFetches++; return { ok: !!identity, json: async () => ({ handle: identity, avatar: 'unused' }) }; },
        setTimeout(fn, ms) { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; },
        clearTimeout(id) { timers.delete(id); clearTimeout(id); },
    };
    vm.runInNewContext(source.replace(
        'if (globalThis.jQuery) jQuery(() => init()); else setTimeout(init, 500);',
        'globalThis.testing = { RecoveryJournal, recoveryJournal, getSettings, chatMeta, setOverride, flushRecoveryWrites, recoverCurrentJournal, includesQueryParts };'), sandbox);
    const api = sandbox.testing;
    const records = new Map();
    const reads = [];
    let activeWrites = 0, peakWrites = 0;
    if (api.recoveryJournal) api.recoveryJournal.putLatest = async (account, chatKey, promptId, patch) => {
        activeWrites++; peakWrites = Math.max(peakWrites, activeWrites);
        const key = JSON.stringify([account, chatKey, promptId]);
        if (!records.has(key) || records.get(key).revision < patch.revision) records.set(key, { account, chatKey, promptId, ...patch });
        await Promise.resolve(); activeWrites--;
    };
    if (api.recoveryJournal) api.recoveryJournal.visitChat = async (account, chatKey, visit) => {
        for (const [key, value] of records) {
            if (value.account !== account || value.chatKey !== chatKey) continue;
            reads.push(value);
            const action = visit(value);
            if (action === false) break;
            if (action === 'delete') records.delete(key);
            await Promise.resolve();
        }
    };
    const switchChat = (id, metadata) => {
        current = id;
        if (metadata) chats[id] = metadata;
        ctx.chatMetadata = chats[id] ??= {};
    };
    const key = (chat = current) => JSON.stringify(['character', 0, chat]);
    return { api, ctx, settings, records, reads, key, switchChat, peakWrites: () => peakWrites,
        identityFetches: () => identityFetches, setIdentity(value) { identity = value; },
        close() { for (const timer of timers) clearTimeout(timer); } };
}

test('writes coalesce typing, keep one in-flight body, and retire text only after commit', async () => {
    const r = rig();
    try {
        const p = r.settings.prompts[0];
        for (let i = 0; i < 1000; i++) r.api.setOverride(p, 'x'.repeat(i));
        assert.equal(Object.keys(r.settings.pendingOverrides[r.key()]).length, 1);
        const gate = deferred(); const written = []; let active = 0, peak = 0;
        r.api.recoveryJournal.putLatest = async (_account, _chat, _id, patch) => {
            active++; peak = Math.max(peak, active); written.push(patch.text);
            if (written.length === 1) await gate.promise;
            active--;
        };
        const flushing = r.api.flushRecoveryWrites();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(written.length, 1);
        assert.equal(r.settings.pendingOverrides[r.key()].p.text.length, 999);
        r.api.setOverride(p, 'latest while committing');
        gate.resolve(); await flushing;
        assert.equal(peak, 1);
        assert.deepEqual(written, ['x'.repeat(999), 'latest while committing']);
        assert.equal(Object.keys(r.settings.pendingOverrides).length, 0);
        assert.equal(typeof r.settings.recoveryJournalRevisions[r.key()].p, 'number');
    } finally { r.close(); }
});

test('failed storage and unavailable identity preserve every unconfirmed fallback', async () => {
    for (const identity of ['account-a', null]) {
        const r = rig({ identity });
        try {
            r.api.recoveryJournal.putLatest = async () => { throw new Error('quota'); };
            r.api.setOverride(r.settings.prompts[0], 'do not lose this edit');
            await r.api.flushRecoveryWrites();
            assert.equal(r.settings.pendingOverrides[r.key()].p.text, 'do not lose this edit');
        } finally { r.close(); }
    }
});

test('missing identity or IndexedDB blocks known disk-only recovery but preserves normal and settings fallback paths', async () => {
    for (const options of [{ identity: null }, { storage: false }]) {
        const r = rig(options);
        try {
            await r.api.recoverCurrentJournal();
            r.settings.recoveryJournalRevisions = { [r.key()]: { p: 100 } };
            await assert.rejects(r.api.recoverCurrentJournal(), /unavailable/);
            assert.equal(r.ctx.chatMetadata.promptNotebooks.overrides.p, undefined);
            assert.equal(r.reads.length, 0);

            // A newer settings fallback is sufficient even without the optional journal.
            r.settings.pendingOverrides = { [r.key()]: { p: { text: 'settings recovery', revision: 101 } } };
            r.switchChat('chat-a', {});
            await r.api.recoverCurrentJournal();
            assert.equal(r.ctx.chatMetadata.promptNotebooks.overrides.p.text, 'settings recovery');
            assert.equal(r.settings.pendingOverrides[r.key()].p.text, 'settings recovery');
        } finally { r.close(); }
    }
});

test('failed account lookup retries on the next recovery attempt and caches a verified identity', async () => {
    const r = rig({ identity: null });
    try {
        r.settings.recoveryJournalRevisions = { [r.key()]: { p: 100 } };
        r.records.set('durable', { account: 'account-a', chatKey: r.key(), promptId: 'p', text: 'disk-only edit', revision: 100 });
        await assert.rejects(r.api.recoverCurrentJournal(), /Account identity/);
        assert.equal(r.identityFetches(), 1);
        r.setIdentity('account-a');
        await r.api.recoverCurrentJournal();
        assert.equal(r.identityFetches(), 2);
        assert.equal(r.ctx.chatMetadata.promptNotebooks.overrides.p.text, 'disk-only edit');
        assert.equal(r.records.size, 1, 'recovery is not native-save confirmation');
        r.switchChat('chat-b', {});
        await r.api.recoverCurrentJournal();
        assert.equal(r.identityFetches(), 2, 'the verified account remains cached');
    } finally { r.close(); }
});

test('archive writes release text; recovery reads only the owning account and current chat', async () => {
    const r = rig();
    try {
        for (let i = 0; i < 200; i++) {
            r.switchChat('archive-' + i);
            r.api.setOverride(r.settings.prompts[0], 'body-' + i + 'x'.repeat(1024));
        }
        await r.api.flushRecoveryWrites();
        assert.equal(Object.keys(r.settings.pendingOverrides).length, 0);
        assert.equal(r.records.size, 200);
        assert.equal(r.peakWrites(), 1);
        const expected = [...r.records.values()].find(p => p.chatKey === r.key('archive-55'));
        r.records.set('other-account', { ...expected, account: 'account-b', text: 'private other account', revision: expected.revision + 1 });
        r.switchChat('archive-55', {});
        await r.api.recoverCurrentJournal();
        assert.equal(r.reads.length, 1);
        assert.equal(r.ctx.chatMetadata.promptNotebooks.overrides.p.text, expected.text);
        assert.equal(r.records.size, 201, 'recovered text is not proof that native metadata reached disk');
        r.ctx.chatMetadata = { ...r.ctx.chatMetadata };
        await r.api.recoverCurrentJournal();
        assert.equal(r.records.size, 201, 'shallow metadata updates do not confirm persistence');
        r.switchChat('archive-55', structuredClone(r.ctx.chatMetadata));
        await r.api.recoverCurrentJournal();
        assert.equal(r.records.size, 200, 'a fresh saved namespace confirms only its own revision');
        assert.equal(r.records.get('other-account').text, 'private other account');
    } finally { r.close(); }
});

test('rapid chat switches cancel stale recovery and returning retries the incomplete read', async () => {
    const r = rig();
    try {
        r.api.setOverride(r.settings.prompts[0], 'saved in a');
        await r.api.flushRecoveryWrites();
        const native = r.api.recoveryJournal.visitChat;
        const gate = deferred();
        r.api.recoveryJournal.visitChat = async (...args) => { await gate.promise; return native(...args); };
        r.switchChat('chat-a', {});
        const recovering = r.api.recoverCurrentJournal();
        await new Promise(resolve => setImmediate(resolve));
        r.switchChat('chat-b', {});
        gate.resolve(); await recovering;
        assert.equal(r.ctx.chatMetadata.promptNotebooks, undefined);
        r.switchChat('chat-a');
        await r.api.recoverCurrentJournal();
        assert.equal(r.ctx.chatMetadata.promptNotebooks.overrides.p.text, 'saved in a');
    } finally { r.close(); }
});

test('a current edit wins over delayed recovery and a required disk-only read failure is reported', async () => {
    const r = rig();
    try {
        r.api.setOverride(r.settings.prompts[0], 'old'); await r.api.flushRecoveryWrites();
        const native = r.api.recoveryJournal.visitChat; const gate = deferred();
        r.api.recoveryJournal.visitChat = async (...args) => { await gate.promise; return native(...args); };
        r.switchChat('chat-a', {});
        const recovering = r.api.recoverCurrentJournal();
        await new Promise(resolve => setImmediate(resolve));
        r.api.setOverride(r.settings.prompts[0], 'new active edit');
        gate.resolve(); await recovering;
        assert.equal(r.ctx.chatMetadata.promptNotebooks.overrides.p.text, 'new active edit');
        await r.api.flushRecoveryWrites();
        r.switchChat('chat-a', {});
        r.api.recoveryJournal.visitChat = async () => { throw new Error('storage unavailable'); };
        await assert.rejects(r.api.recoverCurrentJournal(), /storage unavailable/);
    } finally { r.close(); }
});

test('journal writes await transaction completion, reject abort, and never overwrite newer records', async () => {
    const r = rig();
    try {
        const journal = new r.api.RecoveryJournal({}, {});
        let transaction, request, stored;
        journal.open = async () => ({ transaction() {
            transaction = { objectStore: () => ({ get() { request = {}; return request; }, put(value) { stored = value; } }) };
            return transaction;
        } });
        let complete = false;
        const writing = journal.putLatest('account-a', 'chat', 'p', { revision: 2, text: 'new' }).then(() => { complete = true; });
        await new Promise(resolve => setImmediate(resolve));
        request.result = { revision: 3, text: 'newer' }; request.onsuccess();
        assert.equal(stored, undefined);
        await Promise.resolve(); assert.equal(complete, false);
        transaction.oncomplete(); await writing; assert.equal(complete, true);
        const failed = journal.putLatest('account-a', 'chat', 'p', { revision: 4, text: 'candidate' });
        await new Promise(resolve => setImmediate(resolve)); request.result = null; request.onsuccess();
        assert.equal(stored.text, 'candidate'); transaction.error = new Error('commit failed'); transaction.onabort();
        await assert.rejects(failed, /commit failed/);
    } finally { r.close(); }
});

test('search preserves cross-field and Unicode matches without concatenating the full prompt', () => {
    const r = rig();
    try {
        const parts = ['Title Σ', ' ', 'body İ needle', ' ', 'tag'];
        for (const query of ['σ body', 'body i̇', 'needle tag', 'tag', 'missing', 'i']) {
            assert.equal(r.api.includesQueryParts(parts, query), parts.join('').toLowerCase().includes(query), query);
        }
    } finally { r.close(); }
});

test('journal clears and integrity checks survive reload without resurrecting old text', async () => {
    const r = rig();
    try {
        const p = r.settings.prompts[0];
        r.ctx.chatMetadata.integrity = 'original';
        r.api.setOverride(p, 'before clear');
        const stale = structuredClone(r.ctx.chatMetadata);
        await r.api.flushRecoveryWrites();
        r.api.setOverride(p, '');
        await r.api.flushRecoveryWrites();
        r.switchChat('chat-a', stale);
        await r.api.recoverCurrentJournal();
        assert.equal(r.ctx.chatMetadata.promptNotebooks.overrides.p, undefined);
        assert.equal(r.records.size, 1, 'the clear remains unconfirmed until a fresh native revision is observed');
        r.switchChat('chat-a', { integrity: 'replacement' });
        await r.api.recoverCurrentJournal();
        assert.equal(r.ctx.chatMetadata.promptNotebooks.overrides.p, undefined);
        assert.equal(r.records.size, 0, 'a replacement chat cannot inherit the old chat journal');
    } finally { r.close(); }
});
