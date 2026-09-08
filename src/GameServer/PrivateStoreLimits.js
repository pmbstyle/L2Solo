// C4 Lisvus: Other.properties and Expand Trade (1370), levels 1..8.
function tradeLimit(race, level, type) {
    const bonus = Number.isInteger(Number(level)) ? Math.max(0, Math.min(8, Number(level))) : 0;
    return (Number(type) === 3 ? 4 : 3) + (Number(race) === 4 ? 1 : 0) + bonus;
}

function skillLevel(actor, id) {
    return Number(actor?.skillset?.fetchSkill?.(id)?.fetchLevel?.() || 0);
}

function forActor(actor, type) {
    return tradeLimit(actor?.fetchRace?.(), skillLevel(actor, 1370), type);
}

module.exports = { tradeLimit, skillLevel, forActor };
