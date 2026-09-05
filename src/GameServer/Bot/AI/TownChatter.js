const BotPartyChat = invoke('GameServer/Bot/AI/BotPartyChat');
const ChatterBudget = invoke('GameServer/Bot/AI/BotChatterBudget');
const Reactions = invoke('GameServer/Bot/AI/BotChatReactions');

const DEFAULT_DEDUPE_MS = 30000;
const MAX_RECENT_LINES = 8;
// Navigation, stock checks and NPC selection are useful diagnostics, but
// strangers in town do not need a spoken report for each state transition.
const PUBLIC_EVENTS = new Set(['market-gear-purchased', 'npc-gear-purchased', 'shots-too-expensive']);
const ROUTINE_EVENTS = new Set([
    'equipment-market-selected', 'warehouse-selected', 'buyer-selected', 'npc-seller-selected',
    'alternate-warehouse', 'alternate-equipment-shop', 'alternate-town-shop',
    'shots-already-stocked', 'warehouse-deposit', 'loot-sold', 'shopping-to-rebuff'
]);

function stateOwner(session) {
    return session?.partyCompanion === true && session.followPlayerSession
        ? session.followPlayerSession
        : session;
}

function stateFor(session) {
    const owner = stateOwner(session);
    if (!owner) return null;
    owner.townChatter ??= { cursors: {}, recent: [] };
    return owner.townChatter;
}

function cleanTemplates(templates) {
    return (Array.isArray(templates) ? templates : [templates])
        .map((line) => String(line || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
}

function choose(session, key, templates) {
    const lines = cleanTemplates(templates);
    if (!lines.length) return '';
    const state = stateFor(session);
    if (!state) return lines[0];

    const actorSeed = Math.abs(Number(session?.actor?.fetchId?.() || 0));
    let cursor = Number(state.cursors[key]);
    if (!Number.isFinite(cursor)) cursor = actorSeed % lines.length;

    let selected = lines[cursor % lines.length];
    for (let offset = 0; offset < lines.length; offset++) {
        const candidate = lines[(cursor + offset) % lines.length];
        if (!state.recent.includes(candidate)) {
            selected = candidate;
            cursor += offset;
            break;
        }
    }

    state.cursors[key] = cursor + 1;
    state.recent.unshift(selected);
    if (state.recent.length > MAX_RECENT_LINES) state.recent.length = MAX_RECENT_LINES;
    return selected;
}

function say(session, BotAI, key, templates, options = {}) {
    const lines = cleanTemplates(templates);
    if (!session || !lines.length) return false;
    if (ROUTINE_EVENTS.has(key) && !options.priority) return false;

    if (session.actor && session.partyCompanion === true && session.followPlayerSession) {
        const BotManager = invoke('GameServer/Bot/BotManager');
        if (BotManager.partyChatRecipients(session).length > 0) {
            return BotPartyChat.announce(session, {
                priority: options.priority || 'informational',
                dedupeMs: Number.isFinite(Number(options.dedupeMs))
                    ? Math.max(0, Number(options.dedupeMs))
                    : DEFAULT_DEDUPE_MS,
                key: `town-chatter:${session.actor.fetchId?.() || 0}:${key}`,
                templates: lines,
                ...(Number.isFinite(Number(options.now)) ? { now: Number(options.now) } : {})
            });
        }
    }

    if (!PUBLIC_EVENTS.has(key)) return false;
    const now = Number(options.now ?? Date.now());
    if (session.inConversation || Reactions.isBusy(session, now) || !ChatterBudget.canSend(session, key, now)) return false;
    const line = choose(session, key, lines);
    if (!line) return false;
    if (BotAI.say(session, line) === false) return false;
    ChatterBudget.record(session, key, now);
    Reactions.openLocal(session, key, now);
    return true;
}

module.exports = {
    DEFAULT_DEDUPE_MS,
    MAX_RECENT_LINES,
    choose,
    say
};
