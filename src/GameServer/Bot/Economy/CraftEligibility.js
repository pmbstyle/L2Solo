'use strict';
const DataCache = invoke('GameServer/DataCache');

// ARCH-NOTE: native clan planning on saved members reached FirstPrice and
// failed because its CraftShopService facade lacked craftLevelFor. Share the
// original eligibility bodies/cache; do not duplicate the Create Item formula.
function isServiceCrafter(state = {}) {
    const level = craftLevelFor(state);
    return Number.isFinite(level) && level > 0;
}

// Craft level = the Create Item level the class line has learned by this
// character level, read from the skill tree like a hot character's skills: a
// Warsmith keeps the levels it learned as an Artisan. Kept per class, indexed
// by character level.
const CREATE_ITEM_SKILL_ID = 172;
const craftLevelRows = new Map();
let craftLevelsTree = null;
let ColdCombatProfile = null;

function craftLevelFor(state = {}) {
    // A hot actor passes the level of the skill it has learned.
    const learned = state.craftLevel ?? state.stats?.dwarvenCraftLevel;
    if (learned !== undefined && learned !== null) return Number(learned) || 0;
    const classId = Number(state.classId || state.stats?.classId || 0);
    const level = Number(state.level || 1);
    if (craftLevelsTree !== DataCache.skillTree) {
        craftLevelRows.clear();
        craftLevelsTree = DataCache.skillTree;
    }
    let row = craftLevelRows.get(classId);
    if (!row) craftLevelRows.set(classId, row = []);
    if (row[level] === undefined) {
        ColdCombatProfile ||= invoke('GameServer/Bot/Population/ColdSkillTree');
        row[level] = ColdCombatProfile.treeSkillLevel(classId, level, CREATE_ITEM_SKILL_ID);
    }
    return row[level];
}

// Create Item capability is shared by every class that has the skill.
function canCraft(state = {}, recipe = {}) {
    const level = craftLevelFor(state), required = Number(recipe.level);
    return Number.isFinite(level) && Number.isFinite(required) && required > 0 && level >= required;
}

module.exports = { isServiceCrafter, craftLevelFor, canCraft };
