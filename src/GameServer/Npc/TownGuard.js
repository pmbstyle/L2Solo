const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');

const TOWN_GUARD_NAME = /^(?:Gludio|Dion|Giran|Oren|Aden|Goddard|Rune|Innadril|Heine)\b.*\b(?:Guard|Knight|Wizard|Cleric)\b|^Guard$/i;
const AGGRO_RADIUS = 1000;

function isTownGuard(npc) {
    return !!(npc?.fetchName?.() && TOWN_GUARD_NAME.test(npc.fetchName()));
}

function distanceSquared(first, second) {
    const dx = first.fetchLocX() - second.fetchLocX();
    const dy = first.fetchLocY() - second.fetchLocY();
    return dx * dx + dy * dy;
}

function canEngage(guard, actor) {
    if (!isTownGuard(guard) || actor?.fetchKarma?.() <= 0 || guard.state?.fetchDead?.()) return false;
    if (distanceSquared(guard, actor) > AGGRO_RADIUS * AGGRO_RADIUS) return false;
    return GeodataEngine.hasLineOfSight(
        guard.fetchLocX(), guard.fetchLocY(), guard.fetchLocZ(),
        actor.fetchLocX(), actor.fetchLocY(), actor.fetchLocZ()
    );
}

function engageNearby(session, actor, npcs) {
    if (actor?.fetchKarma?.() <= 0) return [];
    return (npcs || []).filter((npc) => canEngage(npc, actor)).map((guard) => {
        guard.enterCombatState(session, actor);
        return guard;
    });
}

module.exports = { AGGRO_RADIUS, isTownGuard, canEngage, engageNearby };
