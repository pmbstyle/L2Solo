const World     = invoke('GameServer/World/World');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Metrics   = invoke('GameServer/Bot/Population/PopulationMetrics');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const ServerResponse = invoke('GameServer/Network/Response');

function removeFromClientWorld(session) {
    const objectId = session?.actor?.fetchId?.();
    if (!objectId) return;

    // A bot can have been visible to a player before walking out of the
    // server's 6000-unit visibility radius.  At cooldown time that player is
    // no longer returned by fetchVisibleUsers(), so broadcasting through the
    // normal proximity path leaves a stale client-side character behind.
    const packet = ServerResponse.deleteOb(objectId);
    World.user.sessions.forEach((viewer) => {
        if (viewer !== session && typeof viewer.dataSendToMe === 'function') {
            viewer.dataSendToMe(packet);
        }
    });
}

function isVisibleToRealPlayer(session) {
    if (!session || !session.actor) return false;
    return World.fetchVisibleUsers(session, session.actor).some((user) => (
        user.actor &&
        user.accountId &&
        !String(user.accountId).startsWith('bot_')
    ));
}

const Cooldown = {
    transitionToColdState(session, state, reason = 'transition') {
        if (!session || !session.actor || !state) return Promise.resolve({ ok: false, reason: 'missing_state' });
        const BotManager = invoke('GameServer/Bot/BotManager');
        return LifeState.upsertState(state, reason).then((saved) => {
            if (!saved) return { ok: false, reason: 'state_save_failed' };

            const BotAI = invoke('GameServer/Bot/BotAI');
            BotAI.stop(session);
            removeFromClientWorld(session);
            if (session.actor && typeof session.actor.destructor === 'function') {
                session.actor.destructor();
            }
            World.removeUser(session);
            BotManager.sessions = BotManager.sessions.filter((candidate) => candidate !== session);
            session.actor = null;

            console.info('BotPopulation :: cooled %s reason=%s', saved.name, reason);
            Metrics.recordCooldown();
            return { ok: true, state: saved, reason };
        });
    },

    canCooldown(session, options = {}) {
        if (!session || !session.actor) return { ok: false, reason: 'missing_actor' };
        if (session.plan === 'merchant' && !session.coldMarketState && !session.coldCraftState) return { ok: false, reason: 'merchant' };
        if (session.actor.fetchKarma?.() > 0 && !options.allowPk) return { ok: false, reason: 'pk_active' };
        if (session.partyCompanion === true || session.followPlayerSession) return { ok: false, reason: 'player_party' };
        if (session.trade || session.activeTrade) return { ok: false, reason: 'trade_active' };
        if (session.actor.state.fetchDead && session.actor.state.fetchDead()) return { ok: false, reason: 'dead_visible_state' };
        if (!options.ignoreVisibility && isVisibleToRealPlayer(session)) return { ok: false, reason: 'visible_to_player' };
        return { ok: true, reason: 'eligible' };
    },

    cooldown(session, reason = 'cooldown', options = {}) {
        const eligibility = this.canCooldown(session, options);
        if (!eligibility.ok) {
            return Promise.resolve({ ok: false, reason: eligibility.reason });
        }

        return LifeState.markCold(session, reason).then((state) => {
            if (!state) return { ok: false, reason: 'state_save_failed' };
            if (session.coldMarketState) MarketOpportunity.indexColdStore(state);
            return this.transitionToColdState(session, state, reason);
        });
    }
};

module.exports = Cooldown;
