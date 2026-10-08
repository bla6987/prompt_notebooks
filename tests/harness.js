// Runs the real extension against a deterministic SillyTavern context.
(function () {
    let current = 'chat-a';
    const chats = { 'chat-a': {}, 'chat-b': {} };
    const events = new Map();
    const commands = new Map();
    const macros = new Map();
    const calls = { settings: 0, metadata: 0, popups: 0 };
    let nextId = 0;
    class Popup {
        constructor() { calls.popups++; }
        async show() { return 1; }
        static show = { confirm: async () => true, input: async () => 'Added notebook' };
    }
    const ctx = {
        extensionSettings: {}, chatMetadata: chats[current], chat: [{ is_user: true }],
        extensionPrompts: {}, characterId: 0, groupId: null,
        getCurrentChatId: () => current,
        uuidv4: () => `test-${++nextId}`,
        saveSettingsDebounced: () => calls.settings++,
        saveMetadataDebounced: () => calls.metadata++,
        setExtensionPrompt: (key, text, position, depth, scan, role, filter) => {
            ctx.extensionPrompts[key] = { text, position, depth, scan, role, filter };
        },
        eventTypes: { CHAT_CHANGED: 'chat', APP_READY: 'ready' },
        eventSource: { on: (event, fn) => events.set(event, fn) },
        registerMacro: (name, fn) => macros.set(name, fn),
        unregisterMacro: name => macros.delete(name),
        SlashCommandParser: { addCommandObject: command => commands.set(command.name, command) },
        SlashCommand: { fromProps: value => value }, SlashCommandArgument: class {}, ARGUMENT_TYPE: { STRING: 'string' },
        Popup, POPUP_TYPE: { CONFIRM: 1 }, POPUP_RESULT: { AFFIRMATIVE: 1 },
    };
    globalThis.SillyTavern = { getContext: () => ctx };
    globalThis.jQuery = fn => fn();
    globalThis.harness = {
        ctx, chats, calls, commands, macros,
        switchChat(id, emit = true) {
            current = id;
            ctx.chatMetadata = id ? (chats[id] ??= {}) : {};
            if (emit) events.get('chat')();
        },
        emitChat: () => events.get('chat')(),
    };
})();
