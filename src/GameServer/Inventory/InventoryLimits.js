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
    const stats = state.stats || {};
    const classId = stats.classId ?? stats.coldCombat?.classId ?? state.classId;
    const template = typeof invoke === 'function'
        ? invoke('GameServer/DataCache').classTemplates?.find(row => Number(row.classId) === Number(classId)) : null;
    const race = inputs.race ?? template?.template?.race ?? stats.race ?? state.race;
    const skills = inputs.skills ?? (typeof invoke === 'function'
        ? invoke('GameServer/Bot/Population/ColdCombatProfile').skillsFor(state) : []);
    return capacity(race, skills.find(skill => Number(skill.selfId) === 1372)?.level);
}

module.exports = { MAX_CAPACITY, capacity, forActor, forState };
