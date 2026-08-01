const BotToolAudit = invoke('GameServer/Bot/AI/BotToolAudit');

const definitions = new Map();

function text(value, max = 160) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function actorId(session) {
    return Number(session?.actor?.fetchId?.() || 0);
}

function playerId(context) {
    return Number(context?.requestContext?.playerSession?.actor?.fetchId?.() ||
        context?.requestContext?.playerId || 0) || null;
}

function turnId(context) {
    return text(
        context?.requestContext?.conversationTurn?.turnId ||
        context?.requestContext?.requestId ||
        context?.decision?.turnId,
        128
    ) || null;
}

function worldRevision(session) {
    const actor = session?.actor;
    if (!actor) return 'missing';
    const loc = (read) => {
        try { return Math.round(Number(read?.() || 0) / 25); } catch (_) { return 0; }
    };
    const inventory = actor.backpack?.fetchItems?.() || [];
    return [
        actorId(session),
        text(session.plan, 32),
        loc(actor.fetchLocX),
        loc(actor.fetchLocY),
        loc(actor.fetchLocZ),
        Number(actor.fetchDestId?.() || session.currentTargetId || 0),
        Number(actor.isDead?.() ? 1 : 0),
        Number(session.partyCompanion === true ? 1 : 0),
        Number(session.botStay === true ? 1 : 0),
        inventory.length
    ].join(':');
}

function isPkLocked(session, action) {
    return session?.plan === 'pk_hunting' && new Set([
        'follow_player', 'stay_here', 'hunt', 'rest', 'shop', 'move_to_spot'
    ]).has(action);
}

function isAvailable(definition, session) {
    if (typeof definition.available !== 'function') return true;
    return definition.available(session) !== false;
}

function register(definition) {
    if (!definition?.name) throw new Error('tool name is required');
    definitions.set(String(definition.name), {
        mutating: true,
        description: '',
        ...definition,
        name: String(definition.name)
    });
    return definitions.get(String(definition.name));
}

function descriptors(session = null) {
    return [...definitions.values()]
        .filter((definition) => isAvailable(definition, session))
        .map((definition) => ({
            action: definition.name,
            description: definition.description
        }));
}

function availableNames(session = null) {
    return descriptors(session).map((definition) => definition.action);
}

function audit(context, outcome, reason, meta = {}) {
    BotToolAudit.record({
        playerId: playerId(context),
        botId: actorId(context.session),
        turnId: turnId(context),
        toolName: context.decision?.action,
        outcome,
        reason,
        worldRevision: context.expectedWorldRevision || worldRevision(context.session),
        meta
    }).catch(() => {});
}

function result(applied, reason, extra = {}) {
    return { applied: !!applied, reason: text(reason, 160) || 'unknown', ...extra };
}

function execute(context = {}) {
    const session = context.session;
    const decision = context.decision || {};
    const action = text(decision.action, 64);
    const definition = definitions.get(action);
    const currentRevision = worldRevision(session);
    const expectedRevision = context.expectedWorldRevision || decision.worldRevision || null;
    const currentTurn = turnId(context);
    const mutationKey = currentTurn && action ? `${currentTurn}:${action}` : null;
    const mutationStore = session && (session.botToolExecutions ||= new Map());

    audit({ ...context, decision: { ...decision, action } }, 'requested', 'requested', {
        expectedRevision,
        currentRevision
    });

    if (!definition) {
        const rejected = result(false, 'unknown_tool');
        audit({ ...context, decision: { ...decision, action } }, 'rejected', rejected.reason);
        return rejected;
    }
    if (isPkLocked(session, action)) {
        const rejected = result(false, 'pk_hunting_autonomous');
        audit({ ...context, decision: { ...decision, action } }, 'rejected', rejected.reason);
        return rejected;
    }
    if (!isAvailable(definition, session)) {
        const rejected = result(false, 'tool_unavailable');
        audit({ ...context, decision: { ...decision, action } }, 'rejected', rejected.reason);
        return rejected;
    }
    if (expectedRevision && expectedRevision !== currentRevision) {
        const rejected = result(false, 'stale_world_state');
        audit({ ...context, decision: { ...decision, action } }, 'rejected', rejected.reason, {
            expectedRevision,
            currentRevision
        });
        return rejected;
    }

    if (mutationStore && mutationKey && mutationStore.has(mutationKey)) {
        const previous = mutationStore.get(mutationKey);
        audit({ ...context, decision: { ...decision, action } }, previous.applied ? 'applied' : 'rejected', 'idempotent_replay');
        return { ...previous, idempotent: true };
    }
    if (mutationStore && currentTurn && definition.mutating) {
        const priorMutation = [...mutationStore.entries()]
            .find(([key]) => key.startsWith(`${currentTurn}:`));
        if (priorMutation) {
            const rejected = result(false, 'one_mutation_per_turn');
            audit({ ...context, decision: { ...decision, action } }, 'rejected', rejected.reason);
            return rejected;
        }
    }

    if (typeof definition.authorize === 'function' && definition.authorize(context) === false) {
        const rejected = result(false, 'not_authorized');
        audit({ ...context, decision: { ...decision, action } }, 'rejected', rejected.reason);
        return rejected;
    }
    if (typeof definition.validate === 'function') {
        const validation = definition.validate(context);
        if (validation !== true && validation !== undefined) {
            const rejected = result(false, validation || 'invalid_arguments');
            audit({ ...context, decision: { ...decision, action } }, 'rejected', rejected.reason);
            return rejected;
        }
    }

    let outcome;
    try {
        outcome = definition.execute(context);
    } catch (error) {
        outcome = result(false, `tool_error:${text(error.message, 120)}`);
    }
    const normalized = result(outcome?.applied, outcome?.reason, outcome);
    if (mutationStore && mutationKey) mutationStore.set(mutationKey, normalized);
    audit({ ...context, decision: { ...decision, action } }, normalized.applied ? 'applied' : 'rejected', normalized.reason, {
        idempotent: false,
        currentRevision: worldRevision(session)
    });
    return normalized;
}

module.exports = {
    register,
    execute,
    descriptors,
    availableNames,
    worldRevision,
    reset() { definitions.clear(); }
};
