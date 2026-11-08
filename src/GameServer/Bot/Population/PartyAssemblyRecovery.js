const WAIT_LIMIT_MS = 5 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;
const REASON = 'party_assembly_timeout';
const MAX_ATTEMPTS = 12;
const PROCESS_STARTED_AT = Date.now() - Math.floor(process.uptime() * 1000);

function record(party, timestamp) {
    const previous = party.stats?.assemblyWait;
    const gap = timestamp - Number(previous?.lastAt || timestamp);
    // A delayed scheduler retry is still an observed failure. Charge at most
    // one minute per attempt; the first retry after a restart charges no downtime.
    const elapsed = gap > 0 && Number(previous?.lastAt || 0) >= PROCESS_STARTED_AT ? Math.min(gap, 60000) : 0;
    return { since: previous?.since || timestamp, lastAt: timestamp,
        attempts: Number(previous?.attempts || 0) + 1,
        waitedMs: Number(previous?.waitedMs || 0) + elapsed };
}

function expired(party) {
    const wait = party?.stats?.assemblyWait;
    // Also bound legacy waits whose old accounting never advanced waitedMs.
    return Number(wait?.attempts || 0) >= MAX_ATTEMPTS
        || Number(wait?.attempts || 0) >= 6 && Number(wait?.waitedMs || 0) >= WAIT_LIMIT_MS;
}

function coolingDown(state, timestamp = Date.now()) {
    const request = state?.stats?.partyRequest;
    return (request?.deferReason === REASON
        || request?.status === 'deferred' && request.clanGoalKey
            && request.clanGoalKey === state.stats?.clanPartyObjective?.clanGoalKey
        || request?.materialParty === true && request.deferReason === 'party_material_route_unavailable')
        && Number(request.deferredUntil || 0) > timestamp;
}

module.exports = { WAIT_LIMIT_MS, RETRY_MS, REASON, record, expired, coolingDown };
