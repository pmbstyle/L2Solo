// Lisvus L2AttackableAI starts every spawned attackable with global aggro -10
// and decrements it once per second.  A mob therefore cannot auto-attack for
// its first ten seconds in the world.
const SPAWN_AGGRO_DELAY_MS = 10000;
const AggroRange = invoke('GameServer/Npc/NpcAggroRange');
// The author's range for an NPC without a C4 one (NpcAggroRange).
const AGGRO_RADIUS = AggroRange.DEFAULT_RANGE;
const MAX_AGGRO_Z_DIFFERENCE = 400;
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const TownGuard = invoke('GameServer/Npc/TownGuard');

function isHotBotSession(session) {
    return !!(
        session?.actor &&
        (session.constructor?.name === 'BotSession' || String(session.accountId || '').startsWith('bot_'))
    );
}

function isAlive(actor) {
    return !!actor && actor.isDead?.() !== true && actor.state?.fetchDead?.() !== true && actor.fakeDeath !== true;
}

function isLiveSession(session) {
    return !!(
        session?.actor &&
        session.actor.fetchIsOnline?.() !== false &&
        isAlive(session.actor)
    );
}

function isEligible(npc, now = Date.now()) {
    return !!(
        npc?.fetchHostile?.() &&
        !TownGuard.isTownGuard(npc) &&
        npc.state?.fetchDead?.() !== true &&
        npc.state?.fetchCombats?.() !== true &&
        Number(npc.aggroEligibleAt || 0) <= now
    );
}

function distanceSquared(first, second) {
    const dx = first.fetchLocX() - second.fetchLocX();
    const dy = first.fetchLocY() - second.fetchLocY();
    return (dx * dx) + (dy * dy);
}

function isSilentMoving(actor, now = Date.now()) {
    if (actor?.silentMoving === true) return true;
    return Object.values(actor?.effects || {}).some((effect) => (
        effect?.stats?.silentMoving === true &&
        (!effect.expiresAt || Number(effect.expiresAt) > now)
    ));
}

// How far this NPC sees a target (NpcAggroRange: its C4 range, else 500).
function aggroRadius(npc) {
    return AggroRange.of(Number(npc?.fetchSelfId?.() || 0));
}

function canEngage(npc, actor, now = Date.now()) {
    if (!isAlive(actor) || !isEligible(npc, now)) return false;
    if (isSilentMoving(actor, now) && npc.fetchIsRaidBoss?.() !== true) return false;
    const range = aggroRadius(npc);
    if (distanceSquared(npc, actor) > range * range) return false;
    if (Math.abs(npc.fetchLocZ() - actor.fetchLocZ()) > MAX_AGGRO_Z_DIFFERENCE) return false;

    return GeodataEngine.hasLineOfSight(
        npc.fetchLocX(), npc.fetchLocY(), npc.fetchLocZ(),
        actor.fetchLocX(), actor.fetchLocY(), actor.fetchLocZ()
    );
}

function engageNearby(session, actor, { world = invoke('GameServer/World/World'), now = Date.now(), npcs = null } = {}) {
    if (!isAlive(actor)) return [];

    const nearby = npcs || world.fetchNpcsInRadius(actor.fetchLocX(), actor.fetchLocY(), AggroRange.MAX_RANGE);
    return nearby
        .filter((npc) => canEngage(npc, actor, now))
        .map((npc) => {
            npc.enterCombatState(session, actor);
            return npc;
        });
}

function armSpawnGrace(npc, now = Date.now()) {
    if (!npc) return 0;
    npc.aggroEligibleAt = now + SPAWN_AGGRO_DELAY_MS;
    return npc.aggroEligibleAt;
}

// Lisvus runs L2AttackableAI once per second. Sweep live actors at the same
// cadence: this catches both a bot entering range and a stationary actor
// whose nearby NPC has just completed its spawn grace, without doing a world
// grid scan for every movement interpolation frame.
function tickLiveActors(world = invoke('GameServer/World/World'), now = Date.now()) {
    return (world?.user?.sessions || [])
        .filter(isLiveSession)
        .flatMap((session) => engageNearby(session, session.actor, { world, now }));
}

function startAggroTicker(world = invoke('GameServer/World/World'), {
    setTicker = setInterval
} = {}) {
    if (!world || world.npcAggroTicker) return world?.npcAggroTicker;

    const ticker = setTicker(() => {
        tickLiveActors(world);
        invoke('GameServer/Npc/NpcWander').tick(world);
    }, 1000);
    ticker?.unref?.();
    world.npcAggroTicker = ticker;
    return ticker;
}

module.exports = {
    AGGRO_RADIUS,
    MAX_AGGRO_RADIUS: AggroRange.MAX_RANGE,
    aggroRadius,
    SPAWN_AGGRO_DELAY_MS,
    MAX_AGGRO_Z_DIFFERENCE,
    isHotBotSession,
    isLiveSession,
    isEligible,
    canEngage,
    engageNearby,
    armSpawnGrace,
    tickLiveActors,
    startAggroTicker
};
