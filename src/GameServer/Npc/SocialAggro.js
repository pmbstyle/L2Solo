const World     = invoke('GameServer/World/World');
const SpeckMath = invoke('GameServer/SpeckMath');

function clanName(npc) {
    return String(npc?.fetchClanName?.() || '').trim();
}

function helpRadius(npc) {
    return Math.max(0, Number(npc?.fetchClanHelpRadius?.()) || 0);
}

function actorId(actor) {
    return Number(actor?.fetchId?.()) || 0;
}

function distance2d(a, b) {
    return new SpeckMath.Point(a.fetchLocX(), a.fetchLocY()).distance(
        new SpeckMath.Point(b.fetchLocX(), b.fetchLocY())
    );
}

function canAssist(helper, attackedNpc, attacker, attackedClan, radius) {
    if (!helper || helper === attackedNpc) return false;
    if (actorId(helper) === actorId(attackedNpc)) return false;
    if (!helper.fetchAttackable?.() || helper.isDead?.()) return false;
    if (helper.state?.fetchDead?.() || helper.state?.fetchCombats?.()) return false;
    if (clanName(helper) !== attackedClan) return false;
    if (actorId(attacker) && helper.fetchDestId?.() === actorId(attacker)) return false;
    if (!helper.fetchLocX || !attackedNpc.fetchLocX) return false;
    return distance2d(helper, attackedNpc) <= radius;
}

function notifyClan(session, attackedNpc, attacker) {
    const attackedClan = clanName(attackedNpc);
    const radius = helpRadius(attackedNpc);
    if (!attackedClan || radius <= 0 || !attacker || attacker.state?.fetchDead?.()) {
        return [];
    }

    const nearby = typeof World.fetchNpcsInRadius === 'function'
        ? World.fetchNpcsInRadius(attackedNpc.fetchLocX(), attackedNpc.fetchLocY(), radius)
        : [];

    const helpers = nearby.filter((helper) => canAssist(helper, attackedNpc, attacker, attackedClan, radius));
    helpers.forEach((helper) => {
        helper.enterCombatState(session, attacker);
    });
    return helpers;
}

module.exports = {
    notifyClan,
    canAssist
};
