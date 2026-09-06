const Threats = invoke('GameServer/Bot/AI/BotPvpThreats');
const Risk = invoke('GameServer/Bot/AI/BotPvpRisk');
const Tactics = invoke('GameServer/Bot/AI/BotPvpTactics');
const Potions = invoke('GameServer/Bot/AI/HealingPotionStock');
const Restrictions = invoke('GameServer/Effects/EffectRestrictions');
const Retreat = invoke('GameServer/Bot/AI/BotRetreatPlanner');
const Voice = invoke('GameServer/Bot/AI/BotChatVoice');

const CRITICAL_HP = 0.15;
const ESCAPE_DISTANCE = 1800;

function chat(session, threat, action, BotAI, now, rng) {
    if (now < Number(session.nextPvpChatAt || 0)) return;
    session.nextPvpChatAt = now + 30000;
    // Both paths share the existing population-wide/speaker budgets. Offer
    // global first so a local line does not suppress its own global attempt.
    if (rng() < 0.3 && invoke('GameServer/Bot/Population/BotGlobalChat').announceAttack(session, threat, now)) return;
    const budget = invoke('GameServer/Bot/AI/BotChatterBudget');
    if (!budget.canSend(session, 'pvp_attack', now)) return;
    const name = String(threat.fetchName?.() || 'You').replace(/\s+/g, ' ').slice(0, 24);
    const lines = action === 'flee'
        ? [`${name}, find someone who actually wants to fight.`, `I'm not dying for your entertainment, ${name}.`]
        : Voice.trait(session, 'assertiveness') > 0.6
            ? [`You picked the wrong fight, ${name}.`, `${name}, you started this. Now stay and finish it.`]
            : [`Back off, ${name}. We didn't ask for this.`, `${name}, leave us alone. I'll defend myself.`];
    const text = lines[Math.floor(rng() * lines.length)];
    // BotAI.say routes companions to party chat. These words address the
    // aggressor, so use the native local channel explicitly.
    session.dataSendToOthers?.(invoke('GameServer/Network/Response').speak(session.actor, { kind: 0, text }), session.actor);
    budget.record(session, 'pvp_attack', now);
}

function clear(session, { dead = false } = {}) {
    const encounter = session.pvpDefense;
    if (encounter) {
        Tactics.stop(session, session.actor);
        session.currentTargetId = undefined;
        session.actor?.unselect?.();
        if (!dead) session.plan = encounter.resumePlan || 'hunting';
        if (!dead) session.lastPvpDecision = { ...session.lastPvpDecision, action: 'ended', reasons: ['threat_ended'], at: Date.now() };
    }
    delete session.pvpDefense;
    delete session.pvpHealClaims;
    delete session.pvpControlClaims;
    if (dead) delete session.pvpAggressors;
}

function tick(session, bot, Generics, BotAI, { now = Date.now(), rng = Math.random } = {}) {
    if (!session.pvpAggressors?.size && !session.pvpDefense) return false;
    if (!Threats.alive(bot)) { clear(session, { dead: true }); return false; }
    const context = Threats.context(session, now);
    if (!context.threats.length) {
        if (session.pvpDefense) clear(session);
        return false;
    }
    // Once a purple aggressor goes white, drop the chase instead of turning
    // self-defense into a PK. Hostile controls also set the native PvP flag.
    const threats = context.threats.filter(entry => entry.actor.fetchPvpFlag?.() > 0 || entry.actor.fetchKarma?.() > 0);
    if (!threats.length) { clear(session); return false; }
    context.threats = threats;
    const target = threats[0].actor;
    let encounter = session.pvpDefense;
    if (!encounter) {
        const decision = Risk.defenseDecision(session, threats.map(entry => entry.actor));
        if (context.members.length > 1) {
            decision.action = 'fight';
            decision.reasons = ['defend_party', 'weakest_aggressor_first'];
        }
        encounter = session.pvpDefense = { ...decision, resumePlan: session.plan || 'hunting', startedAt: now, criticalChecked: false };
        Tactics.stop(session, bot);
        invoke('GameServer/Bot/AI/BotSupportPlanner').cancelSupportCast(session, bot);
        session.pendingSupportCast = undefined;
        if (session.spotRelocation) invoke('GameServer/Bot/AI/BotSpotTravel').cancel(session, bot, 'pvp_defense');
        chat(session, target, encounter.action, BotAI, now, rng);
    }
    const hpRatio = bot.fetchHp() / Math.max(1, bot.fetchMaxHp());
    // One roll per encounter, never per tick: staying means fighting on even
    // at critical HP, rather than eventually fleeing with probability 1.
    if (encounter.action === 'fight' && hpRatio <= CRITICAL_HP && !encounter.criticalChecked) {
        encounter.criticalChecked = true;
        if (rng() < encounter.criticalFleeChance) {
            encounter.action = 'flee';
            encounter.reasons = ['critical_hp_escape'];
            Tactics.stop(session, bot);
            chat(session, target, 'flee', BotAI, now, rng);
        }
    }
    session.lastPvpDecision = { action: encounter.action, score: encounter.score, reasons: encounter.reasons,
        own: encounter.own, enemies: encounter.enemies, requiredRatio: encounter.requiredRatio,
        threatId: target.fetchId(), threatName: target.fetchName?.(),
        targets: threats.map(entry => entry.actor.fetchId()),
        allies: context.members.filter(member => member !== session).map(member => member.actor.fetchId()),
        criticalChecked: encounter.criticalChecked, at: now };
    if (!Restrictions.canUseBasicAction(bot)) return true;
    if (bot.state?.fetchSeated?.()) {
        bot.state.setSeated(false);
        session.dataSendToOthers?.(invoke('GameServer/Network/Response').sitAndStand(bot), bot);
    }
    // This is checked during native attacks and movement as well, not only
    // between swings. PvP lifts the farming encounter count, never reuse or
    // inventory requirements.
    if (Potions.tryUseInCombat(session, bot, target, { pvp: true })) return true;
    if (encounter.action === 'flee') {
        session.currentTargetId = undefined;
        const nearest = [...threats].sort((a, b) => Threats.distance(bot, a.actor) - Threats.distance(bot, b.actor))[0].actor;
        if (Threats.distance(bot, nearest) >= ESCAPE_DISTANCE) { clear(session); return true; }
        if (!Restrictions.canMove(bot)) {
            if (!bot.state?.fetchCasts?.()) Tactics.control(session, bot, context, nearest, Generics, now, true);
            return true;
        }
        if (bot.state?.fetchCasts?.()) return true;
        if (Tactics.control(session, bot, context, nearest, Generics, now, true)) return true;
        const moving = session.moveTimer || bot.state?.fetchTowards?.();
        if ((!moving || now - Number(encounter.lastRetreatAt || 0) >= 4000) && now - Number(encounter.lastRetreatAt || 0) >= 1000) {
            Tactics.stop(session, bot);
            encounter.lastRetreatAt = now;
            Retreat.retreat(session, bot, nearest, { distance: 900 });
        }
        return true;
    }
    if (session.currentTargetId !== target.fetchId()) {
        Tactics.stop(session, bot);
        session.currentTargetId = target.fetchId();
        bot.select({ id: target.fetchId() });
    }
    if (Tactics.support(session, bot, context, Generics, now)) return true;
    if (Tactics.control(session, bot, context, target, Generics, now)) return true;
    // Native auto-attacks repeat without yielding an idle AI tick. Revisit
    // skills that came off reuse instead of being stuck on basic attacks for
    // the rest of a long duel.
    if (bot.state?.fetchHits?.() && !bot.state?.fetchCasts?.() && Restrictions.canCast(bot) &&
        now - Number(encounter.lastSkillReviewAt || 0) >= 2000) {
        encounter.lastSkillReviewAt = now;
        const role = invoke('GameServer/Bot/AI/BotRoles').combatRoleFor(bot);
        if (invoke('GameServer/Bot/AI/BotCombatUtility').select(bot, target, role, { pvp: true, avoidAreaDamage: true })) {
            Tactics.stop(session, bot);
        }
    }
    if (bot.state?.fetchTowards?.() || bot.state?.fetchHits?.() || bot.state?.fetchCasts?.()) return true;
    BotAI.executePvPCombat(session, bot, target, Generics, { avoidAreaDamage: true });
    return true;
}

module.exports = { tick, clear, CRITICAL_HP };
