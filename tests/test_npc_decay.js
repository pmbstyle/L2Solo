const assert = require('assert');

require('../src/Global');

const NpcDecay = invoke('GameServer/World/Generics/NpcDecay');
const NpcVisibility = invoke('GameServer/World/NpcVisibility');
const RemoveNpc = invoke('GameServer/World/Generics/RemoveNpc');

function npcInfo(id) {
    const packet = Buffer.alloc(5);
    packet[0] = 0x16;
    packet.writeInt32LE(id, 1);
    return packet;
}

function deleteObjectId(packet) {
    return packet?.[0] === 0x12 ? packet.readInt32LE(1) : null;
}

function viewer(online = true, fail = false) {
    return {
        actor: { fetchIsOnline: () => online },
        sent: [],
        dataSendToMe(packet) {
            if (fail) throw new Error('socket closed');
            this.sent.push(packet);
            NpcVisibility.trackNpcPacket(this, packet);
        }
    };
}

function npc(id, corpseTime = 10) {
    return {
        fetchId: () => id,
        fetchCorpseTime: () => corpseTime,
        model: {}
    };
}

function world(spawns, sessions = []) {
    return {
        user: { sessions },
        npc: { spawns, grid: {} },
        indexCalls: 0,
        indexSpawnsInGrid() {
            this.indexCalls += 1;
        }
    };
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
    const directViewer = viewer();
    const directNpc = npc(9100001);
    NpcVisibility.trackNpcPacket(directViewer, npcInfo(directNpc.fetchId()));
    const directWorld = world([directNpc], [directViewer]);

    assert.strictEqual(NpcDecay.schedule(directWorld, directViewer, directNpc, 5), true);
    await wait(30);
    assert.strictEqual(directWorld.npc.spawns.length, 0, 'a corpse timer must remove the NPC from the world');
    assert.strictEqual(directWorld.indexCalls, 1, 'corpse removal must rebuild the NPC grid');
    assert.strictEqual(
        directViewer.sent.map(deleteObjectId).filter((id) => id === directNpc.fetchId()).length,
        1,
        'the viewer must receive exactly one DeleteObject'
    );
    assert.strictEqual(NpcDecay.decay(directWorld, directNpc), false, 'decay must be idempotent');

    const botSource = { accountId: 'bot_hot_test', dataSendToMe() {} };
    const companionViewer = viewer();
    const companionNpc = npc(9100002);
    NpcVisibility.trackNpcPacket(companionViewer, npcInfo(companionNpc.fetchId()));
    const companionWorld = world([companionNpc], [companionViewer]);
    NpcDecay.schedule(companionWorld, botSource, companionNpc, 10000);
    assert.strictEqual(NpcDecay.decay(companionWorld, companionNpc), true, 'hot-bot/companion kills must use the same decay path');
    assert.strictEqual(companionWorld.npc.spawns.length, 0, 'companion corpse must leave the world immediately when decayed');
    assert.strictEqual(
        companionViewer.sent.map(deleteObjectId).filter((id) => id === companionNpc.fetchId()).length,
        1,
        'a player who saw a companion kill must receive DeleteObject'
    );

    const failingViewer = viewer(true, true);
    const healthyViewer = viewer();
    const failedNpc = npc(9100003);
    NpcVisibility.trackNpcPacket(failingViewer, npcInfo(failedNpc.fetchId()));
    NpcVisibility.trackNpcPacket(healthyViewer, npcInfo(failedNpc.fetchId()));
    const failedWorld = world([failedNpc], [failingViewer, healthyViewer]);
    NpcDecay.schedule(failedWorld, botSource, failedNpc, 10000);
    assert.doesNotThrow(() => NpcDecay.decay(failedWorld, failedNpc), 'one broken client must not abort corpse cleanup');
    assert.strictEqual(failedWorld.npc.spawns.length, 0, 'world cleanup must happen even when packet delivery fails');
    assert.strictEqual(
        healthyViewer.sent.map(deleteObjectId).filter((id) => id === failedNpc.fetchId()).length,
        1,
        'healthy viewers must still receive DeleteObject after another viewer fails'
    );

    const gridFailureViewer = viewer();
    const gridFailureNpc = npc(9100006);
    NpcVisibility.trackNpcPacket(gridFailureViewer, npcInfo(gridFailureNpc.fetchId()));
    const gridFailureWorld = world([gridFailureNpc], [gridFailureViewer]);
    gridFailureWorld.indexSpawnsInGrid = () => {
        throw new Error('grid rebuild failed');
    };
    assert.doesNotThrow(() => NpcDecay.decay(gridFailureWorld, gridFailureNpc), 'grid failure must not abort corpse deletion');
    assert.strictEqual(gridFailureWorld.npc.spawns.length, 0, 'grid failure must not retain the corpse');
    assert.strictEqual(
        gridFailureViewer.sent.map(deleteObjectId).filter((id) => id === gridFailureNpc.fetchId()).length,
        1,
        'grid failure must not suppress DeleteObject'
    );

    const reaperNpc = npc(9100004);
    reaperNpc.corpseDecayState = 'scheduled';
    reaperNpc.corpseDecayAt = Date.now() - 1;
    const reaperWorld = world([reaperNpc]);
    assert.strictEqual(NpcDecay.sweepExpired(reaperWorld), 1, 'the reaper must remove overdue corpses');
    assert.strictEqual(reaperWorld.npc.spawns.length, 0, 'the reaper must remove overdue NPCs from the world');

    const malformedNpc = {
        corpseDecayState: 'scheduled',
        corpseDecayAt: Date.now() - 1,
        fetchId() {
            throw new Error('malformed npc id');
        }
    };
    const laterNpc = npc(9100007);
    laterNpc.corpseDecayState = 'scheduled';
    laterNpc.corpseDecayAt = Date.now() - 1;
    const malformedWorld = world([malformedNpc, laterNpc]);
    assert.doesNotThrow(() => NpcDecay.sweepExpired(malformedWorld), 'one malformed NPC must not abort the whole sweep');
    assert.strictEqual(malformedWorld.npc.spawns.includes(laterNpc), false, 'later overdue NPCs must still decay');

    const rewardFailureNpc = npc(9100005);
    const rewardFailureWorld = world([rewardFailureNpc]);
    rewardFailureWorld.npcRewards = () => {
        throw new Error('drop calculation failed');
    };
    RemoveNpc.call(rewardFailureWorld, viewer(), rewardFailureNpc);
    await wait(30);
    assert.strictEqual(
        rewardFailureWorld.npc.spawns.length,
        0,
        'a reward exception must not strand the corpse before decay is registered'
    );

    console.log('NPC decay lifecycle regression checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
