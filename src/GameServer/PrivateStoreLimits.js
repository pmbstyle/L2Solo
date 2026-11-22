// C4 Lisvus: Other.properties and Expand Trade (1370), levels 1..8.
const EXPAND_TRADE = 1370;

function tradeLimit(race, level, type) {
    const bonus = Number.isInteger(Number(level)) ? Math.max(0, Math.min(8, Number(level))) : 0;
    return (Number(type) === 3 ? 4 : 3) + (Number(race) === 4 ? 1 : 0) + bonus;
}

function skillLevel(actor, id) {
    return Number(actor?.skillset?.fetchSkill?.(id)?.fetchLevel?.() || 0);
}

function forActor(actor, type) {
    return tradeLimit(actor?.fetchRace?.(), skillLevel(actor, EXPAND_TRADE), type);
}

// A bot's state (plain data, either thread): its race is its class's (stats.race
// else), its skills its kit's learned ones (ColdCombatProfile.skillsFor); inputs
// may name either. stateRace / stateSkillLevel are read as an actor's are.
function stateRace(state = {}, inputs = {}) {
    const stats = state.stats || {};
    const classId = stats.classId ?? stats.coldCombat?.classId ?? state.classId;
    const template = typeof invoke === 'function'
        ? invoke('GameServer/DataCache').classTemplates?.find(row => Number(row.classId) === Number(classId)) : null;
    return inputs.race ?? template?.template?.race ?? stats.race ?? state.race;
}

function stateSkillLevel(state = {}, id, inputs = {}) {
    const skills = inputs.skills ?? (typeof invoke === 'function'
        ? invoke('GameServer/Bot/Population/ColdCombatProfile').skillsFor(state) : []);
    return Number(skills.find(skill => Number(skill.selfId) === Number(id))?.level || 0);
}

// A bot's private store slots of `type` (1 sell, 3 buy): the player's rule.
function forState(state, type, inputs = {}) {
    return tradeLimit(stateRace(state, inputs), stateSkillLevel(state, EXPAND_TRADE, inputs), type);
}

module.exports = { EXPAND_TRADE, tradeLimit, skillLevel, forActor, stateRace, stateSkillLevel, forState };
