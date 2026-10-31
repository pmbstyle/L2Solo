const Response = invoke('GameServer/Network/Response');
const ConsoleText = invoke('GameServer/ConsoleText');

const ARROWS = { none: 17, d: 1341, c: 1342, b: 1343, a: 1344, s: 1345 };

function reject(session, actor, message) {
    actor.storedAttack = null;
    actor.state.setHits(false);
    ConsoleText.transmit(session, message);
    session.dataSendToMe(Response.actionFailed());
    return false;
}

// A shot's arrow and MP. A bot pays the MP as a player does (user 10-29);
// its arrows stay free: bot ammunition provisioning is not implemented.
function consume(session, actor, rng = Math.random) {
    const backpack = actor.backpack;
    const weapon = backpack.fetchEquippedWeapon?.();
    const bot = !!session.botSession;
    const arrowId = ARROWS[String(weapon?.fetchRank?.() || '').toLowerCase()];
    const arrow = !bot && arrowId && backpack.fetchItemFromSelfId(arrowId);
    if (!bot && (!arrow || arrow.fetchAmount() < 1 || arrow.fetchPetLocked?.()))
        return reject(session, actor, ConsoleText.caption.depletedArrows);
    const mp = invoke('GameServer/Items/C4WeaponSA').bowMpCost(weapon, rng);
    if (actor.fetchMp() < mp)
        return reject(session, actor, ConsoleText.caption.depletedMp);
    let consumed = bot;
    if (!bot) backpack.deleteItem(session, arrow.fetchId(), 1, () => { consumed = true; });
    if (!consumed) return false;
    actor.setMp(actor.fetchMp() - mp);
    actor.statusUpdateVitals(actor);
    return true;
}

module.exports = { consume };
