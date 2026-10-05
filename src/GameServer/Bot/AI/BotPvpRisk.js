const Config = require('../Population/PopulationConfig');
const Aggression = require('../../Social/PvpAggression');
const Visible = require('../../Social/VisibleStrength');

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
    const aggression = Aggression.normalize(Config.pvpAggression);
    score += (aggression - 0.5) * 1.5;
    const noInitiation = aggression === 0 && !context.targetedByThreat;
    if (noInitiation) reasons.push('passive_pvp');

    return {
        action: !noInitiation && score >= 0 ? 'fight' : 'flee',
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
    const resources = Visible.resources(hpRatio, cpRatio, mpRatio, manaDependent);
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

// The threats and their party members near them: the people a defender sees.
function opponentsOf(session, threats) {
    const Threats = invoke('GameServer/Bot/AI/BotPvpThreats');
    const opponents = new Map(threats.map(actor => [actorId(actor), actor]));
    for (const threat of threats) for (const member of Threats.members(threat.session)) {
        if (member.actor !== session.actor && !sameParty(session, member) && !sameClan(session.actor, member.actor) &&
            !Threats.inPeace(member.actor) && Threats.distance(threat, member.actor) <= Threats.PARTY_RADIUS) opponents.set(actorId(member.actor), member.actor);
    }
    return opponents;
}

// One's own condition, exact (Social/VisibleStrength.condition).
function condition(actor) {
    const maxCp = Number(actor?.fetchMaxCp?.() || 0);
    return Visible.condition(ratio(actor?.fetchHp?.(), actor?.fetchMaxHp?.()), ratio(actor?.fetchCp?.(), maxCp, 0),
        ratio(actor?.fetchMp?.(), actor?.fetchMaxMp?.()), invoke('GameServer/Bot/AI/BotRoles').shouldRestForMana(actor), maxCp > 0);
}

// How much the bot fears the most feared of these characters (interaction memory).
function fearOf(actor, others, now = Date.now()) {
    const Memory = invoke('GameServer/Social/InteractionMemoryRuntime');
    const self = actorId(actor);
    let fear = 0;
    for (const other of others) {
        const id = actorId(other);
        if (self > 0 && id > 0 && id !== self) fear = Math.max(fear, Visible.fear(Memory.assess({ id: self }, { id }, {}, now)));
    }
    return fear;
}

// Can I win? Own side exactly, the other side by what a player sees (U26).
function defenseDecision(session, threats, { allyAllowed = () => true } = {}) {
    const Threats = invoke('GameServer/Bot/AI/BotPvpThreats');
    const allies = Threats.members(session).filter(member => member !== session && allyAllowed(member) &&
        !Threats.inPeace(member.actor) && Threats.distance(session.actor, member.actor) <= Threats.PARTY_RADIUS);
    const opponents = opponentsOf(session, threats);
    const voice = invoke('GameServer/Bot/AI/BotChatVoice');
    const traits = { caution: voice.trait(session, 'caution'), assertiveness: voice.trait(session, 'assertiveness'),
        empathy: voice.trait(session, 'empathy') };
    const avoidsPvp = Visible.avoidsPvp(traits);
    const own = [session.actor, ...allies.map(member => member.actor)];
    const verdict = Visible.canWin({
        own: { look: Visible.best(own.map(Visible.actorLook)), people: own.length,
            strength: own.reduce((sum, actor) => sum + condition(actor), 0) },
        other: { look: Visible.best([...opponents.values()].map(Visible.actorLook)), people: opponents.size },
        traits, fear: fearOf(session.actor, threats) });
    const fight = !avoidsPvp && verdict.fight;
    return {
        action: fight ? 'fight' : 'flee',
        score: verdict.ratio,
        verdict: verdict.verdict,
        allyIds: allies.map(member => actorId(member.actor)),
        enemyIds: [...opponents.keys()],
        requiredRatio: avoidsPvp ? null : verdict.required,
        reasons: [avoidsPvp ? 'avoids_pvp' : fight ? 'can_win' : 'outmatched', 'self_defense'],
        criticalFleeChance: Aggression.retreatChance(0.15 + 0.45 * traits.caution
            + 0.25 * (1 - voice.trait(session, 'resilience')), Config.pvpAggression)
    };
}

module.exports = { evaluate, isCombatAlly, sameClan, sameParty, combatStrength, defenseDecision, opponentsOf, fearOf };
