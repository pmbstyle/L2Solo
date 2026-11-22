const Skills = require('../PrivateStoreLimits');

// C4 inventory size and Expand Inventory (1372), matching ExStorageMaxCount.
function capacity(race, skillLevel = 0) {
    return (Number(race) === 4 ? 100 : 80) + Math.max(0, Math.min(8, Number(skillLevel) || 0)) * 6;
}

// Bounds item request batches without excluding a fully expanded dwarf bag.
const MAX_CAPACITY = capacity(4, 8);

function forActor(actor) {
    return capacity(actor?.fetchRace?.(), Skills.skillLevel(actor, 1372));
}

function forState(state = {}, inputs = {}) {
    return capacity(Skills.stateRace(state, inputs), Skills.stateSkillLevel(state, 1372, inputs));
}

module.exports = { MAX_CAPACITY, capacity, forActor, forState };
