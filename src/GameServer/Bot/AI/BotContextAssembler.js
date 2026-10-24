const DiagnosticConfig = require('../Population/PopulationConfig');
const BotBrainContext = invoke('GameServer/Bot/AI/BotBrainContext');
const BotEventJournal = invoke('GameServer/Bot/AI/BotEventJournal');
const Protocol = require('./BotDialogueProtocol');
const Knowledge = require('./BotDialogueKnowledge');

const DEFAULT_BUDGET = 1200;
const HARD_MAX_TOKENS = 1800;

function estimateTokens(value) {
    if (value === null || value === undefined) return 0;
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    return Math.max(1, Math.ceil(String(serialized || '').length / 4));
}

function textWants(text, expression) {
    return expression.test(String(text || '').toLowerCase());
}

function trimText(value, max) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function compactRecentTurns(turns, max = 8) {
    return (turns || []).slice(-max).map((turn) => {
        const compact = {
            role: turn.role,
            channel: turn.channel,
            text: trimText(turn.text, 240),
            createdAt: turn.createdAt
        };
        const meta = compactTurnMeta(turn.meta);
        if (meta) compact.meta = meta;
        return compact;
    });
}

function compactTurnMeta(meta = {}) {
    const result = {};
    ['action', 'reason', 'providerOutcome', 'serverApplied'].forEach((key) => {
        if (meta[key] !== undefined && meta[key] !== null) result[key] = meta[key];
    });
    if (meta.actionResult && typeof meta.actionResult === 'object') {
        result.actionResult = {
            ok: meta.actionResult.ok === true,
            reason: meta.actionResult.reason || null,
            outcome: meta.actionResult.outcome || null,
            effect: meta.actionResult.effect || null
        };
    }
    return Object.keys(result).length ? result : null;
}

function compactJournal(events, max = 10) {
    return (events || []).slice(-max).map((event) => ({
        type: event.eventType,
        summary: trimText(event.summary, 220),
        count: Number(event.count || 1),
        weight: Number(event.weight || 1),
        updatedAt: event.updatedAt
    }));
}

async function assemble(input = {}) {
    const session = input.session;
    const status = input.status;
    const text = input.text || '';
    const requestContext = input.requestContext || {};
    const budget = Math.max(240, Number(input.budget || DEFAULT_BUDGET));
    const hardMaxTokens = Math.max(budget, Number(input.hardMaxTokens || HARD_MAX_TOKENS));
    const conversation = requestContext.conversation || null;
    const recentTurns = conversation?.recentTurns || [];
    const merchantSlice = session?.plan === 'merchant';
    const itemFollowup = /^(?:is (?:it|that)|are (?:they|those)|what about (?:it|that|them)|and (?:it|that|them)|which one)\b|^(?:\u0430\s+)?(?:\u043e\u043d|\u043e\u043d\u0430|\u043e\u043d\u043e|\u043e\u043d\u0438|\u044d\u0442\u043e\u0442|\u044d\u0442\u0430|\u044d\u0442\u043e|\u044d\u0442\u0438)\s/i.test(String(text || '').trim()) &&
        recentTurns.slice(-4).some((turn) => BotBrainContext.textRequestsInventory(turn?.text));
    const itemIntent = merchantSlice || BotBrainContext.textRequestsInventory(text) || itemFollowup;
    const learnedSkillMention = (session?.actor?.skillset?.fetchSkills?.() || []).some(skill => {
        const name = String(skill.model?.name || '').toLowerCase();
        return name.length >= 3 && String(text).toLowerCase().includes(name);
    });
    const skillIntent = !merchantSlice && (learnedSkillMention || textWants(text, /\b(skill|skills|heal|buff|haste|shield|might|wind walk|windwalk|spoil|sweep)\b|\u0441\u043a\u0438\u043b\u043b|\u043d\u0430\u0432\u044b\u043a|\u0445\u0438\u043b|\u0431\u0430\u0444|\u0445\u0430\u0441\u0442|\u0449\u0438\u0442|\u043c\u0430\u0439\u0442|\u0432\u0438\u043d\u0434|\u0441\u043f\u043e\u0439\u043b|\u0441\u0432\u0438\u043f/));
    let bot;
    try {
        bot = merchantSlice
            ? BotBrainContext.compactMerchantStatus(session, status, requestContext.playerSession)
            : BotBrainContext.compactStatus(session, status, text, {
                includeInventory: itemIntent,
                includeSkills: skillIntent,
                includeEquipment: itemIntent || skillIntent
            });
    } catch (_) {
        bot = merchantSlice && status?.available
            ? {
                available: true,
                name: status.name || session?.actor?.fetchName?.() || 'merchant',
                level: status.level || null,
                mode: status.mode || 'merchant',
                market: null,
                persona: status.persona || null,
                social: status.social || null
            }
            : status || { available: false };
    }

    let journal = [];
    if (session?.actor?.fetchId) {
        journal = await BotEventJournal.search({
            playerId: requestContext.playerSession?.actor?.fetchId?.() || requestContext.playerId,
            botId: session.actor.fetchId(),
            limit: input.journalLimit || 10
        });
        if (merchantSlice) {
            journal = journal.filter((event) => /(?:merchant|market|negotiation|trade|store)/i.test(String(event.eventType || '')));
        }
    }

    if (requestContext.playerSession && session) {
        // A session-wide last-social-event card may belong to another player.
        bot = { ...bot, social: await Knowledge.relationship(requestContext.playerSession, session) };
    }
    if (session) bot = { ...bot, ...await Knowledge.selfContext(session, text, conversation || {}) };
    const fragments = [
        {
            id: 'authoritative_events',
            priority: 85,
            value: compactJournal(journal, input.journalLimit || 10)
        }
    ].filter((fragment) => fragment.value !== null && fragment.value !== undefined);

    const bounded = Protocol.fitContext({ bot, conversation: {
        summary: conversation?.summary ? trimText(conversation.summary, 1200) : null,
        recentTurns: compactRecentTurns(conversation?.recentTurns, input.recentTurns || 8)
    }, contextFragments: fragments.map(({ id, value }) => ({ id, value })) }, hardMaxTokens);
    const selected = bounded.contextFragments || [];
    const serializedCost = estimateTokens(bounded);

    return {
        bot: bounded.bot,
        conversation: bounded.conversation,
        fragments: selected,
        omitted: bounded.omitted,
        journal,
        estimatedTokens: serializedCost,
        budget,
        hardMaxTokens,
        telemetry: DiagnosticConfig.developerDiagnostics ? {
            fragmentCount: selected.length,
            included: selected.map((fragment) => fragment.id),
            itemIntent,
            itemFollowup,
            skillIntent,
            contextSlice: merchantSlice ? 'merchant' : 'general',
            journalCount: journal.length,
            estimatedTokens: serializedCost
        } : { enabled: false }
    };
}

module.exports = {
    DEFAULT_BUDGET,
    HARD_MAX_TOKENS,
    estimateTokens,
    assemble
};
