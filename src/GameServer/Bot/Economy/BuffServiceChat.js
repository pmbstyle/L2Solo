const Policy = invoke('GameServer/Bot/Economy/BuffServicePolicy');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const Town = invoke('GameServer/Bot/AI/TownPathfinder');
const TradeChat = invoke('GameServer/Bot/Economy/BotTradeChat');

const REPEAT_MS = 10 * 60 * 1000;
const SHIFT_MS = 10 * 60 * 1000;
const SHIFT_COOLDOWN_MS = 30 * 60 * 1000;
const SERVICE_SQUARE_RADIUS = 900;
const lastAt = new Map();

// A hot buffer's town shift: 10 minutes on the square, then 30 off. A window, not a
// situation (temporary: until the market redesign owns the buffer's earning as a leaf
// of its earning spot, with its own end).
function onDuty(session, timestamp = Date.now()) {
    const actor = session?.actor;
    if (!actor || !Policy.serviceClass(actor) || actor.isDead?.() || actor.state?.fetchCombats?.()
        || actor.state?.fetchCasts?.() || session.partyCompanion || session.hotBackgroundPartyId
        || session.activeTrade || session.chatArrivalActive || session.supplyErrandPhase
        || session.followPlayerSession || ['merchant', 'shopping', 'pk_hunting'].includes(session.plan)) return false;
    const town = Town.getTown({ locX: actor.fetchLocX(), locY: actor.fetchLocY(), locZ: actor.fetchLocZ() });
    // A service shift belongs on the public square. Starting it at a shop
    // counter, or during an errand, parks the buffer and blocks its departure.
    if (!town || Math.hypot(actor.fetchLocX() - town.center.locX, actor.fetchLocY() - town.center.locY) > SERVICE_SQUARE_RADIUS
        || Math.abs(actor.fetchLocZ() - town.center.locZ) > 128
        || session.townNpcApproach || session.townNpcSlot || session.townNpcQueue
        || session.spotRelocation || session.pendingTownTrip || session.shoppingRestock
        || session.townEscape || session.companionTownTransit || session.clanAllianceQuest
        || actor.state?.inMotion?.() || actor.state?.fetchTowards?.()) {
        session.buffServiceShiftUntil = 0;
        return false;
    }
    if (session.buffServiceShiftUntil && timestamp >= session.buffServiceShiftUntil) {
        session.buffServiceShiftUntil = 0;
        session.buffServiceNextShiftAt = timestamp + SHIFT_COOLDOWN_MS;
    }
    if (!session.buffServiceShiftUntil) {
        if (timestamp < Number(session.buffServiceNextShiftAt || 0)) return false;
        const skills = invoke('GameServer/Bot/AI/BotSupportPlanner').supportSkills(actor).filter(Policy.eligibleSkill);
        if (skills.length < 2) return false;
        session.buffServiceShiftUntil = timestamp + SHIFT_MS;
        actor.automation?.abortAll?.(actor);
    }
    return true;
}

function maybeAnnounce(session, timestamp = Date.now()) {
    if (!onDuty(session, timestamp)) return false;
    const actor = session.actor;
    const town = Town.getTown({ locX: actor.fetchLocX(), locY: actor.fetchLocY(), locZ: actor.fetchLocZ() });
    const id = Number(actor.fetchId());
    if (timestamp - (lastAt.get(id) || 0) < REPEAT_MS) return false;
    const skills = invoke('GameServer/Bot/AI/BotSupportPlanner').supportSkills(actor).filter(Policy.eligibleSkill);
    const price = Policy.priceFor({ provider: actor, recipient: { fetchClanId: () => 0 }, skills, town: true });
    const className = Roles.className(actor) || 'buffer';
    const text = `Lv${actor.fetchLevel()} ${className} buffs in ${town.name}: around ${price} Adena. Target me and type .buff; I open the trade.`;
    if (!TradeChat.deliver(session, text, timestamp)) return false;
    lastAt.set(id, timestamp);
    return true;
}

module.exports = { onDuty, maybeAnnounce };
