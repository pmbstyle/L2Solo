const World = invoke('GameServer/World/World');
const Formulas = invoke('GameServer/Formulas');
const Attack = invoke('GameServer/Actor/Attack');
const AttackRange = invoke('GameServer/Actor/AttackRange');
const Restrictions = invoke('GameServer/Effects/EffectRestrictions');
const Geodata = invoke('GameServer/Geodata/GeodataEngine');
const Utility = invoke('GameServer/Bot/AI/BotCombatUtility');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const RaidSafety = invoke('GameServer/Bot/AI/BotRaidSafety');

const MAX_FINISH_MS = 4000;
const DAMAGE_MARGIN = 0.70;
const THREAT_RADIUS = 2500;

function stat(actor, name) {
    const value = Number(actor?.[`fetchCollective${name}`]?.() ?? actor?.[`fetch${name}`]?.());
    return Number.isFinite(value) && value > 0 ? value : 0;
}

function physicalModifier(actor, target, skill = null) {
    const trait = skill?.fetchSemantic?.()?.trait;
    return Attack.incomingWeaponVulnerabilityModifier(target, {
        bow: trait === 'bow' || Attack.prototype.isBowAttack(actor),
        blunt: trait === 'blunt' || Attack.prototype.isBluntAttack(actor),
        dagger: !!skill && (trait === 'dagger' || Attack.prototype.isDaggerAttack(actor))
    }) * Attack.physicalUndeadModifier(actor, target) * Attack.physicalRaceModifier(actor, target);
}

function evaluate(session, bot, target) {
    if (session.partyCompanion === true || session.followPlayerSession ||
        !target || target.fetchAttackable?.() !== true || target.isDead?.() || target.state?.fetchDead?.() ||
        RaidSafety.isProtectedRaidEntity(target) || !Restrictions.canUseBasicAction(bot)) return null;
    const hp = Number(target.fetchHp?.());
    const botHp = Number(bot.fetchHp());
    const maxHp = Number(bot.fetchMaxHp());
    if (![hp, botHp, maxHp].every(value => Number.isFinite(value) && value > 0)) return null;
    if ((bot.state.fetchHits?.() || bot.state.fetchCasts?.()) &&
        Number(session.currentTargetId) !== Number(target.fetchId())) return null;
    // Do not turn a last hit into a chase or a pathfinding gamble.
    if (!Geodata.hasLineOfSight(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ(),
        target.fetchLocX(), target.fetchLocY(), target.fetchLocZ())) return null;

    const actions = [];
    const casting = bot.state.fetchCasts?.() === true;
    const activeCast = casting ? bot.attack?.activeCast : null;
    // While casting, only the actual pending impact can justify staying.
    // Its cooldown is already running; another available attack cannot help.
    if (casting && (!activeCast || activeCast.target !== target ||
        !Number.isFinite(activeCast.landsAt) || activeCast.landsAt <= Date.now())) return null;
    const speed = stat(bot, 'AtkSpd');
    if (!casting && Restrictions.canAttack(bot) && speed &&
        AttackRange.isWithinRange(bot, target, AttackRange.fetchNormalAttackRange(bot))) {
        const damage = Utility.basicAttackDamageEstimate(bot, target) * physicalModifier(bot, target) * DAMAGE_MARGIN;
        const hits = damage > 0 ? Math.ceil(hp / damage) : Infinity;
        if (hits <= 2) actions.push({ action: 'basic_attack', estimatedHits: hits,
            estimatedDamage: damage, finishMs: (hits + 1) * Formulas.calcMeleeAtkTime(speed), hpCost: 0 });
    }
    if (casting || Restrictions.canCast(bot)) {
        for (const skill of casting ? [activeCast.skill] : (bot.skillset?.skills || [])) {
            // Only direct damage is predictable here; do not count a debuff,
            // drain, probabilistic blow, area attack, or a future DoT tick.
            if (skill.fetchSkillType?.() !== 'damage' ||
                ['area', 'front_area', 'aura'].includes(skill.fetchSemantic?.()?.sourceTarget)) continue;
            if (!casting && !Utility.evaluate(bot, target, skill, Roles.combatRoleFor(bot), { avoidAreaDamage: true })) continue;
            if (!casting && Attack.prototype.skillUseConditionFailure.call(Attack.prototype, session, bot, skill)) continue;
            if (Attack.prototype.skillMpCost(bot, skill) > bot.fetchMp()) continue;
            if (!AttackRange.isWithinRange(bot, target, Number(skill.fetchDistance?.()) || 0)) continue;
            const magic = Attack.prototype.isMagicSkill(skill);
            const rate = stat(bot, magic ? 'CastSpd' : 'AtkSpd');
            const attack = stat(bot, magic ? 'MAtk' : 'PAtk');
            const defense = stat(target, magic ? 'MDef' : 'PDef');
            if (!rate || !attack || !defense) continue;
            const damage = (magic
                ? Formulas.calcMagicDamage(attack, skill.fetchPower(), defense) * Attack.traitVulnerabilityModifier(target, skill.fetchSemantic?.()?.trait)
                : Formulas.calcPhysicalDamage(attack, 0, defense, skill.fetchPower(), { rng: () => 0.5 }) * physicalModifier(bot, target, skill)) * DAMAGE_MARGIN;
            if (!Number.isFinite(damage) || damage < hp) continue;
            actions.push({ action: 'cast_skill', skillId: skill.fetchSelfId(), estimatedHits: 1,
                estimatedDamage: damage,
                finishMs: (casting ? activeCast.landsAt - Date.now()
                    : Attack.prototype.calculatedSkillHitTime(bot, skill, magic)) + 1000,
                hpCost: Math.max(0, Number(skill.fetchConsumedHp?.()) || 0) });
        }
    }
    const quickActions = actions.filter(action => Number.isFinite(action.finishMs) && action.finishMs <= MAX_FINISH_MS);
    if (!quickActions.length) return null;
    const attackers = new Map([[Number(target.fetchId()), target]]);
    for (const npc of World.fetchNpcsInRadius(bot.fetchLocX(), bot.fetchLocY(), THREAT_RADIUS)) {
        if (npc.fetchAttackable?.() !== true || npc.isDead?.() || npc.state?.fetchDead?.()) continue;
        if (Number(npc.fetchDestId?.()) === Number(bot.fetchId()) || Number(npc.getHating?.(bot)) > 0 ||
            (Number(session.incomingThreatId) === Number(npc.fetchId()) && Date.now() - Number(session.incomingThreatAt) <= 5000)) {
            attackers.set(Number(npc.fetchId()), npc);
        }
    }
    for (const action of quickActions.sort((a, b) => a.finishMs - b.finishMs)) {
        let incomingDamage = 0;
        for (const npc of attackers.values()) {
            const damage = Utility.basicAttackDamageEstimate(npc, bot);
            const rate = stat(npc, 'AtkSpd');
            // Unknown attackers and raids cannot be treated as zero damage.
            if (!damage || !rate || npc.state?.fetchCasts?.() || RaidSafety.isProtectedRaidEntity(npc)) {
                incomingDamage = Infinity; break;
            }
            // Include an immediate hit, every swing in the window, and 50%
            // headroom. The basic-action window also budgets one missed hit.
            incomingDamage += damage * 1.5 * (1 + Math.ceil(action.finishMs / Formulas.calcMeleeAtkTime(rate)));
        }
        const reserve = Math.max(1, maxHp * 0.10);
        if (botHp - action.hpCost - incomingDamage <= reserve) continue;
        return { ...action, targetId: Number(target.fetchId()), targetHp: hp,
            incomingDamage, attackerCount: attackers.size, reserveHp: reserve };
    }
    return null;
}

function tryFinish(session, bot, target, Generics, BotAI) {
    const decision = evaluate(session, bot, target);
    session.lastFinisherDecision = { ...(decision || {}), allowed: !!decision,
        targetId: target?.fetchId?.(), at: Date.now() };
    if (!decision) return false;
    session.currentTargetId = target.fetchId();
    bot.select({ id: target.fetchId() });
    if (bot.state.fetchSeated()) {
        bot.state.setSeated(false);
        session.dataSendToOthers(invoke('GameServer/Network/Response').sitAndStand(bot), bot);
    }
    if (bot.state.fetchHits() || bot.state.fetchCasts()) return true;
    return BotAI.executeCombat(session, bot, target, Generics, { emergencyFinisher: decision }) !== false;
}

module.exports = { evaluate, tryFinish };
