const Threats = invoke('GameServer/Bot/AI/BotPvpThreats');
const Risk = invoke('GameServer/Bot/AI/BotPvpRisk');
const Revenge = invoke('GameServer/Bot/AI/BotRevenge');
const Voice = invoke('GameServer/Bot/AI/BotChatVoice');

const CLAIM_MS = 15000;
const COOLDOWN_MS = 120000;
const claims = new WeakMap();
const { randomUUID } = require('crypto');

function attackChance(session) {
    return 0.02 + 0.78 * Voice.trait(session, 'assertiveness') *
        (1 - 0.75 * Voice.trait(session, 'empathy')) * (1 - 0.5 * Voice.trait(session, 'caution'));
}

// Called when an accepted swing/cast begins, with a damage fallback for
// summons and secondary skill targets. Selection and NPC proximity grant no claim.
function record(source, mob, now = Date.now(), rng = Math.random) {
    if (mob?.fetchKind?.() !== 'Monster' || mob.fetchIsRaidBoss?.() || mob.minionBossObjectId ||
        mob.state?.fetchDead?.() || mob.fetchHp?.() <= 0) return false;
    const attacker = Threats.character(source);
    if (!attacker?.session || !Threats.alive(attacker)) return false;
    let claim = claims.get(mob);
    if (!claim || now - claim.at > CLAIM_MS || !Threats.alive(claim.owner) ||
        claim.owner.session?.actor !== claim.owner) {
        claims.set(mob, { owner: attacker, at: now, considered: false });
        return false;
    }
    if (claim.owner === attacker) { claim.at = now; return false; }
    const session = claim.owner.session;
    if (!claim.memoryEvent && !claim.memoryConsidered && String(session.accountId || '').startsWith('bot_') &&
        !session.staticService && !session.arenaEphemeral &&
        ['hunting', 'following'].includes(session.plan) &&
        Number(session.currentTargetId) === Number(mob.fetchId()) &&
        !Risk.sameParty(session, attacker.session) &&
        Threats.distance(claim.owner, attacker) <= Revenge.NOTICE_RADIUS &&
        !invoke('GameServer/World/ArenaCombatRules').isArenaParticipant(attacker) &&
        !invoke('GameServer/World/ArenaCombatRules').isArenaParticipant(claim.owner)) {
        claim.memoryEvent = { key: `mob:${randomUUID()}`, sourceId: Number(claim.owner.fetchId()),
            targetId: Number(attacker.fetchId()), type: 'mob_contested', at: now };
    }
    if (claim.memoryEvent && invoke('GameServer/Social/InteractionMemoryRuntime').events.enqueue(claim.memoryEvent)) {
        claim.memoryConsidered = true;
        claim.memoryEvent = null;
    }
    if (claim.considered) return false;
    if (!String(session.accountId || '').startsWith('bot_') || session.staticService ||
        !['hunting', 'following'].includes(session.plan) || session.pvpDefense || session.pvpRevenge || session.pendingPvpProvocation ||
        Number(session.currentTargetId) !== Number(mob.fetchId()) ||
        !Revenge.eligible(session, attacker) || Threats.distance(claim.owner, attacker) > Revenge.NOTICE_RADIUS ||
        !invoke('GameServer/Effects/EffectRestrictions').canUseBasicAction(claim.owner)) return false;
    // One decision for this mob, not another roll on every swing or DoT tick.
    claim.considered = true;
    if (now < Number(session.nextMobCompetitionAt || 0)) return false;
    session.nextMobCompetitionAt = now + COOLDOWN_MS;
    const name = String(attacker.fetchName?.() || 'You').replace(/[\x00-\x1f]/g, '').slice(0, 24);
    const lines = Voice.trait(session, 'assertiveness') > 0.6
        ? [`${name}, I started on this mob. Back off.`, `Find your own mob, ${name}. I'm not sharing this one.`]
        : [`${name}, I was already fighting this mob. Please find another.`, `I don't like you taking my mob, ${name}.`];
    const attack = rng() < attackChance(session) && Risk.defenseDecision(session, [attacker]).action === 'fight';
    const started = Revenge.request(session, attacker, 'mob_competition', lines, attack, now, rng);
    return started;
}

module.exports = { record, attackChance, reset(mob) { claims.delete(mob); }, CLAIM_MS, COOLDOWN_MS };
