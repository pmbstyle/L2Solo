const ServerResponse = invoke('GameServer/Network/Response');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const EffectTicker = invoke('GameServer/Effects/EffectTicker');
const calculateStats = invoke('GameServer/Actor/Generics/CalculateStats');
const ChargeLifecycle = invoke('GameServer/Skills/ChargeLifecycle');
const EconomyContext = invoke('GameServer/Bot/Economy/EconomyContext');
const EconomicValuation = invoke('GameServer/Bot/Economy/EconomicValuation');
const Packet = require('../../Bot/Economy/StatsPacket');

function clearEffectsOnDeath(session, actor) {
    const silentMoving = Object.values(actor.effects || {}).find((effect) => effect?.stats?.silentMoving);
    EffectTicker.clearAll(actor);
    // Death removes abnormal effects in C4. Clear both the authoritative store
    // and legacy/UI bookkeeping so a later support pass sees the revived member
    // as genuinely unbuffed.
    actor.effects = {};
    actor.activeBuffs = {};
    actor.supportReservations = {};
    EffectStore.prune(actor);
    // actor.silentMoving is read first by NpcAggro; recompute it from the now
    // empty store, as the manual removals do.
    if (silentMoving) invoke('GameServer/Skills/ToggleSkills').cleanupState(session, actor, silentMoving);
    calculateStats(session, actor);
    EffectTicker.refreshEffects(session, actor);
}

function die(session, actor, context = {}) {
    if (actor.isDead()) {
        return;
    }

    const victimSession = actor.session || session;
    const ArenaDuelService = invoke('GameServer/World/ArenaDuelService');
    if (!ArenaDuelService.duelForActor?.(actor)) require('./PkDeathDrop').drop(victimSession, actor);
    if (typeof actor.fetchExp === 'function' && typeof actor.setExpSp === 'function' && !actor.fetchKind) {
        const killer = context.killer ?? context.source;
        invoke('GameServer/Progression/DeathExperience').applyDeathPenalty(victimSession, actor, {
            timestamp: context.timestamp,
            arena: victimSession?.arenaEphemeral === true || !!victimSession?.arenaDuelId
                || !!ArenaDuelService.duelForActor?.(actor),
            killerPlayable: !!killer && killer !== actor && !killer.fetchKind,
            clanWar: context.clanWar === true || !!killer && Number(actor.fetchClanId?.()) > 0
                && (Number(killer.fetchClanId?.()) > 0 || Number(killer.fetchOwnerId?.()) > 0)
                && invoke('GameServer/Clan/ClanWarRuntime').between(killer, actor).outgoing,
            festival: context.festival === true,
            event: context.event === true,
            pvpZone: context.pvpZone === true,
            siegeZone: context.siegeZone === true,
            siegeParticipant: context.siegeParticipant === true,
            killerSiegeNpc: context.killerSiegeNpc === true
        });
    }

    if ((actor.fetchMounted?.() || actor.mounted) && actor.pet?.petData) invoke('GameServer/Pets/PetRuntime').die(actor.pet);
    actor.destructor();
    ChargeLifecycle.clear(session, actor);
    clearEffectsOnDeath(session, actor);
    // Death cancels the timers that normally release transient action flags
    // (cast, hit, sit animation, pickup). Reset them explicitly so a town
    // restart cannot leave the actor permanently blocked after those timers
    // have been cancelled.
    actor.state.destructor();
    actor.state.setDead(true);
    session.dataSendToMeAndOthers(ServerResponse.die(actor.fetchId(), false, !!require('../../ClanHall/Runtime').destination(actor)), actor);
    invoke('GameServer/Clan/ClanAllianceService').onDeath(victimSession);
    // ReceivedHit is invoked with the attacker's session, while the actor
    // being killed owns the authoritative victim session. Arena death must
    // therefore be routed through actor.session or the player death branch
    // is missed whenever the ephemeral clone lands the final hit.
    if (ArenaDuelService.onPlayerDeath?.(victimSession)) return;
    if (victimSession?.accountId?.startsWith?.('bot_') && victimSession.arenaEphemeral !== true) {
        const Life = invoke('GameServer/Bot/Population/BotLifeState');
        const prior = victimSession.coldLifeState || Life.cachedState(actor.fetchId());
        if (prior) {
            const timestamp = Number(context.timestamp || Date.now());
            // The death price its build published (stats.dangerPrice), the persona
            // from the personal reads; the basics only for a bot with no packet.
            const published = Packet.deathHours(prior.stats?.dangerPrice);
            const economy = Number.isFinite(published) ? { deathHours: published,
                persona: EconomyContext.personal(prior, { timestamp }).persona } : EconomyContext.basics(prior, { timestamp });
            // The price is a table row's death; this live one also waits for its respawn.
            const progress = EconomicValuation.progressStats(prior, {
                timestamp, losses: 1, lossHours: EconomicValuation.liveDeathHours(economy.deathHours), persona: economy.persona,
                knowledgeEnabled: invoke('GameServer/Bot/AI/KnowledgeLearning').knowledgeEnabled(),
                startedAt: Number(victimSession.botStartedAt || timestamp)
            });
            // Its death is a far round's (deaths, the spot's risk, recovery): the died situation
            // re-decides its spot on the row that carries it.
            const recorded = Life.recordNearFight(victimSession, prior, { died: true, timestamp });
            victimSession.coldLifeState = { ...recorded, stats: { ...recorded.stats, ...progress } };
        }
        Life.notifyNearFacts(victimSession, 'death');
        const Trace = invoke('GameServer/Bot/DecisionTrace');
        if (Trace.on()) {
            const killer = context.killer ?? context.source;
            // Where and how the body died: the spot it hunts (the row's may be the one it left), what it was
            // doing, the mobs still on it and its time since it went hot (near and far deaths compared).
            const hotAt = Number(victimSession.populationHotAt) || 0;
            // Its detail tier and the nearest player's distance at its last tick (HotActorLodPolicy).
            const lod = victimSession.hotActorLod;
            Trace.record({ kind: 'death', bot: actor.fetchId(), spot: String(victimSession.currentSpot?.id ?? prior?.spotId ?? ''),
                ...(lod ? { tier: lod.tier, playerDist: lod.nearestPlayerDistance ?? undefined } : {}),
                level: Number(actor.fetchLevel?.()) || undefined, plan: String(victimSession.plan || ''),
                attackers: invoke('GameServer/Bot/AI/PartyAwareness').npcsAttackingActor(actor, 900).length,
                ...(hotAt > 0 ? { durationMs: Math.max(0, Number(context.timestamp || Date.now()) - hotAt) } : {}),
                killer: !killer || killer === actor ? 'unknown' : killer.fetchKind ? `npc:${killer.fetchSelfId?.() ?? '?'}`
                    : `char:${killer.fetchId?.()}` });
        }
        invoke('GameServer/Bot/AI/BotEventJournal').record({
            botId: actor.fetchId(),
            eventType: 'death',
            summary: `${actor.fetchName?.() || 'Bot'} died.`,
            weight: 5,
            dedupeKey: `death:${actor.fetchId()}`,
            coalesceWindowMs: 5000
        });
    }
}

module.exports = die;
