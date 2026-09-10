const Memory = invoke('GameServer/Bot/AI/BotEnemyMemory');
const Threats = invoke('GameServer/Bot/AI/BotPvpThreats');
const Risk = invoke('GameServer/Bot/AI/BotPvpRisk');
const Arena = invoke('GameServer/World/ArenaCombatRules');
const Voice = invoke('GameServer/Bot/AI/BotChatVoice');
const Budget = invoke('GameServer/Bot/AI/BotPvpChat');
const Participation = invoke('GameServer/Bot/AI/BotConflictParticipation');

const SCAN_MS = 5000;
const RETRY_MS = 120000;
const ENCOUNTER_MS = 30000;
const NOTICE_RADIUS = 900;

function eligible(session, target) {
    const bot = session?.actor;
    return !!bot && !!target && bot !== target && Threats.alive(bot) && Threats.alive(target) &&
        !session.arenaEphemeral && !Arena.isArenaParticipant(bot) && !Arena.isArenaParticipant(target) &&
        Arena.canInteract(bot, target) && !Threats.inPeace(bot) && !Threats.inPeace(target) &&
        !Risk.sameParty(session, target.session) && !Risk.sameClan(bot, target);
}

function allows(session, target, now = Date.now()) {
    const objective = session?.pvpRevenge;
    if (!objective || objective.target !== target || objective.expiresAt <= now || !eligible(session, target) ||
        Threats.distance(session.actor, target) > Threats.PARTY_RADIUS) return false;
    if (objective.reason === 'continued_encounter') {
        const e = session.pvpEncounter, ownId = Number(session.actor.fetchId()), targetId = Number(target.fetchId());
        const side = e?.sides.find(s => s.memberIds.includes(ownId));
        return e?.expiresAt > now && side && e.sides.some(s => s !== side && s.memberIds.includes(targetId))
            && ['initiator', 'target', 'support'].includes(new Map(e.roles).get(ownId));
    }
    if (!objective.startedAt && !Participation.valid(objective.participation, objective.initiator, target, now)) {
        // Both AI selection and native impact guards call allows before an
        // attack becomes a factual incident. Never revive a revoked vote if
        // the old roster returns before this objective is cleared.
        objective.participation = { blocked: true };
        return false;
    }
    return Participation.supports(objective.participation, session)
        && (objective.initiator === session || Risk.sameParty(session, objective.initiator));
}

function flushPending(session, now = Date.now()) {
    const pending = session?.pendingPvpProvocation;
    if (!pending) return false;
    if (pending.expiresAt <= now || session.pvpDefense || session.pvpRevenge ||
        !['hunting', 'following', 'resting'].includes(session.plan) ||
        !eligible(session, pending.target) || Threats.distance(session.actor, pending.target) > NOTICE_RADIUS ||
        Threats.context(session, now).threats.length > 0) {
        // An actual attack supersedes an unsent provocation. Let defense
        // evaluate the current enemies before granting any first-strike permission.
        delete session.pendingPvpProvocation;
        return false;
    }
    if (!Participation.valid(pending.participation, session, pending.target, now)) {
        // A changed roster cannot inherit a previous vote or obtain a new roll.
        delete session.pendingPvpProvocation;
        return false;
    }
    if (!invoke('GameServer/Effects/EffectRestrictions').canUseBasicAction(session.actor) ||
        !session.dataSendToOthers || !Budget.canSend(session, pending.reason, now)) return false;
    session.dataSendToOthers(invoke('GameServer/Network/Response').speak(session.actor,
        { kind: 0, text: pending.text }), session.actor);
    Budget.record(session, pending.reason, now);
    session.nextPvpChatAt = now + ENCOUNTER_MS;
    delete session.pendingPvpProvocation;
    if (!pending.attack || Risk.defenseDecision(session, [pending.target], {
        allyAllowed: member => Participation.supports(pending.participation, member)
            && (!pending.participation || Participation.available(member, now))
    }).action !== 'fight') return false;
    session.pvpRevenge = { target: pending.target, initiator: session, expiresAt: now + ENCOUNTER_MS,
        reason: pending.reason, participation: pending.participation };
    return true;
}

function request(session, target, reason, lines, attack = true, now = Date.now(), rng = Math.random) {
    if (session.pendingPvpProvocation || session.pvpDefense || session.pvpRevenge || !eligible(session, target)) return false;
    const participation = attack ? Participation.prepare(session, target, now, rng) : null;
    if (participation) session.lastConflictParticipation = { ...participation, reason };
    session.pendingPvpProvocation = { target, reason, attack: attack && !participation?.blocked && !participation?.deescalated,
        participation, text: lines[Math.floor(rng() * lines.length)],
        expiresAt: now + ENCOUNTER_MS };
    const started = flushPending(session, now);
    if (started || session.pendingPvpProvocation) invoke('GameServer/Bot/BotAI').promoteForPlayerInteraction(session, reason);
    return started;
}

function tryStart(session, now = Date.now(), rng = Math.random) {
    // Clear karma through hunting before initiating another revenge fight.
    if (session?.actor?.fetchKarma?.() > 0) {
        delete session.pendingPvpProvocation;
        return false;
    }
    if (session?.pendingPvpProvocation) return flushPending(session, now);
    if (!String(session?.accountId || '').startsWith('bot_') || session.arenaEphemeral ||
        session.staticService || session.pvpDefense || session.pvpRevenge || session.pvpAggressors?.size ||
        !['hunting', 'resting', 'following'].includes(session.plan) ||
        now < Number(session.nextRevengeAt || 0)) return false;
    if (!invoke('GameServer/Effects/EffectRestrictions').canUseBasicAction(session.actor)) return false;
    const enemies = Memory.entries(session).filter(entry => entry.kills >= 2);
    if (!enemies.length || now < Number(session.nextRevengeScanAt || 0)) return false;
    session.nextRevengeScanAt = now + SCAN_MS;
    for (const enemy of enemies) {
        const target = invoke('GameServer/Bot/AI/BotPvpIndex').actor(enemy.id);
        if (!eligible(session, target) || Threats.distance(session.actor, target) > NOTICE_RADIUS) continue;
        const decision = Risk.defenseDecision(session, [target]);
        if (decision.action !== 'fight') continue;
        session.nextRevengeAt = now + RETRY_MS;
        if (rng() >= 0.2 + 0.5 * Voice.trait(session, 'assertiveness')) return false;
        const name = String(target.fetchName?.() || enemy.name).replace(/[\x00-\x1f]/g, '').slice(0, 24);
        const lines = [
            `${name}, I remember you killing me. Time to settle this.`,
            `You killed me more than once, ${name}. My turn.`,
            `Remember me, ${name}? I haven't forgotten.`
        ];
        return request(session, target, 'revenge', lines, true, now, rng);
    }
    return false;
}

// Party commitment begins with an actual hostile action, including a miss or
// resisted control. Only that target receives permission for a first strike.
function onAttack(attacker, target, now = Date.now(), rng = Math.random) {
    const session = attacker?.session;
    // The original vote already assigned every member; do not recruit bystanders again.
    if (session?.pvpRevenge?.reason === 'continued_encounter') return;
    if (!String(session?.accountId || '').startsWith('bot_') || !eligible(session, target)) return;
    let objective = session.pvpRevenge;
    if (!objective && session.pvpDefense) return; // self-defense already shares aggressors
    if (objective && !allows(session, target, now)) return;
    const party = Threats.members(session);
    if (!objective) {
        if (party.length < 2) return;
        const participation = Participation.prepare(session, target, now, rng);
        // The first hit already happened. A calming vote can withhold proactive
        // party assistance, but must not rewrite the attack as a peaceful event.
        objective = { target, initiator: session, reason: 'party_attack', participation };
        session.pvpRevenge = objective;
    }
    if (!objective.startedAt) {
        objective.startedAt = now;
        if (!Participation.valid(objective.participation, objective.initiator, target, now)) {
            objective.participation = { blocked: true };
        }
    }
    objective.expiresAt = now + ENCOUNTER_MS;
    for (const member of party) {
        if (!String(member.accountId || '').startsWith('bot_') || member === session ||
            !Participation.supports(objective.participation, member) || member.staticService || member.arenaEphemeral ||
            (member.pvpRevenge !== objective && objective.participation && !Participation.available(member, now)) ||
            !eligible(member, target) || Threats.distance(member.actor, attacker) > Threats.PARTY_RADIUS ||
            member.pvpDefense || member.pendingPvpProvocation ||
            !invoke('GameServer/Effects/EffectRestrictions').canUseBasicAction(member.actor) ||
            (member.pvpRevenge && member.pvpRevenge !== objective)) continue;
        const joined = member.pvpRevenge !== objective;
        member.pvpRevenge = objective;
        member.nextPvpChatAt = Math.max(Number(member.nextPvpChatAt || 0), now + 30000);
        if (joined) invoke('GameServer/Bot/BotAI').promoteForPlayerInteraction(member, 'party_pvp_attack');
    }
}

module.exports = { request, flushPending, tryStart, onAttack, allows, eligible, SCAN_MS, RETRY_MS, ENCOUNTER_MS, NOTICE_RADIUS };
