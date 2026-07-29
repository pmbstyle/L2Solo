// Lisvus L2AttackableAI starts every spawned attackable with global aggro -10
// and decrements it once per second.  A mob therefore cannot auto-attack for
// its first ten seconds in the world.
const SPAWN_AGGRO_DELAY_MS = 10000;
const AGGRO_RADIUS = 500;

function isHotBotSession(session) {
    return !!(
        session?.actor &&
        (session.constructor?.name === 'BotSession' || String(session.accountId || '').startsWith('bot_'))
    );
}

function isAlive(actor) {
    return !!actor && actor.isDead?.() !== true && actor.state?.fetchDead?.() !== true;
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

function engageNearby(session, actor, { world = invoke('GameServer/World/World'), now = Date.now(), npcs = null } = {}) {
    if (!isAlive(actor)) return [];

    const nearby = npcs || world.fetchNpcsInRadius(actor.fetchLocX(), actor.fetchLocY(), AGGRO_RADIUS);
    return nearby
        .filter((npc) => isEligible(npc, now) && distanceSquared(npc, actor) <= AGGRO_RADIUS * AGGRO_RADIUS)
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

    const ticker = setTicker(() => tickLiveActors(world), 1000);
    ticker?.unref?.();
    world.npcAggroTicker = ticker;
    return ticker;
}

module.exports = {
    AGGRO_RADIUS,
    SPAWN_AGGRO_DELAY_MS,
    isHotBotSession,
    isLiveSession,
    isEligible,
    engageNearby,
    armSpawnGrace,
    tickLiveActors,
    startAggroTicker
};
