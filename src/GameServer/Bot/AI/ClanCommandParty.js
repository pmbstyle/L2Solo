'use strict';

// A command party owns its ordinary nine-person support/loot scope. Only
// offensive decisions and movement orders are shared with the commander.
const publish = require('../../World/PartyMembershipPublication');
const posture = invoke('GameServer/Actor/Generics/Posture');
const { randomUUID } = require('node:crypto');
const groupFor = session => session?.clanCommandParty?.active ? session.clanCommandParty : null;
const commanderFor = session => groupFor(session)?.commander || session;
const companion = () => invoke('GameServer/Bot/AI/PartyCompanionService');
const awareness = () => invoke('GameServer/Bot/AI/PartyAwareness');
const loc = actor => ({ locX: actor.fetchLocX(), locY: actor.fetchLocY(), locZ: actor.fetchLocZ() });
const distance = (a, b) => Math.hypot(a.locX - b.locX, a.locY - b.locY, a.locZ - b.locZ);

function roster(group) {
    return [...group.members].filter(session => session.actor && session.clanCommandParty === group);
}

function authorized(player) {
    const actor = player?.actor;
    if (!actor || actor.fetchIsOnline?.() === false || player.partyCompanion) return false;
    const clan = invoke('GameServer/Clan/ClanService').findById(Number(actor.fetchClanId?.()));
    return !!clan && Number(clan.leaderId) === Number(actor.fetchId());
}

function current(group) {
    return group.active && group.commander.actor === group.commanderActor && authorized(group.commander)
        && group.commander.commandParties?.get(group.number) === group;
}

function combatSessions(owner, options = {}) {
    const commander = commanderFor(owner);
    const own = awareness().partySessions(commander, options);
    if (!commander?.commandParties?.size) return own;
    const groups = [...(commander?.commandParties?.values() || [])].filter(current);
    const members = [...own, ...groups.flatMap(roster)];
    return [...new Set(members)].filter(session => options.includeDead ||
        session.actor?.fetchIsOnline?.() !== false && !session.actor?.isDead?.());
}

function wake(group) {
    for (const session of roster(group)) invoke('GameServer/Bot/BotAI').wakeup(session, { urgent: true });
}

function setLeader(group, leader) {
    const previous = group.owner;
    for (const key of ['partyRevivalAttempt', 'pvpHealClaims']) {
        if (previous && previous !== leader && previous[key]) {
            leader[key] = previous[key];
            delete previous[key];
        }
    }
    group.owner = leader;
    for (const session of roster(group)) {
        session.followPlayerSession = leader;
        for (const key of ['resumeAfterBuff', 'resumeAfterShopping']) {
            const resume = session[key];
            if (resume?.plan === 'following') resume.followPlayerSession = leader;
        }
    }
    publish(roster(group), invoke);
    awareness().invalidateThreatProjection(group.commander);
}

function memberAttached(owner, session) {
    const group = groupFor(owner);
    if (!group) return;
    session.clanCommandParty = group;
    group.members.add(session);
    if (group.owner === owner && !group.leaderAssigned) {
        group.leaderAssigned = true;
        group.lootLeaderId = session.actor.fetchId();
        setLeader(group, session);
    }
    session.followPlayerSession = group.owner;
    awareness().invalidateThreatProjection(group.commander);
}

function memberDetached(session) {
    const group = session.clanCommandParty;
    // Invalidate in place too: a town callback may already hold the snapshot.
    for (const key of ['resumeAfterBuff', 'resumeAfterShopping']) {
        const resume = session[key];
        if (resume?.plan !== 'following') continue;
        Object.assign(resume, { plan: 'hunting', followPlayerSession: null, partyCompanion: false });
        delete session[key];
    }
    if (session.preBuffPlan === 'following') session.preBuffPlan = 'hunting';
    if (!group) return;
    group.members.delete(session);
    delete session.clanCommandParty;
    if (group.active) {
        if (!group.members.size) {
            group.active = false;
            group.commander.commandParties?.delete(group.number);
        } else if (group.owner === session) setLeader(group, roster(group)[0]);
        awareness().invalidateThreatProjection(group.commander);
    }
}

function dismiss(group) {
    group.active = false;
    group.commander.commandParties?.delete(group.number);
    for (const session of roster(group)) {
        const options = { source: 'command_party_dismissed', rebuildWindow: false, refreshPanel: false };
        if (!companion().detach(group.owner, session, options)) {
            if (!companion().clearCompanion(session, options)) memberDetached(session);
        }
        invoke('GameServer/Bot/BotAI').wakeup(session, { urgent: true });
    }
    awareness().invalidateThreatProjection(group.commander);
}

function dismissAll(commander) {
    for (const group of [...(commander?.commandParties?.values() || [])]) dismiss(group);
}

async function recruit(group, name, isCurrent) {
    const commander = group.commander;
    const partyOwner = group.owner;
    const invitationCurrent = () => current(group) && group.owner === partyOwner && (!isCurrent || isCurrent());
    if (!invitationCurrent()) return false;
    const Manager = invoke('GameServer/Bot/BotManager');
    const subject = Manager.findSessionByName(name) || await invoke('GameServer/Bot/Population/BotLifeState').findByName(name);
    if (!invitationCurrent() || !subject || !invoke('GameServer/Bot/AI/ClanLeaderPartyInvite').isLeaderFor(commander, subject)) return false;
    if (groupFor(subject) === group) return true;
    // A main-party member must be removed explicitly before being reassigned.
    if (subject.partyCompanion && subject.followPlayerSession === commander) return false;
    return invoke('GameServer/Bot/AI/ClanLeaderPartyInvite').request(commander, commander.actor, subject,
        undefined, 'command_party_invite', { partyOwner, isCurrent: invitationCurrent });
}

function movement(group, order) {
    if (order === 'regroup') group.beforeRegroup = group.movement === 'regroup' ? group.beforeRegroup : group.movement;
    group.movement = order;
    group.regroupUntil = order === 'regroup' ? Date.now() + 20000 : 0;
    for (const session of roster(group)) {
        const away = ['shopping', 'getting_buffed', 'merchant'].includes(session.plan) || !!session.supplyErrandPhase;
        applyMemberOrder(session, { joining: away });
        if (away) continue;
        session.lastFollowMoveTarget = null;
        if (!session.actor.state?.fetchCasts?.()) invoke('GameServer/Bot/AI/BotPvpTactics').stop(session, session.actor);
        session.currentTargetId = undefined;
        session.actor.unselect?.();
    }
    wake(group);
}

function applyMemberOrder(session, { joining = false } = {}) {
    const group = groupFor(session);
    if (!group) return;
    session.botStay = group.movement === 'hold';
    session.stayLocation = session.botStay
        ? (joining || session.pendingActorTeleport ? formationTarget(session) : null) || loc(session.actor) : null;
    for (const key of ['resumeAfterBuff', 'resumeAfterShopping']) {
        const resume = session[key];
        if (resume?.plan === 'following') {
            resume.botStay = session.botStay;
            resume.stayLocation = session.stayLocation;
        }
    }
}

function regrouping(group) {
    if (group.movement !== 'regroup') return false;
    const arrived = roster(group).filter(s => !s.actor.isDead?.()).every(s => {
        const target = formationTarget(s);
        return !!target && distance(loc(s.actor), target) <= 120;
    });
    if (Date.now() >= group.regroupUntil || arrived) {
        const previous = group.beforeRegroup || 'follow';
        movement(group, previous);
        return false;
    }
    return true;
}

function handleMovement(session, bot) {
    const group = groupFor(session);
    if (!group || !regrouping(group)) return false;
    if (bot.state?.fetchCasts?.()) return true;
    session.currentTargetId = undefined;
    const target = formationTarget(session);
    if (!target) return false;
    if (distance(loc(bot), target) > 100 && !bot.state?.fetchTowards?.()
        && invoke('GameServer/Effects/EffectRestrictions').canMove(bot)) bot.moveTo({ from: loc(bot), to: target });
    session.lastDecision = { action: 'command_party_regroup', at: Date.now() };
    return true;
}

function canAttack(session, target) {
    if (!target) return true;
    const group = groupFor(session);
    const commander = group?.commander || session?.followPlayerSession;
    if (session?.partyCompanion && commander?.commandParties?.size) {
        const Safety = invoke('GameServer/Bot/AI/BotRaidSafety');
        if (Safety.isProtectedRaidEntity(target) && !Safety.canEngagePlayerPartyRaid(session, target, commander)) return false;
    }
    if (!group) return true;
    if (regrouping(group)) return false;
    return !session.botStay || !session.stayLocation || distance(session.stayLocation, loc(target)) <= 900;
}

function canTaunt(session, target) {
    const group = groupFor(session);
    if (!group) return true;
    if (invoke('GameServer/Bot/AI/BotRaidSafety').isRaidBoss(target)) return false;
    const victimId = Number(target.fetchDestId?.());
    return !combatSessions(group.commander).some(member => member !== session
        && Number(member.actor.fetchId()) === victimId
        && invoke('GameServer/Bot/AI/BotSkillCapabilities').aggressionSkill(member.actor));
}

function formationTarget(session) {
    const group = groupFor(session);
    if (!group || !current(group)) return null;
    const commander = group.commander.actor;
    const members = roster(group), index = Math.max(0, members.indexOf(session));
    const angle = (Number(commander.fetchHead?.() || 0) / 65536) * Math.PI * 2;
    const side = group.number % 2 ? 1 : -1;
    const x = -220 - Math.floor(index / 3) * 100;
    const y = side * (300 + Math.floor((group.number - 1) / 2) * 300) + (index % 3 - 1) * 90;
    return { locX: Math.round(commander.fetchLocX() + x * Math.cos(angle) - y * Math.sin(angle)),
        locY: Math.round(commander.fetchLocY() + x * Math.sin(angle) + y * Math.cos(angle)), locZ: commander.fetchLocZ() };
}

function followLeader(session, bot) {
    const group = groupFor(session);
    if (!group || session !== group.owner || session.currentTargetId || bot.state?.fetchCasts?.() || bot.state?.fetchHits?.()) return false;
    const target = session.botStay ? session.stayLocation : formationTarget(session);
    if (!target || distance(loc(bot), target) <= 100 || bot.state?.fetchTowards?.()) return true;
    if (invoke('GameServer/Effects/EffectRestrictions').canMove(bot)) bot.moveTo({ from: loc(bot), to: target });
    return true;
}

function syncLoot(commander) {
    for (const group of commander?.commandParties?.values() || []) {
        if (!group.active) continue;
        group.owner.lastGroundLootScanAt = 0;
        if (!companion().getSettings(commander).lootPickupEnabled) {
            for (const member of roster(group)) companion().cancelGroundPickup(member);
        }
    }
}

function prepareRaid(group, session, Generics, bossId, { combat = false } = {}) {
    if (group.raidReadyFor === bossId) return false;
    const members = roster(group).filter(s => !s.actor.isDead?.() && s.actor.fetchIsOnline?.() !== false);
    const Support = invoke('GameServer/Bot/AI/BotSupportPlanner');
    const waitingForSupport = member => !!(member.activeSupportCast && member.actor.state?.fetchCasts?.())
        || Number(member.pendingSupportCast?.expiresAt || 0) > Date.now();
    const pending = members.some(waitingForSupport);
    const action = pending ? null : Support.nextPartyAction(members.map(s => ({ actor: s.actor, leader: s === group.owner })),
        members.map(s => s.actor), { partyMusicLast: true });
    if (action?.provider === session.actor) {
        const bot = session.actor;
        invoke('GameServer/Bot/AI/BotPvpTactics').stop(session, bot);
        if (bot.state?.fetchSeated?.()) {
            posture(session, bot, false);
        }
        Support.queueSupportCast(session, action);
        Generics.skillExec(session, bot, { id: action.target.fetchId(), selfId: action.skill.fetchSelfId(), ctrl: false });
    }
    // The commander may open before support has recovered from buffing. Once
    // combat starts, only the provider owns its preparation action slot;
    // ready damage dealers must join instead of waiting for everyone's MP.
    if (pending || action) return !combat || action?.provider === session.actor || waitingForSupport(session);
    if (!combat && !members.every(s => invoke('GameServer/Bot/AI/RestPolicy').raidReady(s.actor, { hp: s.actor.fetchHp(), maxHp: s.actor.fetchMaxHp(), mp: s.actor.fetchMp(), maxMp: s.actor.fetchMaxMp() }))) {
        session.actor.automation?.replenishVitals?.(session.actor);
        return true;
    }
    group.raidReadyFor = bossId;
    return false;
}

function reply(player, text) {
    player.dataSendToMe(invoke('GameServer/Network/Response').speak(player.actor, { kind: 0, text }));
}

function handleCommand(player, text, isCurrent) {
    const input = String(text || '').trim();
    const match = /^(?:\.(createparty|parties)(?:\s+(.*))?|\.(invite|intive|kick|leader|dismiss)-p([1-9]\d*)(?:\s+(.*))?|\.(p[1-9]\d*|all|main)\s+(hold|follow|regroup))$/i.exec(input);
    if (!match) return false;
    if (!authorized(player) || !companion().membersForLeader(player).length) {
        reply(player, 'A clan leader with an active main party is required.');
        return true;
    }
    const action = (match[1] || match[3] || '').toLowerCase();
    if (action === 'parties') {
        for (const group of player.commandParties?.values() || []) reply(player,
            `p${group.number}: ${group.owner.actor?.fetchName?.() || 'assembling'}; ${roster(group).length}/9; ${group.movement}; `
            + roster(group).map(s => `${s.actor.fetchName()}${s.actor.isDead?.() ? ' (dead)' : ''}`).join(', '));
        if (!player.commandParties?.size) reply(player, 'No additional parties.');
        return true;
    }
    if (action === 'createparty') {
        const name = match[2]?.trim();
        if (!name) { reply(player, 'Usage: .createparty <leader>'); return true; }
        player.commandParties ||= new Map();
        const number = (player.nextCommandPartyNumber || 0) + 1;
        player.nextCommandPartyNumber = number;
        const group = { number, commander: player, commanderActor: player.actor, members: new Set(),
            lootKey: `command:${randomUUID()}`, active: true, movement: 'follow' };
        group.owner = { actor: player.actor, clanCommandParty: group,
            dataSendToMe() {}, dataSendToOthers() {}, dataSendToMeAndOthers() {} };
        player.commandParties.set(number, group);
        group.pending = recruit(group, name, isCurrent).then(ok => {
            if (!ok || !current(group)) {
                dismiss(group);
                if (player.actor === group.commanderActor && (!isCurrent || isCurrent())) reply(player, `Could not create p${number}.`);
            } else if (!isCurrent || isCurrent()) reply(player, `Created p${number}, leader ${group.owner.actor.fetchName()}.`);
        }).catch(error => { dismiss(group); utils.infoWarn('ClanParty', 'create failed: %s', error.message); });
        return true;
    }
    if (match[6]) {
        const selector = match[6].toLowerCase(), order = match[7].toLowerCase();
        if (selector === 'main' || selector === 'all') {
            if (order === 'hold') {
                if (companion().holdParty(player).ok) companion().updateSettings(player, { movementMode: 'hold' });
            } else if (order === 'regroup') companion().beginRegroup(player);
            else {
                delete player.partyRegroupDirective;
                companion().updateSettings(player, { movementMode: 'follow' });
                companion().membersForLeader(player).forEach(s => {
                    s.botStay = false; s.stayLocation = null;
                    for (const key of ['resumeAfterBuff', 'resumeAfterShopping']) {
                        if (s[key]?.plan === 'following') {
                            s[key].botStay = false;
                            s[key].stayLocation = null;
                        }
                    }
                    invoke('GameServer/Bot/BotAI').wakeup(s, { urgent: true });
                });
            }
        }
        const groups = selector === 'all' ? [...(player.commandParties?.values() || [])]
            : [player.commandParties?.get(Number(selector.slice(1)))].filter(Boolean);
        groups.forEach(group => movement(group, order));
        reply(player, `${selector}: ${order}.`);
        return true;
    }
    const group = player.commandParties?.get(Number(match[4]));
    if (!group?.active) { reply(player, 'That party does not exist.'); return true; }
    if (action === 'dismiss') { dismiss(group); return true; }
    if (!group.leaderAssigned) { reply(player, 'That party is not ready.'); return true; }
    const name = match[5]?.trim();
    if (action === 'invite' || action === 'intive') {
        if (!name) { reply(player, 'Specify a character name.'); return true; }
        group.pending = (group.pending || Promise.resolve()).then(() => recruit(group, name, isCurrent))
            .then(ok => {
                if (player.actor === group.commanderActor && (!isCurrent || isCurrent()))
                    reply(player, ok ? `Joined p${group.number}: ${name}.` : `Could not invite ${name}.`);
            })
            .catch(error => utils.infoWarn('ClanParty', 'invite failed: %s', error.message));
    } else {
        const member = roster(group).find(s => s.actor.fetchName().toLowerCase() === name?.toLowerCase());
        if (!member) { reply(player, 'Character is not in that party.'); return true; }
        if (action === 'leader') setLeader(group, member);
        else companion().detach(group.owner, member, { source: 'command_party_kick' });
    }
    return true;
}

module.exports = { groupFor, commanderFor, authorized, current, roster, combatSessions, memberAttached, memberDetached,
    dismiss, dismissAll, recruit, movement, applyMemberOrder, formationTarget, followLeader, syncLoot, prepareRaid, handleMovement, canAttack, canTaunt, handleCommand };
