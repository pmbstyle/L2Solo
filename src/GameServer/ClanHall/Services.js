const Runtime = require('./Runtime');
const support = require('../../../data/ClanHalls/support.json');
const Effects = invoke('GameServer/Effects/EffectStore');
// What a bot lacks and whether it needs the hall: shared with the cold worker.
const VisitNeed = require('./VisitNeed');
const Approach = invoke('GameServer/Bot/AI/TownNpcApproach');
const { REFRESH_MS, skillFor, available, point, effectFor, missing, recovery } = VisitNeed;
const castReadyAt = new WeakMap();
let cachedSpawns,
    managers = new Map();

function manager(hall) {
    if (!hall) return null;
    const spawns = invoke('GameServer/World/World').npc?.spawns || [];
    if (spawns !== cachedSpawns) {
        cachedSpawns = spawns;
        managers = new Map();
    }
    const known = managers.get(hall.id);
    if (known && !known.isDead?.()) return known;
    const npc = spawns.find((n) => hall.managerIds.includes(Number(n.fetchSelfId?.())));
    if (npc) managers.set(hall.id, npc);
    return npc || null;
}
function near(actor, npc) {
    if (!actor || !npc) return false;
    const a = point(actor),
        b = point(npc);
    return Math.hypot(a.locX - b.locX, a.locY - b.locY, a.locZ - b.locZ) <= 250 && Approach.canInteract(a, Approach.npcTarget(npc));
}
function authorized(actor, npc, hall, timestamp = Date.now()) {
    return (
        available(hall, timestamp) &&
        hall.ownerId === Number(actor.fetchClanId?.()) &&
        hall.managerIds.includes(Number(npc?.fetchSelfId?.())) &&
        !npc?.isDead?.() &&
        !actor.isDead?.() &&
        !actor.state?.fetchDead?.() &&
        near(actor, npc)
    );
}
function cast(session, actor, npc, id, timestamp = Date.now(), cold = false) {
    const hall = Runtime.forActor(actor);
    if (!authorized(actor, npc, hall, timestamp)) return { ok: false, code: 'not_authorized' };
    const entry = support[hall.functions.support]?.find((b) => b.id === Number(id));
    const skill = entry && skillFor(entry);
    if (!skill) return { ok: false, code: 'invalid_function' };
    const readyAt = castReadyAt.get(npc) || 0;
    if (timestamp < readyAt) return { ok: false, code: 'manager_busy', retryAt: readyAt };
    const retryAt = timestamp + Math.max(1500, Number(skill.fetchCalculatedHitTime()) || 0);
    castReadyAt.set(npc, retryAt);
    if (!cold && session?.dataSendToMeAndOthers) {
        const response = invoke('GameServer/Network/Response');
        // Support applies immediately, like cubic support. Complete that cast
        // for every observer before another recipient can use the same NPC.
        session.dataSendToMeAndOthers(response.skillStarted(npc, actor.fetchId(), skill), npc);
        session.dataSendToMeAndOthers(response.magicSkillLaunched(npc, skill, [actor]), npc);
    }
    const effect = cold
        ? Effects.apply(actor, effectFor(skill, timestamp))
        : invoke('GameServer/Skills/C4SkillEffects').execute(session, npc, actor, skill, { magicSkill: true })?.effect;
    if (!effect && cold) return { ok: false, code: 'stronger_effect' };
    return { ok: true, effect, skill, retryAt };
}
function buffBot(session, actor, npc, timestamp = Date.now(), cold = false) {
    const hall = Runtime.forActor(actor);
    if (!authorized(actor, npc, hall, timestamp)) return { ok: false, code: 'not_authorized' };
    // One service operation grants the whole useful loadout. Bot visits do not
    // reserve the manual player cast window. Manager support never costs MP.
    const granted = [];
    for (const skill of missing(actor, hall, timestamp)) {
        const effect = cold
            ? Effects.apply(actor, effectFor(skill, timestamp))
            : invoke('GameServer/Skills/C4SkillEffects').execute(session, npc, actor, skill, { magicSkill: true })?.effect;
        if (effect) granted.push(skill);
    }
    if (!cold && granted.length && session?.dataSendToMeAndOthers) {
        // A single instant animation represents the batch, avoiding overlapping
        // timed casts on the same NPC when several bots arrive together.
        const visual = Object.create(granted[0]);
        visual.fetchCalculatedHitTime = () => 0;
        visual.fetchReuseTime = () => 0;
        const response = invoke('GameServer/Network/Response');
        session.dataSendToMeAndOthers(response.skillStarted(npc, actor.fetchId(), visual), npc);
        session.dataSendToMeAndOthers(response.magicSkillLaunched(npc, visual, [actor]), npc);
    }
    return { ok: true, count: granted.length };
}
module.exports = {
    REFRESH_MS,
    skillFor,
    available,
    manager,
    point,
    near,
    effectFor,
    missing,
    authorized,
    cast,
    buffBot,
    recovery
};
