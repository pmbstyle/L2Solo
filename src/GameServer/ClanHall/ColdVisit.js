const Runtime = require('./Runtime');
const Services = require('./Services');
const Effects = invoke('GameServer/Effects/EffectStore');
const VisitPolicy = require('./VisitPolicy');
const VISIT_MS = 180000;
function hallFor(state) {
    // Membership projection is refreshed on joins/kicks; a saved stats.clanId is not authority.
    const id = invoke('GameServer/Clan/ClanSocialRuntime').view.memberships.get(Number(state.characterId));
    return Runtime.owned(id);
}
function actorFor(state, hall) {
    const loc = state.loc || {};
    const items = Object.values(state.inventory || {})
        .filter((item) => item.equipped && Number(item.amount) > 0)
        .flatMap((item) => {
            const template = invoke('GameServer/Item/ItemTemplateIndex').find(
                invoke('GameServer/DataCache').items,
                item.selfId
            );
            const slots = item.equippedSlots?.length ? item.equippedSlots : [item.slot || template?.etc?.slot];
            return slots.map((slot) => ({
                fetchEquipped: () => true,
                fetchSlot: () => Number(slot),
                fetchKind: () => template?.template?.kind || '',
                fetchName: () => template?.template?.name || '',
                fetchPAtk: () => template?.stats?.pAtk || 0,
                fetchMAtk: () => template?.stats?.mAtk || 0
            }));
        });
    const weapon = items.find((item) => item.fetchKind().startsWith('Weapon.')) || null;
    const actor = {
        classId: state.stats?.classId ?? state.classId,
        backpack: {
            fetchItems: () => items,
            fetchEquippedWeapon: () => weapon,
            fetchTotalWeaponKind: () => weapon?.fetchKind() || ''
        },
        stats: state.stats,
        fetchId: () => state.characterId,
        fetchClanId: () => hall?.ownerId || 0,
        fetchClassId: () => state.stats?.classId ?? state.classId,
        fetchLevel: () => state.level,
        fetchLocX: () => loc.locX,
        fetchLocY: () => loc.locY,
        fetchLocZ: () => loc.locZ,
        fetchHp: () => state.vitals?.hp || 0,
        fetchMaxHp: () => state.vitals?.maxHp || 1,
        fetchMp: () => state.vitals?.mp || 0,
        fetchMaxMp: () => state.vitals?.maxMp || 1,
        isDead: () => state.activity === 'dead' || Number(state.vitals?.hp) <= 0,
        effects: Object.fromEntries((state.stats?.coldCombat?.effects || []).map((e) => [e.key, { ...e }]))
    };
    return actor;
}
// The same rule as the hot visit and the hot restart (VisitPolicy): a cold
// bot is never at the manager, so a party member restarts in town.
function eligible(state) {
    return state?.phase === 'cold' && VisitPolicy.mayUse(VisitPolicy.fromState(state));
}
function needed(state, timestamp = Date.now()) {
    if (!eligible(state)) return false;
    if (state.stats?.clanHallVisit) return true;
    const hall = hallFor(state);
    if (!hall) return false;
    if (state.activity === 'dead' || Number(state.vitals?.hp) <= 0) return true;
    if (
        !['hunting', 'resting'].includes(state.activity) ||
        Number(state.stats?.clanHallRetryAt || 0) > timestamp ||
        state.stats?.pveEncounter
    )
        return false;
    const actor = actorFor(state, hall);
    return (
        Services.available(hall, timestamp) &&
        !!Services.manager(hall) &&
        (Services.missing(actor, hall, timestamp).length > 0 ||
            (require('./BotVisit').local(actor, hall) && Services.recovery(actor, hall)))
    );
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
                clanHallRetryAt: timestamp + 300000,
                travel: null,
                restUntil: null
            }
        },
        timestamp,
        timestamp + 1000,
        reason
    );
}
async function resolve(state, timestamp = Date.now(), options = {}) {
    if (!needed(state, timestamp) && !state.stats?.clanHallVisit) return null;
    const Life = invoke('GameServer/Bot/Population/BotLifeState');
    const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
    const hall = hallFor(state),
        npc = Services.manager(hall),
        visit = state.stats?.clanHallVisit;
    let next;
    if (!eligible(state) || !hall || (visit && (visit.hallId !== hall.id || timestamp >= visit.expiresAt))) {
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
                clanHallRetryAt: 0,
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
        if (!require('./BotVisit').local(actor, hall)) {
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
                invoke('GameServer/Bot/AI/TownNpcApproach').pointsFor({
                    ...Services.point(npc),
                    npcSelfId: npc.fetchSelfId(),
                    head: npc.fetchHead?.()
                })?.interaction || Services.point(npc);
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
            if (!inside || !Services.recovery(actorFor(serviced, hall), hall)) {
                next = finish(serviced, timestamp, 'clan_hall_services_complete');
                next.patch.vitals = serviced.vitals;
                const departure = require('./Departure').plan(serviced, hall, timestamp);
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
    const saved = await Life.applyResolve(state, next, options);
    if (saved) await invoke('GameServer/Bot/Population/BotLifeEvents').recordMany(state.characterId, next.events);
    return { ok: !!saved, state: saved || state, debug: next.debug };
}
module.exports = { hallFor, actorFor, eligible, needed, resolve };
