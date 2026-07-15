const PHASES = new Set(['cold', 'warm', 'hot']);

function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function positiveInteger(value) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizeEvent(event = {}, now = Date.now()) {
    const type = text(event.type);
    const source = text(event.source);
    if (!type || !source) return null;

    return {
        id: text(event.id) || `${source}:${type}:${now}:${Math.random().toString(36).slice(2, 8)}`,
        type,
        source,
        subjectId: positiveInteger(event.subjectId),
        occurredAt: Number(event.occurredAt) || now,
        expiresAt: Number(event.expiresAt) || null,
        payload: event.payload && typeof event.payload === 'object' ? { ...event.payload } : {}
    };
}

function normalizeProposal(proposal = {}, now = Date.now()) {
    const source = text(proposal.source);
    const kind = text(proposal.kind);
    const action = text(proposal.action);
    const subjectId = positiveInteger(proposal.subjectId);
    if (!source || !kind || !action || !subjectId) return null;

    const priority = Math.max(0, Math.min(100, Number(proposal.priority) || 0));
    const expiresAt = Number(proposal.expiresAt) || now + 60000;
    if (expiresAt <= now) return null;

    return {
        id: text(proposal.id) || `${source}:${kind}:${subjectId}:${now}:${Math.random().toString(36).slice(2, 8)}`,
        source,
        kind,
        action,
        subjectId,
        priority,
        expiresAt,
        snapshotRevision: Number(proposal.snapshotRevision) || 0,
        payload: proposal.payload && typeof proposal.payload === 'object' ? { ...proposal.payload } : {}
    };
}

function validateProposal(proposal, snapshot = {}, now = Date.now()) {
    const normalized = normalizeProposal(proposal, now);
    if (!normalized) return { accepted: false, reason: 'invalid_proposal', proposal: null };
    if (normalized.expiresAt <= now) return { accepted: false, reason: 'expired', proposal: normalized };
    if (snapshot.characterId && Number(snapshot.characterId) !== normalized.subjectId) {
        return { accepted: false, reason: 'subject_mismatch', proposal: normalized };
    }
    if (snapshot.phase && !PHASES.has(snapshot.phase)) {
        return { accepted: false, reason: 'invalid_snapshot_phase', proposal: normalized };
    }
    if (snapshot.revision && normalized.snapshotRevision && Number(snapshot.revision) !== normalized.snapshotRevision) {
        return { accepted: false, reason: 'stale_snapshot', proposal: normalized };
    }

    return { accepted: true, reason: null, proposal: normalized };
}

module.exports = {
    PHASES,
    normalizeEvent,
    normalizeProposal,
    validateProposal
};
