const { EVENT_TYPES, characterIds, writeEvent } = require('./BotCombatMemory');

function writeOutcome(write, { bossId, bossName, instanceId, status, at, partyId, participants, bots, winningParticipantIds } = {}) {
    const eventType = 'raid_' + status;
    if (!EVENT_TYPES.raid.includes(eventType) || !instanceId || !Number.isSafeInteger(bossId) || bossId <= 0
        || (status === 'failed' && !partyId)) return;

    const name = String(bossName || `Raid Boss ${bossId}`).replace(/\s+/g, ' ').trim().slice(0, 120);
    const summary = status === 'defeated' ? `Raid boss ${name} was defeated.` : `Raid attempt against ${name} failed.`;
    // A boss can be defeated once per spawn. Failed attempts can recur on the same spawn.
    const identity = status === 'defeated' ? [bossId, instanceId, status] : [bossId, instanceId, status, partyId, at];
    const participantIds = characterIds(participants);
    writeEvent(write, { kind: 'raid', eventType, at, identity, summary, participantIds, bots,
        details: { bossId, bossName: name, ...(status === 'defeated' && Array.isArray(winningParticipantIds)
            ? { winningParticipantIds: characterIds(winningParticipantIds).filter(id => participantIds.includes(id)) } : {}) } });
}

function markParticipant(participants, session) {
    const id = Number(session?.actor?.fetchId?.());
    if (Number.isSafeInteger(id) && id > 0) participants.set(id, String(session.accountId || '').startsWith('bot_'));
}

function recordHotHit(npc, actor, session, damage) {
    if (!(damage > 0)) return;
    const companion = actor.fetchIsSummon?.() || actor.fetchIsPet?.();
    const player = companion ? actor.ownerSession || session : session;
    const ownerId = companion ? Number(actor.fetchOwnerId?.()) : 0;
    if (!player?.actor || typeof player.actor.fetchKind === 'function'
        || (!companion && player.actor !== actor) || (ownerId > 0 && Number(player.actor.fetchId?.()) !== ownerId)) return;
    npc.raidMemoryAttackers ??= new Map();
    markParticipant(npc.raidMemoryAttackers, player);
}

function hotOutcome(npc, status, at, participants) {
    return {
        bossId: Number(npc.fetchSelfId?.()), bossName: npc.fetchName?.(),
        instanceId: npc.raidInstanceId || `object:${npc.fetchId()}`, status, at,
        participants: [...participants.keys()], bots: [...participants].filter(([, bot]) => bot).map(([id]) => id)
    };
}

function recordHotVictory(npc, killer, rewards, at = Date.now()) {
    // A second wing may fight without sharing the killer's EXP.
    const participants = new Map(npc.raidMemoryAttackers);
    markParticipant(participants, killer);
    for (const { session, exp, sp } of rewards) {
        if (exp > 0 || sp > 0) markParticipant(participants, session);
    }
    const outcome = hotOutcome(npc, 'defeated', at, participants);
    if (!outcome.bots.length) return Promise.resolve();
    return invoke('Database').recordBotRaidOutcome(outcome);
}

function hotFailure(npc, partyId, sessions, at) {
    if (!npc?.raidMemoryAttackers?.size || npc.isDead?.()) return null;
    const fought = session => npc.raidMemoryAttackers.has(Number(session.actor?.fetchId?.()));
    if (!sessions.some(fought)) return null;
    const participants = new Map();
    for (const session of sessions) {
        if (fought(session) || (session.raidPreparationComplete && session.backgroundHuntTarget === npc)) {
            markParticipant(participants, session);
        }
    }
    return { ...hotOutcome(npc, 'failed', at, participants), partyId };
}

module.exports = { writeOutcome, recordHotHit, recordHotVictory, hotFailure };
