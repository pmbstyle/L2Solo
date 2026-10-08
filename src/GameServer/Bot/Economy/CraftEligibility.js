'use strict';
const DataCache = invoke('GameServer/DataCache');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');

// ARCH-NOTE: native clan planning on saved members reached FirstPrice and
// failed because its CraftShopService facade lacked craftLevelFor. Share the
// original eligibility bodies/cache; do not duplicate the Create Item formula.
function isServiceCrafter(state = {}) {
    return BotRoles.isCrafterClass(state);
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

// Whether this character crafts the recipe: only crafter classes craft, even
// when another dwarf has Create Item from its class line.
function canCraft(state = {}, recipe = {}) {
    return isServiceCrafter(state) && craftLevelFor(state) >= Number(recipe.level || 0);
}

module.exports = { isServiceCrafter, craftLevelFor, canCraft };
