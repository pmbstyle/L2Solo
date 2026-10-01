const Safety = invoke('GameServer/Bot/AI/BotRaidSafety');
const Chat = invoke('GameServer/Bot/AI/BotPartyChat');
const Voice = invoke('GameServer/Bot/AI/BotChatVoice');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const Threats = invoke('GameServer/Bot/AI/BotPvpThreats');

const CHECK_INTERVAL_MS = 1000;
const VICTORY_TTL_MS = 60000;
const ratio = (actor, vital) => Number(actor[`fetch${vital}`]?.())
    / Math.max(1, Number(actor[`fetchMax${vital}`]?.()));

function speakers(owner, boss) {
    return Safety.playerPartySessions(owner).filter(member => member !== owner
        && Threats.alive(member.actor) && Threats.distance(member.actor, boss) <= 1800
        && !invoke('GameServer/RaidBoss/RaidCurse').isAboveRaidThreshold(member.actor, boss));
}

function choose(members, state) {
    const others = members.filter(member => member.actor.fetchId() !== state.lastSpeakerId);
    const choices = others.length ? others : members;
    return choices[state.sequence % choices.length];
}

function send(state, speaker, topic, values, now, victory = false) {
    if (!speaker) return false;
    const text = Voice.line(`party.raid.${topic}`, speaker, values);
    if (!Chat.announce(speaker, { text, priority: victory ? 'coordination' : 'informational',
        key: `raid:${state.boss.fetchId()}:${state.startedAt}:${topic}:${state.sequence}`, now })) return false;
    state.lastSpeakerId = speaker.actor.fetchId();
    state.sequence += 1;
    state.nextMessageAt = now + (victory ? 8000 : 25000 + Math.floor(Math.random() * 10000));
    return true;
}

function victory(owner, state, members, now) {
    if (now > state.victoryAt + VICTORY_TTL_MS || state.victoryLines >= 2) {
        owner.playerRaidChatter = undefined;
        return false;
    }
    if (now < state.nextMessageAt) return false;
    const candidates = state.victoryLines
        ? members.filter(member => member.actor.fetchId() !== state.victorySpeakerId) : members;
    // A solo survivor celebrates once; never reply to our own celebration.
    if (!candidates.length) {
        owner.playerRaidChatter = undefined;
        return false;
    }
    const speaker = choose(candidates, state);
    if (!send(state, speaker, state.victoryLines ? 'victory-reply' : 'victory', {}, now, true)) return false;
    if (!state.victoryLines) state.victorySpeakerId = speaker.actor.fetchId();
    state.victoryLines += 1;
    return true;
}

// A party-wide observer on the existing hot AI tick. Speech never owns an
// action slot or starts timers; all claims are rechecked at the moment of send.
function tick(owner, now = Date.now()) {
    if (!owner?.actor || owner.partyCompanion || owner.actor.fetchIsOnline?.() !== true) {
        if (owner) owner.playerRaidChatter = undefined;
        return false;
    }
    const raid = owner.partyRaidEngagement;
    let state = owner.playerRaidChatter;
    if (!raid && !state) return false;
    if (now < Number(owner.playerRaidChatterCheckAt || 0)) return false;
    owner.playerRaidChatterCheckAt = now + CHECK_INTERVAL_MS;
    if (raid?.phase === 'retreat' || raid?.phase === 'opening') {
        owner.playerRaidChatter = undefined;
        return false;
    }
    if (raid && (!state || state.boss.fetchId() !== raid.bossId || state.startedAt !== raid.selectedAt)) {
        const boss = Safety.raidBossByObjectId(raid.bossId);
        if (!boss) return false;
        state = owner.playerRaidChatter = { boss, startedAt: raid.selectedAt, sequence: 0,
            nextMessageAt: now + 8000, lowestSpokenHp: 100, lastObservedAt: raid.lastActiveAt ?? now,
            memberIds: new Set(Safety.playerPartySessions(owner).map(member => member.actor.fetchId())),
            statusAt: {}, victoryLines: 0 };
    }
    if (!state) return false;
    if (state.victoryAt && (now > state.victoryAt + VICTORY_TTL_MS || state.victoryLines >= 2)) {
        owner.playerRaidChatter = undefined;
        return false;
    }
    const boss = state.boss;
    if (Threats.distance(owner.actor, boss) > 2200) return false;
    const members = speakers(owner, boss);
    if (!members.length) return false;
    if (state.victoryAt) return victory(owner, state, members, now);
    if (boss.isDead?.() === true || boss.state?.fetchDead?.() === true) {
        const attackers = boss.model?.raidAttackers || boss.raidAttackers;
        const participated = [...(attackers || [])].some(id => state.memberIds.has(Number(id)));
        if (!participated || now - state.lastObservedAt > 15000) {
            owner.playerRaidChatter = undefined;
            return false;
        }
        state.victoryAt = now;
        state.nextMessageAt = now;
        return victory(owner, state, members, now);
    }
    if (!raid) {
        owner.playerRaidChatter = undefined;
        return false;
    }
    state.lastObservedAt = now;
    for (const member of Safety.playerPartySessions(owner)) state.memberIds.add(member.actor.fetchId());
    if (now < state.nextMessageAt) return false;
    // Let healing, death warnings and PvP coordination carry urgent situations.
    const living = [owner, ...members].filter(member => Threats.alive(member.actor));
    if (!living.some(member => member.actor.fetchId() === raid.mainTankId
        || Roles.inferRole(member.actor) === 'tank' && Number(boss.fetchDestId?.()) === member.actor.fetchId())) return false;
    if (living.some(member => ratio(member.actor, 'Hp') < 0.35
        || Threats.context(member).threats.length > 0)) return false;
    const hp = Math.max(1, Math.ceil(ratio(boss, 'Hp') * 100));
    const milestone = [3, 10, 25, 50, 75].find(percent => hp <= percent);
    if (milestone && milestone < state.lowestSpokenHp) {
        const damage = members.filter(member => !['tank', 'healer'].includes(Roles.inferRole(member.actor)));
        const speaker = choose(damage.length ? damage : members, state);
        const topic = milestone <= 3 ? 'last-push' : milestone <= 10 ? 'finish' : 'health';
        if (send(state, speaker, topic, { hp }, now)) {
            state.lowestSpokenHp = milestone;
            return true;
        }
        return false;
    }
    const healer = members.find(member => Roles.inferRole(member.actor) === 'healer');
    const mana = healer && ratio(healer.actor, 'Mp');
    const manaTopic = mana >= 0.6 ? 'mana-ok' : mana <= 0.25 ? 'mana-low' : null;
    if (manaTopic && (!state.statusAt[manaTopic] || now - state.statusAt[manaTopic] >= 90000)
        && send(state, healer, manaTopic, {}, now)) {
        state.statusAt[manaTopic] = now;
        return true;
    }
    const tank = members.find(member => member.actor.fetchId() === raid.mainTankId);
    if (tank && Roles.inferRole(tank.actor) === 'tank' && ratio(tank.actor, 'Hp') >= 0.55
        && Number(boss.fetchDestId?.()) === tank.actor.fetchId()
        && (!state.statusAt.tank || now - state.statusAt.tank >= 90000)
        && send(state, tank, 'tank', {}, now)) {
        state.statusAt.tank = now;
        return true;
    }
    return false;
}

module.exports = { tick };
