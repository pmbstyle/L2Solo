const World     = invoke('GameServer/World/World');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Metrics   = invoke('GameServer/Bot/Population/PopulationMetrics');

function isVisibleToRealPlayer(session) {
    if (!session || !session.actor) return false;
    return World.fetchVisibleUsers(session, session.actor).some((user) => (
        user.actor &&
        user.accountId &&
        !String(user.accountId).startsWith('bot_')
    ));
}

const Cooldown = {
    canCooldown(session) {
        if (!session || !session.actor) return { ok: false, reason: 'missing_actor' };
        if (session.plan === 'merchant') return { ok: false, reason: 'merchant' };
        if (session.partyCompanion === true || session.followPlayerSession) return { ok: false, reason: 'player_party' };
        if (session.trade || session.activeTrade) return { ok: false, reason: 'trade_active' };
        if (session.actor.state.fetchDead && session.actor.state.fetchDead()) return { ok: false, reason: 'dead_visible_state' };
        if (isVisibleToRealPlayer(session)) return { ok: false, reason: 'visible_to_player' };
        return { ok: true, reason: 'eligible' };
    },

    cooldown(session, reason = 'cooldown') {
        const eligibility = this.canCooldown(session);
        if (!eligibility.ok) {
            return Promise.resolve({ ok: false, reason: eligibility.reason });
        }

        const BotManager = invoke('GameServer/Bot/BotManager');
        return LifeState.markCold(session, reason).then((state) => {
            if (!state) return { ok: false, reason: 'state_save_failed' };

            const BotAI = invoke('GameServer/Bot/BotAI');
            BotAI.stop(session);
            if (session.actor && typeof session.actor.destructor === 'function') {
                session.actor.destructor();
            }
            World.removeUser(session);
            BotManager.sessions = BotManager.sessions.filter((candidate) => candidate !== session);
            session.actor = null;

            console.info('BotPopulation :: cooled %s reason=%s', state.name, reason);
            Metrics.recordCooldown();
            return { ok: true, state, reason };
        });
    }
};

module.exports = Cooldown;
