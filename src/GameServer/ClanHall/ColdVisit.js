const Runtime = require('./Runtime');
const Services = require('./Services');
const Effects = invoke('GameServer/Effects/EffectStore');
const VisitNeed = require('./VisitNeed');
const Rebuff = invoke('GameServer/Bot/AI/Rebuff');
const { actorFor, eligible } = VisitNeed;
const VISIT_MS = 180000;
function hallFor(state) {
    // Membership projection is refreshed on joins/kicks; a saved stats.clanId is not authority.
    const id = invoke('GameServer/Clan/ClanSocialRuntime').view.memberships.get(Number(state.characterId));
    return Runtime.owned(id);
}
// Main thread: the hall from the membership projection (VisitNeed.needed).
function needed(state) {
    return VisitNeed.needed(state, state.stats?.clanHallVisit || Rebuff.pending(state.stats, 'hall') ? null : hallFor(state));
}
function result(state, patch, timestamp, nextAt, reason) {
    return {
        patch,
        events: [
            {
                type: 'clan_hall_visit',
                summary: `${state.name || 'Bot'} ${
                    {
                        walking_to_clan_hall: 'is walking to the clan hall manager',
                        teleported_to_clan_hall: 'teleported to the clan hall for support magic',
                        clan_hall_buff_received: 'received support magic in the clan hall',
                        clan_hall_recovery: 'is recovering at the clan hall manager',
                        clan_hall_services_complete: 'finished the clan hall visit and is returning to hunting',
                        clan_hall_service_unavailable: 'left the clan hall because its services are unavailable',
                        clan_hall_visit_cancelled: 'cancelled the clan hall visit'
                    }[reason] || 'visited the clan hall'
                }`,
                weight: 1
            }
        ],
        materialize: { exp: 0, sp: 0, adena: 0, items: [] },
        nextResolveAt: nextAt,
        debug: { activity: patch.activity || state.activity, reason, fights: 0, wins: 0 }
    };
}
function finish(state, timestamp, reason) {
    return result(
        state,
        {
            activity: ['clan_hall', 'traveling', 'resting', 'hunting'].includes(state.activity)
                ? 'hunting'
                : state.activity,
            spotId: null,
            stats: {
                ...state.stats,
                clanHallVisit: null,
                travel: null,
                restUntil: null
            }
        },
        timestamp,
        timestamp + 1000,
        reason
    );
}
// A rebuff's hall answer main does not carry out (no hall it may use, its service
// closed or no manager, nothing it lacks now): only the answer drops, held done and
// counted (rebuff:hall:<reason>); the bot goes on as it stood (activity, spot, rest).
function dropped(state, timestamp, reason) {
    invoke('GameServer/Bot/Situations').note(`rebuff:hall:${reason}`);
    return { patch: { stats: state.stats }, events: [], materialize: { exp: 0, sp: 0, adena: 0, items: [] },
        nextResolveAt: timestamp + 1000, debug: { activity: state.activity, reason: `clan_hall_${reason}`, fights: 0, wins: 0 } };
}
async function resolve(original, timestamp = Date.now(), options = {}) {
    if (!needed(original)) return null;
    const Life = invoke('GameServer/Bot/Population/BotLifeState');
    const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
    // The rebuff's hall answer is carried out once: the visit it starts, or the
    // refusal that drops it, holds it done (a failed visit waits for the next situation).
    const asked = Rebuff.pending(original.stats, 'hall');
    const state = asked ? { ...original, stats: { ...original.stats, rebuff: Rebuff.done(asked) } } : original;
    const hall = hallFor(state),
        npc = Services.manager(hall),
        visit = state.stats?.clanHallVisit;
    const dead = state.activity === 'dead' || Number(state.vitals?.hp) <= 0;
    // An answer, not a visit under way: checked again where main acts (it was taken on
    // the worker's hall row, maybe before a party or a fight that changed the bot's buffs).
    const refused = asked && !visit && (!eligible(state) || !hall ? 'no_hall' : dead ? null
        : !Services.available(hall, timestamp) || !npc ? 'unavailable'
            : !Services.missing(actorFor(state, hall), hall, timestamp).length ? 'served' : null);
    let next;
    if (refused) {
        next = dropped(state, timestamp, refused);
    } else if (!eligible(state) || !hall || (visit && (visit.hallId !== hall.id || timestamp >= visit.expiresAt))) {
        next = finish(state, timestamp, 'clan_hall_visit_cancelled');
    } else if (state.activity === 'dead' || Number(state.vitals?.hp) <= 0) {
        next = Resolver.resolveDeathRecovery(state, timestamp);
        if (next.patch.activity) {
            next.patch.loc = { ...hall.spawn };
            next.patch.currentRegion = hall.town;
            next.patch.spotId = null;
            next.patch.restoreExpPercent = Services.available(hall, timestamp) ? Number(hall.functions.exp || 0) : 0;
            next.patch.stats = {
                ...next.patch.stats,
                clanHallVisit: null,
                coldCombat: { ...next.patch.stats.coldCombat, effects: [] }
            };
            next.events[0].summary = `${state.name || 'Bot'} restarted in ${hall.name}`;
        }
    } else if (!Services.available(hall, timestamp) || !npc) {
        next = finish(state, timestamp, 'clan_hall_service_unavailable');
    } else if (state.activity === 'traveling' && visit) {
        next = Resolver.resolveSolo({ state, timestamp, elapsedMs: 0 });
        if (next.patch.activity === 'clan_hall') next.nextResolveAt = timestamp + 1000;
    } else {
        const actor = actorFor(state, hall);
        const currentVisit = visit || { hallId: hall.id, startedAt: timestamp, expiresAt: timestamp + VISIT_MS };
        if (!VisitNeed.local(actor, hall)) {
            next = Services.missing(actor, hall, timestamp).length
                ? result(state, {
                    activity: 'clan_hall',
                    loc: { ...hall.spawn },
                    currentRegion: hall.town,
                    spotId: null,
                    stats: { ...state.stats, clanHallVisit: currentVisit, travel: null, restUntil: null }
                }, timestamp, timestamp + 1200, 'teleported_to_clan_hall')
                : finish(state, timestamp, 'clan_hall_visit_cancelled');
        } else if (!Services.near(actor, npc)) {
            const to =
                invoke('GameServer/Bot/AI/TownNpcApproach').talkPointFor({
                    ...Services.point(npc),
                    npcSelfId: npc.fetchSelfId(),
                    head: npc.fetchHead?.()
                }, state.characterId) || Services.point(npc);
            const travelMs = Math.max(
                1000,
                Math.ceil(Math.hypot(to.locX - state.loc.locX, to.locY - state.loc.locY) / 120) * 1000
            );
            next = result(
                state,
                {
                    activity: 'traveling',
                    spotId: null,
                    stats: {
                        ...state.stats,
                        clanHallVisit: currentVisit,
                        travel: {
                            from: { ...state.loc },
                            to,
                            startedAt: timestamp,
                            arrivalAt: timestamp + travelMs,
                            townName: hall.town,
                            regionName: hall.town,
                            method: 'walk',
                            arrivalActivity: 'clan_hall',
                            arrivalEvent: 'arrived_clan_hall',
                            reason: 'clan_hall_services'
                        }
                    }
                },
                timestamp,
                timestamp + travelMs,
                'walking_to_clan_hall'
            );
        } else {
            const buffs = Services.buffBot(null, actor, npc, timestamp, true);
            const elapsedMs = Math.min(30000, Math.max(0, timestamp - Number(visit?.lastServiceAt || timestamp)));
            const inside = Runtime.Policy.inside(hall, actor);
            const recovered = Resolver.resolveRest(
                { ...state, stats: { ...state.stats, restUntil: 0 } },
                elapsedMs,
                timestamp,
                {
                    hpMultiplier: inside ? 1 + Number(hall.functions.hp || 0) / 100 : 1,
                    mpMultiplier: inside ? 1 + Number(hall.functions.mp || 0) / 100 : 1
                }
            );
            const serviced = {
                ...state,
                vitals: recovered.patch.vitals,
                stats: {
                    ...state.stats,
                    coldCombat: {
                        ...state.stats?.coldCombat,
                        effects: Effects.list(actor).map(e => ({ ...e }))
                    }
                }
            };
            if (!inside || !Services.recovery(actorFor(serviced, hall), hall, timestamp)) {
                next = finish(serviced, timestamp, 'clan_hall_services_complete');
                next.patch.vitals = serviced.vitals;
                const departure = require('./Departure').plan(serviced, hall);
                if (departure) {
                    next.patch.loc = departure.destination;
                    next.patch.spotId = departure.spot.id;
                    next.patch.currentRegion = departure.spot.name;
                    next.patch.stats.pveEncounter = null;
                    next.events[0].summary = `${state.name || 'Bot'} teleported from ${hall.name} to ${departure.spot.name}`;
                    next.debug.reason = 'clan_hall_teleport';
                }
            } else
                next = result(
                    state,
                    {
                        activity: 'clan_hall',
                        vitals: recovered.patch.vitals,
                        stats: {
                            ...state.stats,
                            travel: null,
                            restUntil: null,
                            clanHallVisit: { ...currentVisit, lastServiceAt: timestamp },
                            coldCombat: {
                                ...state.stats?.coldCombat,
                                effects: Effects.list(actor).map((e) => ({ ...e }))
                            }
                        }
                    },
                    timestamp,
                    timestamp + 5000,
                    buffs.count ? 'clan_hall_buff_received' : 'clan_hall_recovery'
                );
        }
    }
    // ARCH-NOTE: The native lifecycle queue rechecks the original worker/checkpoint before any hall transition writes.
    const saved = await Life.applyResolve(original, next, options);
    if (saved) await invoke('GameServer/Bot/Population/BotLifeEvents').recordMany(state.characterId, next.events);
    return { ok: !!saved, state: saved || original, debug: next.debug };
}
module.exports = { hallFor, actorFor, eligible, needed, resolve };
