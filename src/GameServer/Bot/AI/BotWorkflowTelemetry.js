const LangfuseTracing = invoke('GameServer/Bot/AI/LangfuseTracing');

function text(value, max = 160) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function recordSupply(workflowId, phase, payload = {}, outcome = 'completed', reason = null) {
    if (!workflowId) return null;
    const safePayload = {
        workflowId: text(workflowId, 128),
        phase: text(phase, 64),
        ...payload
    };
    const observation = LangfuseTracing.startObservation(
        `bot.workflow.supply.${safePayload.phase}`,
        safePayload,
        {
            workflowId: safePayload.workflowId,
            phase: safePayload.phase,
            botId: payload.botId || null,
            playerId: payload.playerId || null,
            outcome,
            reason: reason || null
        },
        'workflow'
    );
    observation?.end({ ...safePayload, outcome, reason: reason || null },
        outcome === 'failed' || outcome === 'rejected'
            ? LangfuseTracing.observationStatus({ applied: false, reason: reason || outcome })
            : {});
    return safePayload;
}

module.exports = { recordSupply };
