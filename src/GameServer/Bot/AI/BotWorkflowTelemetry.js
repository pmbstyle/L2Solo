const LangfuseTracing = invoke('GameServer/Bot/AI/LangfuseTracing');
const activeWorkflows = new Map();

function text(value, max = 160) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function recordSupply(workflowId, phase, payload = {}, outcome = 'completed', reason = null, options = {}) {
    if (!workflowId) return null;
    const safePayload = {
        workflowId: text(workflowId, 128),
        phase: text(phase, 64),
        ...payload
    };
    const metadata = {
        workflowId: safePayload.workflowId,
        phase: safePayload.phase,
        botId: payload.botId || null,
        playerId: payload.playerId || null,
        outcome,
        reason: reason || null
    };
    let workflow = activeWorkflows.get(safePayload.workflowId);
    if (!workflow) {
        const root = LangfuseTracing.startObservation(
            'bot.workflow.supply',
            safePayload,
            { ...metadata, workflowPhase: 'root' },
            'chain'
        );
        workflow = { root, startedAt: Date.now() };
        activeWorkflows.set(safePayload.workflowId, workflow);
    }

    // A real Langfuse child observation keeps every phase under one trace.
    // Test/fallback implementations may only expose startObservation; keep
    // the phase observable there as well instead of dropping telemetry.
    const observation = workflow.root?.child
        ? workflow.root.child(`bot.workflow.supply.${safePayload.phase}`, safePayload, metadata, 'span')
        : LangfuseTracing.startObservation(
            `bot.workflow.supply.${safePayload.phase}`,
            safePayload,
            metadata,
            'span'
        );
    observation?.end({ ...safePayload, outcome, reason: reason || null },
        outcome === 'failed' || outcome === 'rejected'
            ? LangfuseTracing.observationStatus({ applied: false, reason: reason || outcome })
            : {});

    const terminal = options.terminal === true;
    if (terminal) {
        workflow.root?.end({
            workflowId: safePayload.workflowId,
            outcome,
            reason: reason || null,
            completedPhase: safePayload.phase,
            durationMs: Math.max(0, Date.now() - workflow.startedAt)
        }, outcome === 'failed' || outcome === 'rejected' || outcome === 'cancelled'
            ? LangfuseTracing.observationStatus({ applied: false, reason: reason || outcome })
            : {});
        activeWorkflows.delete(safePayload.workflowId);
    }
    return safePayload;
}

module.exports = { recordSupply };
