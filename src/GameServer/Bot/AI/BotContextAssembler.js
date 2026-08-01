const BotBrainContext = invoke('GameServer/Bot/AI/BotBrainContext');
const BotEventJournal = invoke('GameServer/Bot/AI/BotEventJournal');

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
    return (turns || []).slice(-max).map((turn) => ({
        role: turn.role,
        channel: turn.channel,
        text: trimText(turn.text, 240),
        createdAt: turn.createdAt
    }));
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

function fitString(value, tokenBudget) {
    const maxChars = Math.max(32, tokenBudget * 4);
    return trimText(value, maxChars);
}

function fitFragment(fragment, remainingTokens) {
    if (estimateTokens(fragment.value) <= remainingTokens) return fragment;
    if (typeof fragment.value === 'string') {
        return { ...fragment, value: fitString(fragment.value, remainingTokens) };
    }
    const serialized = JSON.stringify(fragment.value);
    return {
        ...fragment,
        value: fitString(serialized, remainingTokens)
    };
}

async function assemble(input = {}) {
    const session = input.session;
    const status = input.status;
    const text = input.text || '';
    const requestContext = input.requestContext || {};
    const budget = Math.max(240, Number(input.budget || DEFAULT_BUDGET));
    const hardMaxTokens = Math.max(budget, Number(input.hardMaxTokens || HARD_MAX_TOKENS));
    const itemIntent = textWants(text, /\b(item|items|inventory|gear|weapon|armor|adena|shot|trade|loot|give|sell|buy)\b|инвент|вещ|шмот|оруж|брон|аден|сос|трейд|лут|дай|прод/);
    const skillIntent = textWants(text, /\b(skill|skills|heal|buff|haste|shield|might|wind walk|windwalk|spoil|sweep)\b|скилл|хил|баф|хаст|щит|майт|винд|спойл|свип/);
    let bot;
    try {
        bot = BotBrainContext.compactStatus(session, status, text, {
            includeInventory: itemIntent,
            includeSkills: skillIntent,
            includeEquipment: itemIntent || skillIntent
        });
    } catch (_) {
        bot = status || { available: false };
    }

    let journal = [];
    if (session?.actor?.fetchId) {
        journal = await BotEventJournal.recent({
            playerId: requestContext.playerSession?.actor?.fetchId?.() || requestContext.playerId,
            botId: session.actor.fetchId(),
            limit: input.journalLimit || 10
        });
    }

    const conversation = requestContext.conversation || null;
    const fragments = [
        { id: 'bot_state', priority: 100, value: bot },
        {
            id: 'conversation_summary',
            priority: 95,
            value: conversation?.summary ? trimText(conversation.summary, 1200) : null
        },
        {
            id: 'recent_dialogue',
            priority: 90,
            value: compactRecentTurns(conversation?.recentTurns, input.recentTurns || 8)
        },
        {
            id: 'authoritative_events',
            priority: 85,
            value: compactJournal(journal, input.journalLimit || 10)
        }
    ].filter((fragment) => fragment.value !== null && fragment.value !== undefined);

    const selected = [];
    let used = 0;
    fragments.sort((a, b) => b.priority - a.priority).forEach((fragment) => {
        const cost = estimateTokens(fragment.value);
        if (used + cost <= budget) {
            selected.push(fragment);
            used += cost;
            return;
        }
        const remaining = budget - used;
        if (remaining >= 48) {
            const fitted = fitFragment(fragment, remaining);
            const fittedCost = estimateTokens(fitted.value);
            if (fittedCost <= remaining) {
                selected.push(fitted);
                used += fittedCost;
            }
        }
    });

    // The status is kept as a separate compatibility field, but the bounded
    // fragments are the canonical prompt input. Never let a malformed fixture
    // or a long player name break the hard cap.
    let serializedCost = estimateTokens(selected.map((fragment) => ({ id: fragment.id, value: fragment.value })));
    if (serializedCost > hardMaxTokens) {
        const overflow = serializedCost - hardMaxTokens;
        const last = selected[selected.length - 1];
        if (last) {
            const fitted = fitFragment(last, Math.max(48, estimateTokens(last.value) - overflow));
            selected[selected.length - 1] = fitted;
            serializedCost = estimateTokens(selected.map((fragment) => ({ id: fragment.id, value: fragment.value })));
        }
    }

    return {
        bot,
        conversation,
        fragments: selected.map((fragment) => ({ id: fragment.id, value: fragment.value })),
        journal,
        estimatedTokens: Math.min(hardMaxTokens, serializedCost),
        budget,
        hardMaxTokens,
        telemetry: {
            fragmentCount: selected.length,
            included: selected.map((fragment) => fragment.id),
            itemIntent,
            skillIntent,
            journalCount: journal.length,
            estimatedTokens: Math.min(hardMaxTokens, serializedCost)
        }
    };
}

module.exports = {
    DEFAULT_BUDGET,
    HARD_MAX_TOKENS,
    estimateTokens,
    assemble
};
