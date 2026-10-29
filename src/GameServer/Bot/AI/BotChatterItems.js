const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');

// Routine travel and healing supplies do not need automatic chat reports.
const SUPPLY_IDS = new Set([736, 727, 1060, 1061, 1539, 1540]);
const SUPPLY_NAMES = /\b(?:scrolls?\s+of\s+escape|soe|healing\s+potions?)\b/i;

function mentionsRoutineSupply(text) {
    return SUPPLY_NAMES.test(String(text || ''));
}

function isRoutineSupply(selfId, name) {
    if (SUPPLY_IDS.has(Number(selfId)) || mentionsRoutineSupply(name)) return true;
    if (!(Number(selfId) > 0)) return false;
    const item = ItemTemplateIndex.find(invoke('GameServer/DataCache').items, selfId);
    return mentionsRoutineSupply(item?.template?.name);
}

module.exports = { isRoutineSupply, mentionsRoutineSupply };
