function actorId(actor) {
    return Number(actor?.fetchId?.()) || 0;
}

function sameClan(a, b) {
    const aClan = Number(a?.fetchClanId?.()) || 0;
    const bClan = Number(b?.fetchClanId?.()) || 0;
    return aClan > 0 && aClan === bClan;
}

function sameParty(aSession, bSession) {
    if (!aSession || !bSession) return false;
    const aLeader = aSession.partyCompanion === true ? aSession.followPlayerSession : aSession;
    const bLeader = bSession.partyCompanion === true ? bSession.followPlayerSession : bSession;
    if (aLeader && aLeader === bLeader) return true;
    if (aSession.partyCompanion || bSession.partyCompanion) return false;
    const aParty = aSession.coldLifeState?.party?.partyId;
    const bParty = bSession.coldLifeState?.party?.partyId;
    return !!aParty && aParty !== 'forming' && aParty === bParty;
}

function isCombatAlly(botSession, otherSession, threat) {
    const bot = botSession?.actor;
    const other = otherSession?.actor;
    const threatId = actorId(threat);
    if (!bot || !other || other === bot || actorId(other) === threatId) return false;
    if (!other.fetchIsOnline?.() || other.state?.fetchDead?.()) return false;
    if (sameClan(bot, other) || sameParty(botSession, otherSession)) return true;

    return Number(otherSession.currentTargetId || other.fetchDestId?.() || 0) === threatId;
}

function evaluate(context = {}) {
    const botLevel = Math.max(1, Number(context.botLevel) || 1);
    const threatLevel = Math.max(1, Number(context.threatLevel) || 1);
    const hpRatio = Math.max(0, Math.min(1, Number(context.hpRatio) || 0));
    const mpRatio = Math.max(0, Math.min(1, Number(context.mpRatio) || 0));
    const allies = Math.max(0, Number(context.allies) || 0);
    const reasons = [];
    let score = (botLevel - threatLevel) * 1.25 + allies * 1.4;

    if (context.targetedByThreat) {
        score += 0.75;
        reasons.push('self_defense');
    }
    if (hpRatio < 0.25) {
        score -= 3.5;
        reasons.push('critical_hp');
    } else if (hpRatio < 0.45) {
        score -= 1.75;
        reasons.push('low_hp');
    }
    if (['mage', 'healer', 'buffer'].includes(context.role) && mpRatio < 0.20) {
        score -= 1.25;
        reasons.push('low_mp');
    }
    if (context.role === 'healer' || context.role === 'buffer') {
        score -= 0.35;
        reasons.push('support_role');
    }
    if (allies > 0) reasons.push(`allies:${allies}`);
    reasons.push(`level_delta:${botLevel - threatLevel}`);

    return {
        action: score >= 0 ? 'fight' : 'flee',
        score: Math.round(score * 100) / 100,
        reasons
    };
}

function ratio(value, max, fallback = 1) {
    return max > 0 ? Math.max(0, Math.min(1, Number(value || 0) / max)) : fallback;
}

// A bounded heuristic, not a simulated or calibrated win probability. Prices
// inform relative equipment strength without letting one expensive accessory
// erase a large level/resource disadvantage.
function combatStrength(actor, { includeSummon = true } = {}) {
    const level = Math.max(1, Number(actor?.fetchLevel?.() || 1));
    const gearValue = invoke('GameServer/Item/EquipmentValue').liveEquipmentValue(actor);
    const hpRatio = ratio(actor?.fetchHp?.(), actor?.fetchMaxHp?.());
    const mpRatio = ratio(actor?.fetchMp?.(), actor?.fetchMaxMp?.());
    const cpRatio = ratio(actor?.fetchCp?.(), actor?.fetchMaxCp?.(), 0);
    const manaDependent = invoke('GameServer/Bot/AI/BotRoles').shouldRestForMana(actor);
    const gearFactor = 1 + Math.log1p(gearValue / Math.max(1000, level * level * 50));
    const resources = Math.max(0.03, hpRatio + 0.25 * cpRatio) * (manaDependent ? 0.2 + 0.8 * mpRatio : 0.9 + 0.1 * mpRatio);
    const clamp = (value, low = 0.5, high = 2) => Math.max(low, Math.min(high, value));
    const relative = (value, baseline) => Number(value) > 0 ? clamp(Number(value) / baseline) : 1;
    // Collective stats include equipment bonuses and active buffs. Missing
    // values retain the level/gear fallback used by lightweight actors.
    const offense = manaDependent ? actor?.fetchCollectiveMAtk?.() : actor?.fetchCollectivePAtk?.();
    const speed = manaDependent ? actor?.fetchCollectiveCastSpd?.() : actor?.fetchCollectiveAtkSpd?.();
    const defense = Math.sqrt(relative(actor?.fetchCollectivePDef?.(), level * 8) * relative(actor?.fetchCollectiveMDef?.(), level * 6));
    const combatFactor = Math.sqrt(relative(offense, level * 5) * relative(speed, 333) * defense);
    const Potions = invoke('GameServer/Bot/AI/HealingPotionStock');
    const stock = (actor?.backpack?.fetchItems?.() || []).reduce((sum, item) => {
        const potion = Potions.POTIONS.find(entry => entry.selfId === Number(item.fetchSelfId?.() || item.selfId));
        return sum + (potion ? potion.heal * Math.min(3, Math.max(0, Number(item.fetchAmount?.() ?? item.amount ?? 0))) : 0);
    }, 0);
    const supplyFactor = 1 + Math.min(0.25, stock / Math.max(1, Number(actor?.fetchMaxHp?.() || 1)) * 0.15);
    let power = Math.pow(level + 5, 2.3) * gearFactor * resources * combatFactor * supplyFactor;
    const summon = actor?.summon || actor?.pet;
    const summonPower = includeSummon && summon && !summon.state?.fetchDead?.() && !summon.isDead?.()
        ? combatStrength(summon, { includeSummon: false }).power : 0;
    power += summonPower;
    return { level, gearValue, hpRatio, mpRatio, cpRatio, combatFactor, supplyFactor, summonPower, power };
}

function defenseDecision(session, threats) {
    const Threats = invoke('GameServer/Bot/AI/BotPvpThreats');
    const own = combatStrength(session.actor);
    const allies = Threats.members(session).filter(member => member !== session &&
        !Threats.inPeace(member.actor) && Threats.distance(session.actor, member.actor) <= Threats.PARTY_RADIUS);
    const opponents = new Map(threats.map(actor => [actorId(actor), actor]));
    for (const threat of threats) for (const member of Threats.members(threat.session)) {
        if (member.actor !== session.actor && !sameParty(session, member) && !sameClan(session.actor, member.actor) &&
            !Threats.inPeace(member.actor) && Threats.distance(threat, member.actor) <= Threats.PARTY_RADIUS) opponents.set(actorId(member.actor), member.actor);
    }
    const enemies = [...opponents.values()].map(actor => combatStrength(actor));
    const enemyPower = enemies.reduce((sum, entry) => sum + entry.power, 0);
    const allyPower = allies.reduce((sum, member) => sum + combatStrength(member.actor).power, 0);
    const strengthRatio = (own.power + allyPower) / Math.max(1, enemyPower);
    const voice = invoke('GameServer/Bot/AI/BotChatVoice');
    const caution = voice.trait(session, 'caution');
    const assertiveness = voice.trait(session, 'assertiveness');
    const empathy = voice.trait(session, 'empathy');
    const avoidsPvp = caution >= 0.7 && assertiveness <= 0.4 && empathy >= 0.6;
    const requiredRatio = avoidsPvp ? Infinity : 0.9 + 0.55 * caution - 0.35 * assertiveness;
    return {
        action: strengthRatio >= requiredRatio ? 'fight' : 'flee',
        score: Math.round(strengthRatio * 100) / 100,
        own,
        allyPower,
        allyIds: allies.map(member => actorId(member.actor)),
        enemyIds: [...opponents.keys()],
        enemies,
        requiredRatio: Number.isFinite(requiredRatio) ? requiredRatio : null,
        reasons: [avoidsPvp ? 'avoids_pvp' : strengthRatio >= requiredRatio ? 'can_win' : 'outmatched', 'self_defense'],
        criticalFleeChance: 0.15 + 0.45 * caution + 0.25 * (1 - voice.trait(session, 'resilience'))
    };
}

module.exports = { evaluate, isCombatAlly, sameClan, sameParty, combatStrength, defenseDecision };
