const ServerResponse = invoke('GameServer/Network/Response');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const EffectTicker = invoke('GameServer/Effects/EffectTicker');
const calculateStats = invoke('GameServer/Actor/Generics/CalculateStats');
const ChargeLifecycle = invoke('GameServer/Skills/ChargeLifecycle');

function clearEffectsOnDeath(session, actor) {
    EffectTicker.clearAll(actor);
    // Death removes abnormal effects in C4. Clear both the authoritative store
    // and legacy/UI bookkeeping so a later support pass sees the revived member
    // as genuinely unbuffed.
    actor.effects = {};
    actor.activeBuffs = {};
    actor.supportReservations = {};
    EffectStore.prune(actor);
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
            clanWar: context.clanWar === true,
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
            const economy = invoke('GameServer/Bot/Economy/EconomyContext').forState(prior, { timestamp });
            const progress = invoke('GameServer/Bot/Economy/EconomicValuation').progressStats(prior, {
                timestamp, losses: 1, lossHours: economy.deathHours, persona: economy.persona,
                knowledgeEnabled: invoke('GameServer/Bot/AI/KnowledgeLearning').knowledgeEnabled(),
                startedAt: Number(victimSession.botStartedAt || timestamp)
            });
            victimSession.coldLifeState = { ...prior, stats: { ...prior.stats, ...progress } };
        }
        Promise.resolve(invoke('GameServer/Bot/AI/BotEventJournal').record({
            botId: actor.fetchId(),
            eventType: 'death',
            summary: `${actor.fetchName?.() || 'Bot'} died.`,
            weight: 5,
            dedupeKey: `death:${actor.fetchId()}`,
            coalesceWindowMs: 5000
        })).catch(() => {});
    }
}

module.exports = die;
