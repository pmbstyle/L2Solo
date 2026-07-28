const PRIORITIES = Object.freeze({
    critical: { dedupeMs: 3000, partyCooldownMs: 0 },
    coordination: { dedupeMs: 12000, partyCooldownMs: 7000 },
    informational: { dedupeMs: 30000, partyCooldownMs: 15000 },
    social: { dedupeMs: 180000, partyCooldownMs: 180000 },
    direct: { dedupeMs: 3000, partyCooldownMs: 0 }
});

const RESULT_TIMEOUT_MS = 35000;
const EVENT_HISTORY_MS = Math.max(...Object.values(PRIORITIES).map((priority) => priority.dedupeMs));

function leaderFor(session) {
    return session?.partyCompanion === true ? session.followPlayerSession || null : null;
}

function stateFor(session, allowStandalone = false) {
    const owner = leaderFor(session) || (allowStandalone ? session : null);
    if (!owner) return null;
    if (!owner.botPartyChat) {
        owner.botPartyChat = {
            events: {},
            lastPartyMessageAt: 0,
            sequence: 0
        };
    }
    return owner.botPartyChat;
}

function clean(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function chooseText(entry, state) {
    if (entry.text) return clean(entry.text);
    const templates = Array.isArray(entry.templates) ? entry.templates : [];
    if (templates.length === 0) return '';
    const index = state.sequence % templates.length;
    state.sequence += 1;
    return clean(templates[index]);
}

function canSend(state, entry, now) {
    Object.entries(state.events).forEach(([key, at]) => {
        if (now - Number(at || 0) > EVENT_HISTORY_MS) delete state.events[key];
    });
    const priority = PRIORITIES[entry.priority] || PRIORITIES.coordination;
    const previous = Number(state.events[entry.key] || 0);
    if (previous && now - previous < priority.dedupeMs) return false;
    if (priority.partyCooldownMs > 0 && now - Number(state.lastPartyMessageAt || 0) < priority.partyCooldownMs) {
        return false;
    }
    return true;
}

function announce(session, entry = {}) {
    if (!session?.actor || !entry.key) return false;
    // A factual reply to a direct player request also matters outside a
    // companion party. Ambient and coordination events remain party-only.
    const state = stateFor(session, !!entry.targetSession);
    if (!state) return false;

    const now = Number(entry.now || Date.now());
    if (!canSend(state, entry, now)) return false;
    const text = chooseText(entry, state);
    if (!text) return false;

    const BotManager = invoke('GameServer/Bot/BotManager');
    const sent = entry.targetSession
        ? BotManager.botTell(session, entry.targetSession, text)
        : BotManager.botPartySay(session, text);
    if (sent === false) return false;

    state.events[entry.key] = now;
    state.lastPartyMessageAt = now;
    return true;
}

function expectSkillResult(session, request = {}) {
    if (!session?.actor || !request.target || !request.skill) return false;
    session.pendingPartyChatResult = {
        targetId: Number(request.target.fetchId?.() || 0),
        skillId: Number(request.skill.fetchSelfId?.() || 0),
        kind: request.kind || 'support',
        targetSession: request.targetSession || null,
        expiresAt: Date.now() + RESULT_TIMEOUT_MS
    };
    return true;
}

function didLand(outcome) {
    return !!(
        outcome?.effect ||
        outcome?.resurrected ||
        Number(outcome?.heal || 0) > 0 ||
        Number(outcome?.mpRestore || 0) > 0 ||
        Number(outcome?.cpRestore || 0) > 0
    );
}

function resultEntry(request, target, skill) {
    const targetName = target.fetchName?.() || 'the party';
    const skillName = skill.fetchName?.() || 'Support';
    if (request.kind === 'emergency_heal') {
        return {
            priority: 'critical',
            key: `emergency-heal:${target.fetchId?.() || targetName}`,
            templates: [
                `Emergency heal landed on ${targetName}.`,
                `${targetName} is stabilized.`
            ]
        };
    }
    if (request.kind === 'resurrection') {
        return {
            priority: 'critical',
            key: `resurrection:${target.fetchId?.() || targetName}`,
            templates: [
                `${targetName} is back up.`,
                `Resurrection landed on ${targetName}.`
            ]
        };
    }
    if (request.kind === 'heal') {
        return {
            priority: 'direct',
            key: `direct-heal:${target.fetchId?.() || targetName}:${skill.fetchSelfId?.() || skillName}`,
            targetSession: request.targetSession,
            templates: [
                `${targetName}, ${skillName} landed.`,
                `${targetName}, you're healed.`
            ]
        };
    }
    return {
        priority: 'direct',
        key: `direct-support:${target.fetchId?.() || targetName}:${skill.fetchSelfId?.() || skillName}`,
        targetSession: request.targetSession,
        templates: [
            `${skillName} is up on ${targetName}.`,
            `${targetName} has ${skillName} now.`
        ]
    };
}

function confirmSkillResult(session, actor, target, skill, outcome) {
    const request = session?.pendingPartyChatResult;
    if (!request || Number(request.expiresAt || 0) <= Date.now()) {
        if (session) session.pendingPartyChatResult = undefined;
        return false;
    }
    const doesNotMatchRequest = (
        Number(request.targetId) !== Number(target?.fetchId?.() || 0) ||
        Number(request.skillId) !== Number(skill?.fetchSelfId?.() || 0)
    );
    if (doesNotMatchRequest) return false;

    session.pendingPartyChatResult = undefined;
    if (!didLand(outcome)) return false;
    return announce(session, resultEntry(request, target, skill));
}

function cancelExpectedSkillResult(session, actor, target, skill) {
    const request = session?.pendingPartyChatResult;
    if (!request) return false;
    if (
        Number(request.targetId) !== Number(target?.fetchId?.() || 0) ||
        Number(request.skillId) !== Number(skill?.fetchSelfId?.() || 0)
    ) {
        return false;
    }
    session.pendingPartyChatResult = undefined;
    return true;
}

module.exports = {
    PRIORITIES,
    RESULT_TIMEOUT_MS,
    EVENT_HISTORY_MS,
    announce,
    expectSkillResult,
    confirmSkillResult,
    cancelExpectedSkillResult,
    didLand
};
