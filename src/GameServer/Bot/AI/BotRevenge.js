const Memory = invoke('GameServer/Social/InteractionMemoryRuntime');
const Policy = require('../../Social/RevengePolicy');
const { hotStanding } = require('../../Social/PvpAggression');
const Threats = invoke('GameServer/Bot/AI/BotPvpThreats');
const Risk = invoke('GameServer/Bot/AI/BotPvpRisk');
const Arena = invoke('GameServer/World/ArenaCombatRules');
const Voice = invoke('GameServer/Bot/AI/BotChatVoice');
const Budget = invoke('GameServer/Bot/AI/BotPvpChat');
const Participation = invoke('GameServer/Bot/AI/BotConflictParticipation');

const EnemyMet = require('../Population/EnemyMet');
const Situations = require('../Situations');
const { seeded } = require('./TendencyRoll');
const ENCOUNTER_MS = 30000;
const NOTICE_RADIUS = Policy.NOTICE_RADIUS;

// The bot's relation to a character (its memory and their clans' war: the memory
// runtime reads ClanWarRuntime's view, relation.war): the rule's first input, one lookup.
function relationTo(session, target, now) {
    const identity = actor => ({ id: Number(actor.fetchId()), clanId: Number(actor.fetchClanId?.() || 0),
        partyId: actor.session?.coldLifeState?.party?.partyId });
    return Memory.assess(identity(session.actor), identity(target), {}, now);
}
// The one builder of the rule's inputs on main (RevengePolicy.evaluate): the relation, the
// persona and the pair's C4 standing. A bot with karma starts no fight outside a mutual
// clan war (the rule's own karma); a red target is free.
function assessment(session, target, now, relation = relationTo(session, target, now)) {
    const standing = hotStanding(target);
    return Policy.evaluate(relation, Voice.profile(session),
        { ownKarma: hotStanding(session.actor).karma, targetKarma: standing.karma, targetFlagged: standing.flagged,
            war: relation.war?.mutual === true });
}
// A provocation or objective the bot still wants: revenge by its rule and roll; any
// other by the rule's own karma (a bot with karma starts no fight outside a mutual war).
function stillWanted(session, objective, now) {
    if (objective.reason === 'revenge') return assessment(session, objective.target, now).chance > objective.revengeRoll;
    return !Policy.startsNoFight({ ownKarma: hotStanding(session.actor).karma,
        war: invoke('GameServer/Clan/ClanWarRuntime').between(session.actor, objective.target).mutual === true });
}

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
    if (objective.reason === 'clan_war') return invoke('GameServer/Clan/ClanWarRuntime').between(session.actor, target).mutual;
    if (objective.reason === 'continued_encounter') {
        const e = session.pvpEncounter, ownId = Number(session.actor.fetchId()), targetId = Number(target.fetchId());
        const side = e?.sides.find(s => s.memberIds.includes(ownId));
        return e?.expiresAt > now && (e.reason !== 'clan_war' || invoke('GameServer/Clan/ClanWarRuntime').between(session.actor, target).mutual)
            && side && e.sides.some(s => s !== side && s.memberIds.includes(targetId))
            && ['initiator', 'target', 'support'].includes(new Map(e.roles).get(ownId));
    }
    if (!objective.startedAt && !Participation.valid(objective.participation, objective.initiator, target, now)) {
        // Both AI selection and native impact guards call allows before an
        // attack becomes a factual incident. Never revive a revoked vote if
        // the old roster returns before this objective is cleared.
        objective.participation = { blocked: true };
        return false;
    }
    if (!objective.startedAt && !stillWanted(objective.initiator, objective, now)) {
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
    if (!stillWanted(session, pending, now)) {
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
    // A war's allies are the members at mutual war with the target (onAttack recruits
    // them); any other fight's are its participation vote's.
    const allyAllowed = pending.reason === 'clan_war' ? member => warAlly(member, session, pending.target)
        : member => Participation.supports(pending.participation, member)
            && (!pending.participation || Participation.available(member, now));
    if (!pending.attack || Risk.defenseDecision(session, [pending.target], { key: pending.key, allyAllowed }).action !== 'fight') return false;
    session.pvpRevenge = { target: pending.target, initiator: session, expiresAt: now + ENCOUNTER_MS,
        reason: pending.reason, participation: pending.participation, revengeRoll: pending.revengeRoll };
    return true;
}

// The one roll of a provoked fight: the check before the warning and the
// check when the warning is sent read the same roll.
function decisionKey(session, target, reason, now) {
    return [reason, Number(session.actor.fetchId()), Number(target.fetchId()), now];
}

// A party member who may join its initiator's war fight: a bot of its own, not a
// companion, free, eligible and at mutual war with the target, near the initiator.
function warAlly(member, initiator, target) {
    return member === initiator || String(member.accountId || '').startsWith('bot_')
        && !member.partyCompanion && !member.followPlayerSession && !member.staticService && !member.arenaEphemeral
        && !member.pvpDefense && !member.pvpRevenge && !member.pvpEncounter && eligible(member, target)
        && invoke('GameServer/Clan/ClanWarRuntime').between(member.actor, target).mutual
        && Threats.distance(initiator.actor, member.actor) <= Threats.PARTY_RADIUS;
}

function request(session, target, reason, lines, attack = true, now = Date.now(), rng = Math.random, revengeRoll = null) {
    if (session.pendingPvpProvocation || session.pvpDefense || session.pvpRevenge || !eligible(session, target)) return false;
    // A war fight takes no participation vote: the clan's war decides who joins (warAlly).
    const participation = attack && reason !== 'clan_war' ? Participation.prepare(session, target, now, rng) : null;
    session.pendingPvpProvocation = { target, reason, attack: attack && !participation?.blocked && !participation?.deescalated,
        participation, revengeRoll, text: lines[Math.floor(rng() * lines.length)], key: decisionKey(session, target, reason, now),
        expiresAt: now + ENCOUNTER_MS };
    const started = flushPending(session, now);
    if (started || session.pendingPvpProvocation) invoke('GameServer/Bot/BotAI').promoteForPlayerInteraction(session, reason);
    return started;
}

// A body that may start a fight it met (enemy_met) now: a bot's own body, in the field,
// with no fight or provocation under way, able to act. A war fight also needs clan wars
// on, and no player's follower or managed encounter (the guards of the former war scan).
function ready(session, reason) {
    return String(session?.accountId || '').startsWith('bot_') && !session.arenaEphemeral && !session.staticService
        && !session.partyCompanion && !session.pvpDefense && !session.pvpRevenge && !session.pvpAggressors?.size
        && !session.pendingPvpProvocation && ['hunting', 'resting', 'following'].includes(session.plan)
        && (reason !== 'clan_war' || require('../../Clan/ClanWarConfig').enabled && !session.followPlayerSession && !session.pvpEncounter)
        && invoke('GameServer/Effects/EffectRestrictions').canUseBasicAction(session.actor);
}
const LINES = {
    revenge: name => [`${name}, we still have a score to settle.`, `I remember what you did, ${name}.`,
        `Remember me, ${name}? I haven't forgotten.`],
    // Ours: a war enemy met in the field.
    clan_war: name => [`${name}, your clan picked this war.`, `For the clan, ${name}!`]
};
// An enemy met near a player (enemy_met): the bot starts the fight its rule
// decided (reason revenge | clan_war, roll: the meeting's seeded roll, key: the meeting's)
// when its body may, the target is in reach (NOTICE_RADIUS) and it can win by what it
// sees (BotPvpRisk); seeded by the meeting, never re-rolled. Returns what happened
// (counted enemy_met:<it> on main): started | pending | not_ready | not_eligible | too_far
// | no_war | outmatched | refused. rng: the meeting's own draws (seeded by its key; a
// test may pass its own).
function meet(session, target, { reason, roll, key, rng = seeded(String(key)) }, now = Date.now()) {
    if (!ready(session, reason)) return 'not_ready';
    if (!eligible(session, target)) return 'not_eligible';
    if (Threats.distance(session.actor, target) > NOTICE_RADIUS) return 'too_far';
    if (reason === 'clan_war' && !invoke('GameServer/Clan/ClanWarRuntime').between(session.actor, target).mutual) return 'no_war';
    if (Risk.defenseDecision(session, [target], { key: decisionKey(session, target, reason, now) }).action !== 'fight') return 'outmatched';
    const name = String(target.fetchName?.() || '').replace(/[\x00-\x1f]/g, '').slice(0, 24);
    return request(session, target, reason, LINES[reason](name), true, now, rng, roll) ? 'started'
        : session.pendingPvpProvocation ? 'pending' : 'refused';
}
const counted = outcome => { Situations.note(`enemy_met:${outcome}`); return outcome; };
// Two bodies near a player met on a spot (the worker's spot_command, EnemyMet.hotCommand).
// The World's records ({ actor, session }): the bodies registered now.
function fromSpot(command, now = Date.now()) {
    const World = invoke('GameServer/World/World');
    const holder = World.registeredActorById?.(Number(command.actorId)), peer = World.registeredActorById?.(Number(command.peerId));
    const session = holder?.session || holder?.actor?.session;
    if (!session?.actor || !peer?.actor) return counted('no_body');
    return counted(meet(session, peer.actor, command, now));
}
// A player's client first receives a bot's CharInfo (CharacterVisibility.afterSend, B8): the
// bot meets the player. Its grievance (its memory) or their clans' mutual war, by the same rule,
// rolled once per (bot, player, the bot's stay: its spot post's number) and judged once a stay:
// a re-entry into view on the same stay (a teleport, a DeleteObject, a body swap) rolls nothing
// new and does nothing (session.playersMet, at most PLAYERS_A_STAY a stay, more counted). Cost:
// one memory lookup per first CharInfo of a bot to a player; the persona and the standings only
// with a grievance or a war.
const PLAYERS_A_STAY = 32;
function playerSeen(bot, player, now = Date.now()) {
    const session = bot?.session;
    if (!session || !String(session.accountId || '').startsWith('bot_') || !player || player === bot
        || String(player.session?.accountId || '').startsWith('bot_')) return null;
    const stay = Number(session.nearSpot?.seq || 0), playerId = Number(player.fetchId());
    if (session.playersMet?.stay !== stay) session.playersMet = { stay, ids: new Set() };
    const judged = session.playersMet.ids;
    if (judged.has(playerId)) return null;
    if (judged.size >= PLAYERS_A_STAY) { Situations.note('enemy_met:player_capped'); return null; }
    judged.add(playerId);
    const relation = relationTo(session, player, now);
    if (!relation?.ready || !relation.personal && relation.war?.mutual !== true) return null;
    const met = EnemyMet.player({ botId: bot.fetchId(), playerId, stay, social: assessment(session, player, now, relation) });
    if (!met) return null;
    Situations.note(`enemy_met:${met.reason}`);
    return counted(meet(session, player, { ...met, key: `enemy_met:player:${bot.fetchId()}:${playerId}:${stay}` }, now));
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
    if (objective?.reason === 'clan_war') {
        objective.startedAt ||= now;
        objective.expiresAt = now + ENCOUNTER_MS;
            for (const member of party) if (member !== session && warAlly(member, session, target)) {
            member.pvpRevenge = { ...objective, initiator: session };
        }
        return;
    }
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

module.exports = { decisionKey, request, flushPending, meet, fromSpot, playerSeen, onAttack, allows, eligible, ENCOUNTER_MS, NOTICE_RADIUS };
