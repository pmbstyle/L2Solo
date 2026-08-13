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

function die(session, actor) {
    if (actor.isDead()) {
        return;
    }

    actor.destructor();
    ChargeLifecycle.clear(session, actor);
    clearEffectsOnDeath(session, actor);
    // Death cancels the timers that normally release transient action flags
    // (cast, hit, sit animation, pickup). Reset them explicitly so a town
    // restart cannot leave the actor permanently blocked after those timers
    // have been cancelled.
    actor.state.destructor();
    actor.state.setDead(true);
    session.dataSendToMeAndOthers(ServerResponse.die(actor.fetchId()), actor);
    if (session?.accountId?.startsWith?.('bot_')) {
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
