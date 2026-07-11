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
    return !!aLeader && aLeader === bLeader;
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

module.exports = { evaluate, isCombatAlly, sameClan, sameParty };
