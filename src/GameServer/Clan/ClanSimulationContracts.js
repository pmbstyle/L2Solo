const ClanSimulationConfig = invoke('GameServer/Clan/ClanSimulationConfig');

const STATE_VERSION = 1;
const GOAL_STATUSES = Object.freeze(['planned', 'preparing', 'executing', 'blocked', 'completed']);
const GOAL_TYPES = Object.freeze(['adena', 'item', 'readiness', 'equipment', 'level']);
const EXECUTION_PLANS = Object.freeze(['warehouse', 'market', 'craft', 'farm', 'prepare']);

const REASON_CODES = Object.freeze({
    FOUNDER_LOW_LEVEL: 'founder_low_level',
    FOUNDER_NO_FIRST_PROFESSION: 'founder_no_first_profession',
    FOUNDER_ALREADY_IN_CLAN: 'founder_already_in_clan',
    FOUNDER_NO_QUORUM: 'founder_no_quorum',
    FOUNDER_TRAITS: 'founder_traits',
    FOUNDER_PARTY_HISTORY: 'founder_party_history',
    FOUNDER_EXISTING_CLAN: 'founder_existing_clan',
    FOUNDER_CLAN_LIMIT: 'founder_clan_limit',
    FOUNDER_POPULATION_LIMIT: 'founder_population_limit',
    JOIN_CLAN_FULL: 'join_clan_full',
    JOIN_POPULATION_LIMIT: 'join_population_limit',
    JOIN_UNSUITABLE: 'join_unsuitable',
    JOIN_STATIC_SERVICE_CONFLICT: 'join_static_service_conflict',
    CONTRIBUTION_NO_DISPOSABLE_ADENA: 'contribution_no_disposable_adena',
    CONTRIBUTION_RESERVED: 'contribution_reserved',
    CONTRIBUTION_APPLIED: 'contribution_applied',
    CONTRIBUTION_LEVEL_READY: 'contribution_level_ready',
    CONTRIBUTION_LEVEL_UP: 'contribution_level_up',
    WAREHOUSE_ITEM_RESERVED: 'warehouse_item_reserved',
    WAREHOUSE_DUPLICATE_RECIPE: 'warehouse_duplicate_recipe',
    WAREHOUSE_NO_STOCK: 'warehouse_no_stock',
    WAREHOUSE_RESERVATION_EXISTS: 'warehouse_reservation_exists',
    WAREHOUSE_TRANSFER_FAILED: 'warehouse_transfer_failed',
    MARKET_NO_OFFER: 'market_no_offer',
    MARKET_PRICE_UNACCEPTABLE: 'market_price_unacceptable',
    PARTY_NOT_READY: 'party_not_ready',
    PARTY_OPERATION_STARTED: 'party_operation_started',
    PARTY_OPERATION_SUCCEEDED: 'party_operation_succeeded',
    PARTY_OPERATION_FAILED: 'party_operation_failed',
    PARTY_OPERATION_ACTIVE: 'party_operation_active',
    PARTY_MEMBER_RESERVATION_CONFLICT: 'party_member_reservation_conflict',
    PARTY_REWARD_APPLIED: 'party_reward_applied',
    PARTY_CATASTROPHIC_FAILURE: 'party_catastrophic_failure',
    GOAL_BLOCKED: 'goal_blocked',
    GOAL_REPLANNED: 'goal_replanned',
    GOAL_COMPLETED: 'goal_completed',
    OWNERSHIP_CONFLICT: 'ownership_conflict',
    STALE_SNAPSHOT: 'stale_snapshot',
    BUDGET_EXHAUSTED: 'budget_exhausted'
});

const KNOWN_REASON_CODES = new Set(Object.values(REASON_CODES));

function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function positiveInteger(value) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : null;
}

function nonNegativeInteger(value, fallback = 0) {
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function object(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function ids(values) {
    return [...new Set((Array.isArray(values) ? values : [])
        .map(positiveInteger)
        .filter(Boolean))].sort((a, b) => a - b);
}

function reasonCodes(values) {
    return [...new Set((Array.isArray(values) ? values : []).map(text).filter(Boolean))].slice(0, 8);
}

function normalizePlan(plan) {
    if (!plan || typeof plan !== 'object') return null;
    const kind = text(plan.kind);
    if (!EXECUTION_PLANS.includes(kind)) return null;
    return {
        kind,
        sourceId: positiveInteger(plan.sourceId),
        beneficiaryId: positiveInteger(plan.beneficiaryId),
        selectedAt: Number(plan.selectedAt) || null
    };
}

function normalizeGoal(goal, timestamp = Date.now()) {
    if (!goal || typeof goal !== 'object') return null;
    const type = text(goal.type);
    if (!GOAL_TYPES.includes(type)) return null;

    const required = nonNegativeInteger(goal.required, 0);
    if (required <= 0) return null;

    return {
        type,
        target: object(goal.target),
        required,
        progress: Math.min(required, nonNegativeInteger(goal.progress, 0)),
        plan: normalizePlan(goal.plan),
        assignedMemberIds: ids(goal.assignedMemberIds),
        partyId: text(goal.partyId) || null,
        catastrophicFailures: nonNegativeInteger(goal.catastrophicFailures, 0),
        status: GOAL_STATUSES.includes(goal.status) ? goal.status : 'planned',
        reasonCodes: reasonCodes(goal.reasonCodes),
        createdAt: Number(goal.createdAt) || timestamp,
        updatedAt: Number(goal.updatedAt) || timestamp
    };
}

function normalizeState(state = {}, timestamp = Date.now()) {
    const clanId = positiveInteger(state.clanId);
    if (!clanId) return null;

    return {
        version: STATE_VERSION,
        clanId,
        leaderId: positiveInteger(state.leaderId),
        level: Math.max(0, Math.min(3, nonNegativeInteger(state.level, 0))),
        memberIds: ids(state.memberIds),
        goal: normalizeGoal(state.goal, timestamp),
        contributionLedgerVersion: nonNegativeInteger(state.contributionLedgerVersion, 0),
        warehouseRevision: nonNegativeInteger(state.warehouseRevision, 0),
        updatedAt: Number(state.updatedAt) || timestamp
    };
}

function isReasonCode(code) {
    return KNOWN_REASON_CODES.has(text(code));
}

module.exports = {
    STATE_VERSION,
    GOAL_STATUSES,
    GOAL_TYPES,
    EXECUTION_PLANS,
    REASON_CODES,
    KNOWN_REASON_CODES,
    normalizeGoal,
    normalizeState,
    isReasonCode,
    config: ClanSimulationConfig
};
