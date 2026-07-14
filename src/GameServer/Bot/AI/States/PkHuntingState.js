const SpeckMath = invoke('GameServer/SpeckMath');
const World = invoke('GameServer/World/World');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');

function distance(a, b) {
    return new SpeckMath.Point3D(a.fetchLocX(), a.fetchLocY(), a.fetchLocZ())
        .distance(new SpeckMath.Point3D(b.fetchLocX(), b.fetchLocY(), b.fetchLocZ()));
}

function isEligibleTarget(session, bot, profile) {
    const other = session?.actor;
    if (!other || other === bot || !other.fetchIsOnline?.() || other.state?.fetchDead?.()) return false;
    if (session.plan === 'merchant') return false;
    if (Number(other.fetchKarma?.() || 0) !== 0 || utils.isInPeaceZone(other.fetchLocX(), other.fetchLocY())) return false;
    const level = Number(other.fetchLevel?.() || 1);
    if (level < Number(profile?.targetMinLevel || 1) || level > Number(profile?.targetMaxLevel || Infinity)) return false;
    if (!profile?.anchor) return true;
    const dx = other.fetchLocX() - profile.anchor.locX;
    const dy = other.fetchLocY() - profile.anchor.locY;
    return Math.sqrt(dx * dx + dy * dy) <= Number(profile.activationRadius || 0);
}

function isEligibleAttacker(session, bot, profile) {
    const other = session?.actor;
    if (!other || other === bot || !other.fetchIsOnline?.() || other.state?.fetchDead?.()) return false;
    if (session.plan === 'merchant') return false;
    if (utils.isInPeaceZone(other.fetchLocX(), other.fetchLocY())) return false;
    if (!profile?.anchor) return true;
    const dx = other.fetchLocX() - profile.anchor.locX;
    const dy = other.fetchLocY() - profile.anchor.locY;
    return Math.sqrt(dx * dx + dy * dy) <= Number(profile.activationRadius || 0);
}

function activeThreats(bot, profile) {
    return World.user.sessions
        .filter((session) => isEligibleAttacker(session, bot, profile))
        .map((session) => session.actor)
        .filter((other) => {
            if (distance(other, bot) >= 1500) return false;
            const activelyTargetingPk = other.fetchDestId?.() === bot.fetchId();
            const overwhelming = Number(other.fetchLevel?.() || 1) >= Number(bot.fetchLevel?.() || 1) + 8;
            return activelyTargetingPk || overwhelming;
        });
}

function patrol(session, bot, profile) {
    const anchor = profile?.anchor;
    if (!anchor) return;
    const dx = bot.fetchLocX() - anchor.locX;
    const dy = bot.fetchLocY() - anchor.locY;
    const away = Math.sqrt(dx * dx + dy * dy);
    let locX;
    let locY;
    if (away > Number(profile.patrolRadius || 1200)) {
        locX = anchor.locX;
        locY = anchor.locY;
    } else {
        const angle = Math.random() * Math.PI * 2;
        const radius = 120 + Math.random() * Math.min(400, Number(profile.patrolRadius || 1200));
        locX = Math.round(anchor.locX + Math.cos(angle) * radius);
        locY = Math.round(anchor.locY + Math.sin(angle) * radius);
    }
    bot.moveTo({
        from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
        to: { locX, locY, locZ: GeodataEngine.getHeight(locX, locY, anchor.locZ) }
    });
}

module.exports = {
    isEligibleTarget,
    isEligibleAttacker,
    activeThreats,

    tick(session, bot, Generics, BotAI) {
        const profile = session.pkProfile;
        if (!profile) return;

        const threats = activeThreats(bot, profile);
        const strongestThreat = threats.sort((a, b) => b.fetchLevel() - a.fetchLevel())[0];
        const overwhelmingSolo = strongestThreat && strongestThreat.fetchLevel() >= bot.fetchLevel() + 8;
        if (threats.length >= 2 || overwhelmingSolo) {
            session.currentTargetId = undefined;
            if (bot.state.fetchTowards?.()) return;
            const escapeFrom = strongestThreat;
            const dx = bot.fetchLocX() - escapeFrom.fetchLocX();
            const dy = bot.fetchLocY() - escapeFrom.fetchLocY();
            const length = Math.sqrt(dx * dx + dy * dy) || 1;
            const locX = Math.round(bot.fetchLocX() + (dx / length) * 900);
            const locY = Math.round(bot.fetchLocY() + (dy / length) * 900);
            bot.moveTo({
                from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
                to: { locX, locY, locZ: GeodataEngine.getHeight(locX, locY, bot.fetchLocZ()) }
            });
            return;
        }

        if (session.currentTargetId) {
            World.fetchUser(session.currentTargetId).then((target) => {
                if (target && isEligibleTarget(target.session, bot, profile)) {
                    if (bot.state.fetchTowards?.() || bot.state.fetchHits?.() || bot.state.fetchCasts?.()) return;
                    BotAI.executePvPCombat(session, bot, target, Generics);
                } else {
                    session.currentTargetId = undefined;
                }
            }).catch(() => { session.currentTargetId = undefined; });
            return;
        }

        const target = World.user.sessions
            .filter((candidate) => isEligibleTarget(candidate, bot, profile))
            .map((candidate) => candidate.actor)
            .filter((candidate) => distance(candidate, bot) <= 2500)
            .sort((a, b) => distance(a, bot) - distance(b, bot))[0];

        if (target) {
            session.currentTargetId = target.fetchId();
            bot.select({ id: target.fetchId() });
            BotAI.executePvPCombat(session, bot, target, Generics);
        } else if (!bot.state.fetchTowards?.() && Date.now() - Number(session.lastPkPatrolAt || 0) >= 3000) {
            session.lastPkPatrolAt = Date.now();
            patrol(session, bot, profile);
        }
    }
};
