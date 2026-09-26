const assert = require('assert');

require('../src/Global');

const Companion = invoke('GameServer/Bot/AI/PartyCompanionService');
const Manager = invoke('GameServer/Bot/BotManager');
const BotAI = invoke('GameServer/Bot/BotAI');
const Support = invoke('GameServer/Bot/AI/BotSupportPlanner');
const PvpIndex = invoke('GameServer/Bot/AI/BotPvpIndex');
const Generics = invoke(path.actor);
const Response = invoke('GameServer/Network/Response');
const Journal = invoke('GameServer/Bot/AI/BotEventJournal');
const Panel = invoke('GameServer/World/Generics/NpcBypasses/CompanionControl');
const Takeover = invoke('GameServer/Bot/AI/PlayerPartyTakeover');

const saved = [];
function replace(object, key, value) {
    saved.push(() => { object[key] = value; });
    object[key] = value;
}

function botSession(id, partyId) {
    const actor = {
        fetchId: () => id,
        fetchName: () => `Bot${id}`,
        fetchClassId: () => 0,
        fetchIsOnline: () => true,
        fetchLocX: () => 100,
        fetchLocY: () => 100,
        fetchLocZ: () => -100,
        isDead: () => false,
        unselect() {},
        attack: { abortCast() {}, clearTimers() {}, resetQueuedEvent() {} },
        state: { fetchSeated: () => false, setHits() {}, setCasts() {} },
        automation: { abortAll() {}, stopReplenish() {} }
    };
    const session = {
        accountId: `bot_${id}`,
        actor,
        hotBackgroundPartyId: partyId,
        dataSendToMeAndOthers() {}
    };
    actor.session = session;
    return session;
}

async function run() {
try {
    const packets = [];
    const teleports = [];
    const partyId = 'runtime-takeover';
    const leader = {
        accountId: 'player_runtime',
        actor: {
            fetchId: () => 9001,
            fetchName: () => 'Leader',
            fetchIsOnline: () => true,
            fetchLocX: () => 1000,
            fetchLocY: () => 2000,
            fetchLocZ: () => -3000,
            fetchHead: () => 0,
            isDead: () => false
        },
        dataSendToMe: (packet) => packets.push(packet)
    };
    const roster = [botSession(101, partyId), botSession(102, partyId)];
    replace(Manager, 'sessions', roster);
    replace(BotAI, 'cancelScheduledTick', () => true);
    replace(BotAI, 'wakeup', () => true);
    replace(Support, 'cancelSupportCast', () => true);
    replace(PvpIndex, 'invalidate', () => true);
    replace(Generics, 'teleportTo', (session, _actor, destination) => {
        teleports.push({ session, destination });
        return true;
    });
    replace(Response, 'joinParty', () => 'join');
    replace(Response, 'partySmallWindowDeleteAll', () => 'clear');
    replace(Response, 'partySmallWindowAll', () => 'window');
    replace(Response, 'partyMemberPosition', () => 'positions');
    replace(Response.partySpelled, 'fromActor', () => 'spells');
    replace(Journal, 'record', async () => true);
    replace(Panel, 'render', () => true);

    const states = roster.map((session) => ({
        characterId: session.actor.fetchId(),
        party: { partyId: null },
        stats: {
            leaderId: 9001,
            playerPartyTakeover: { partyId, playerId: 9001, source: 'test' }
        }
    }));
    const result = Companion.attachRoster(leader, roster, {
        expectedBackgroundPartyId: partyId,
        lifeStates: states,
        distribution: 1
    });
    assert(result.ok);
    assert.strictEqual(result.count, 2);
    assert(roster.every((session) => session.partyCompanion === true
        && session.followPlayerSession === leader
        && session.hotBackgroundPartyId === null
        && session.plan === 'following'));
    assert.deepStrictEqual(roster.map((session) => session.coldLifeState), states);
    assert.strictEqual(teleports.length, 2, 'the complete remote roster should be placed around its new leader');
    assert.strictEqual(packets.filter((packet) => packet === 'join').length, 1, 'the native join acknowledgement is sent once');
    assert.strictEqual(packets.filter((packet) => packet === 'window').length, 1, 'the party window is rebuilt once for the whole roster');
    assert.deepStrictEqual(Takeover.restorationTarget(leader, roster), { partyId, playerId: 9001 },
        'a complete taken-over roster must retain enough identity to resume autonomously');

    const refused = Companion.attachRoster(leader, [botSession(103, partyId), botSession(104, partyId)], {
        expectedBackgroundPartyId: partyId
    });
    assert.strictEqual(refused.reason, 'player_party_not_empty', 'a second takeover cannot merge into an existing player party');

    let restoreRequest = null;
    replace(Takeover, 'restoreAutonomousParty', async (request) => {
        restoreRequest = request;
        return { ok: true, reason: 'autonomous_party_restored' };
    });
    const detached = Companion.detachAll(leader, { source: 'dismiss', rebuildWindow: false, refreshPanel: false });
    const restorePromise = leader.partyTakeoverRestorePromise;
    assert.strictEqual(detached, 2);
    assert(restorePromise, 'releasing a taken-over roster must schedule autonomous restoration');
    await restorePromise;
    assert.strictEqual(restoreRequest.partyId, partyId);
    assert.strictEqual(restoreRequest.playerId, 9001);
    assert.deepStrictEqual(restoreRequest.companionSessions, roster);
    assert(roster.every((session) => session.partyCompanion === false && session.followPlayerSession === null));
} finally {
    while (saved.length) saved.pop()();
}
}

run().then(() => {
    console.log('player party takeover runtime tests passed');
}).catch((error) => {
    console.error(error);
    process.exit(1);
});
