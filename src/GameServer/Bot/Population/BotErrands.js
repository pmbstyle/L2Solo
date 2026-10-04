// Stats flags that mean a bot is in the middle of an errand: a warehouse
// visit, a market or craft trip, a player's request, a Mammon visit, a clan
// duty or a PvP fight. Each decision that must not interrupt such work lists
// the flags it respects and asks busyWith for the first one that is set. The
// lists differ on purpose (tests/test_bot_errand_flags.js pins every one).
const GROUPS = {
    warehouseWorkflow: 'warehouse',
    warehouseErrand: 'warehouse',
    marketStore: 'market',
    marketReturn: 'market',
    partyMarketReturn: 'market',
    craftShop: 'craft',
    craftStationId: 'craft',
    craftReturn: 'craft',
    supplyErrand: 'player',
    mammonReturn: 'mammon',
    clanPartyObjective: 'clan',
    clanGoal: 'clan',
    clanAllianceQuest: 'clan',
    pvpEncounter: 'pvp'
};

// The cold simulation claim (the owner, the SQL claim row and the worker's
// lifecycle). craftReturn is a saved destination, not an outstanding craft.
const COLD_CLAIM = ['warehouseWorkflow', 'warehouseErrand', 'marketStore', 'marketReturn',
    'craftShop', 'craftStationId', 'supplyErrand'];
const CLAIM_REASONS = {
    warehouse: 'warehouse_state',
    market: 'market_state',
    craft: 'craft_state',
    player: 'player_workflow'
};

// clanGoal lives in the gear plan, every other flag directly in stats.
function flagValue(stats, flag) {
    return flag === 'clanGoal' ? stats.equipmentPlan?.clanGoal : stats[flag];
}

// The group of the first flag in `flags` that is set (JavaScript truthiness),
// or null. A flag missing from GROUPS names itself, so it still counts.
function busyWith(state, flags) {
    const stats = state?.stats;
    if (!stats) return null;
    for (const flag of flags) {
        if (flagValue(stats, flag)) return GROUPS[flag] || flag;
    }
    return null;
}

module.exports = { GROUPS, COLD_CLAIM, CLAIM_REASONS, busyWith };
