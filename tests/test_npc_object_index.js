const assert = require('assert');
const { performance } = require('perf_hooks');

require('../src/Global');

const World = invoke('GameServer/World/World');
const Index = require('../src/GameServer/World/NpcObjectIndex');
const Awareness = invoke('GameServer/Bot/AI/PartyAwareness');
const Combat = invoke('GameServer/Bot/AI/PartyCombatState');
const Decay = invoke('GameServer/World/Generics/NpcDecay');
const Spawn = invoke('GameServer/World/Generics/SpawnNpcs');
const BotManager = invoke('GameServer/Bot/BotManager');

function actor(id) {
    return {
        id, dead: false, targetId: 0, x: 0,
        fetchId() { return this.id; },
        fetchDestId() { return this.targetId; },
        fetchLocX() { return this.x; },
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchIsOnline: () => true,
        fetchAttackable: () => true,
        fetchClassId: () => 0,
        fetchSelfId: () => 1,
        isDead() { return this.dead; },
        state: { fetchDead: () => false, fetchHits: () => false, fetchCasts: () => false },
        backpack: { fetchEquippedArmors: () => [] }
    };
}

(async () => {
    const original = { npc: World.npc, user: World.user, bots: BotManager.sessions };
    try {
        const leader = { actor: actor(2000001) };
        const companion = { actor: actor(2000002), partyCompanion: true, followPlayerSession: leader };
        const target = actor(1037566);
        const add = actor(1037567);
        let fillerReads = 0;
        const filler = Array.from({ length: 37565 }, (_, i) => ({
            fetchId() { fillerReads++; return 1000000 + i; }
        }));
        World.npc = { spawns: [...filler, target, add], grid: {}, gridKeys: new WeakMap() };
        World.user = { sessions: [leader, companion] };
        BotManager.sessions = [companion];
        leader.actor.targetId = target.id;
        companion.incomingThreatId = add.id;
        companion.incomingThreatAt = Date.now();
        const expectedTarget = Awareness.leaderCombatTargetId(leader);
        const expectedIncoming = Awareness.recentIncomingNpc(companion);
        assert.strictEqual(expectedTarget, target.id);
        assert.strictEqual(expectedIncoming, add);

        World.indexSpawnsInGrid();
        fillerReads = 0;
        // Catch an accidental fallback on both hits and misses, independently
        // of machine speed. A missing/just-despawned target must stay O(1).
        const originalFind = World.npc.spawns.find;
        World.npc.spawns.find = () => { throw new Error('full NPC scan in indexed lookup'); };
        assert.strictEqual(Awareness.leaderCombatTargetId(leader), expectedTarget);
        assert.strictEqual(Awareness.recentIncomingNpc(companion), expectedIncoming);
        assert.strictEqual(await World.fetchNpc(target.id), target);
        assert.strictEqual(Index.find(World, -1), null);
        assert.strictEqual(Index.find(World, String(target.id)), null, 'strict lookup must not coerce IDs');
        let rejected = false;
        await World.fetchNpc(-1).catch(() => { rejected = true; });
        assert(rejected, 'async lookup must retain its missing-NPC rejection');
        assert.strictEqual(fillerReads, 0, 'hot lookup must not read unrelated NPC IDs');
        World.npc.spawns.find = originalFind;

        add.targetId = companion.actor.id;
        Awareness.invalidateThreatProjection(leader);
        assert.strictEqual(Combat.combatState(leader).target, add, 'incoming add still interrupts party work');
        add.dead = true;
        assert.strictEqual(Awareness.recentIncomingNpc(companion), null, 'death is read immediately, without cache expiry');
        target.dead = true;
        assert.strictEqual(Awareness.leaderCombatTargetId(leader), null, 'dead targets remain forbidden');
        target.dead = false;
        assert.strictEqual(Awareness.leaderCombatTargetId(leader), target.id, 'live state is not copied into the index');
        leader.actor.targetId = -1;
        assert.strictEqual(Awareness.leaderCombatTargetId(leader), null, 'target switching is immediate');

        Decay.decay(World, add);
        assert.strictEqual(Index.find(World, add.id), null, 'corpse decay removes the object');
        assert.strictEqual(Awareness.recentIncomingNpc(companion), null, 'removed incoming targets stay absent');
        const respawn = actor(1037568);
        World.npc.spawns.push(respawn);
        World.addNpcToGrid(respawn);
        assert.strictEqual(Index.find(World, respawn.id), respawn, 'respawn is available immediately under its new ID');
        leader.actor.targetId = respawn.id;
        assert.strictEqual(Awareness.leaderCombatTargetId(leader), respawn.id);
        respawn.x = 6500;
        World.addNpcToGrid(respawn);
        assert.strictEqual(Index.find(World, respawn.id), respawn, 'movement preserves object identity');

        const quest = actor(1037569);
        World.npc.spawns.push(quest);
        World.addNpcToGrid(quest);
        assert(Spawn.despawnQuestNpc(World, quest));
        assert.strictEqual(Index.find(World, quest.id), null, 'quest despawn removes the object');
        const summon = actor(1037570);
        summon.fetchIsSummon = () => true;
        World.npc.spawns.push(summon);
        World.addNpcToGrid(summon);
        invoke('GameServer/Actor/Generics/NpcDied')({}, leader.actor, summon);
        assert.strictEqual(Index.find(World, summon.id), null, 'legacy summon death removes the indexed object');
        Decay.decayMany(World, [target, respawn]);
        assert.strictEqual(Index.find(World, target.id), null, 'batch decay removes every indexed corpse');
        assert.strictEqual(Index.find(World, respawn.id), null, 'array filtering does not strand indexed actors');

        const replacement = actor(target.id);
        World.npc.spawns.push(replacement);
        World.addNpcToGrid(replacement);
        World.removeNpcFromGrid(target);
        assert.strictEqual(Index.find(World, target.id), replacement, 'late cleanup cannot evict a replacement');
        World.npc.spawns = [replacement];
        World.indexSpawnsInGrid();
        assert.strictEqual(Index.find(World, 1000000), null, 'explicit world rebuild drops old objects');
        assert.strictEqual(Index.find(World, target.id), replacement);

        World.npc.nextId = 4000000;
        World.user = { sessions: [] };
        const definition = {
            npc: require('../data/Npcs/npcs.json')[0],
            spawn: { coords: [{ locX: 0, locY: 0, locZ: 0, head: 0 }], respawn: 60 },
            bounds: []
        };
        const spawned = Spawn.spawnNpc(World, definition);
        assert.strictEqual(Index.find(World, spawned.fetchId()), spawned, 'real spawn path registers its new actor');
        const oldSpawnId = spawned.fetchId();
        Decay.decay(World, spawned);
        const respawned = Spawn.spawnNpc(World, definition);
        assert.notStrictEqual(respawned.fetchId(), oldSpawnId);
        assert.strictEqual(Index.find(World, oldSpawnId), null);
        assert.strictEqual(Index.find(World, respawned.fetchId()), respawned, 'real respawn path does not reuse a stale actor');
        Decay.decay(World, respawned);

        const DataCache = invoke('GameServer/DataCache');
        const Rates = invoke('GameServer/ProgressionRates');
        const originalRewards = DataCache.fetchNpcRewardsFromSelfId;
        const originalRoll = Rates.rewardGroupRoll;
        try {
            DataCache.fetchNpcRewardsFromSelfId = (_id, callback) => callback({ spoils: [{ items: [{ selfId: 57 }] }] });
            Rates.rewardGroupRoll = () => ({ hit: false });
            const corpse = actor(4000002);
            corpse.dead = true;
            corpse.model = { spoil: { spoiled: true, swept: false } };
            World.npc.spawns.push(corpse);
            World.addNpcToGrid(corpse);
            const sweeper = actor(2000003);
            Object.assign(sweeper, {
                fetchMp: () => 100, setMp() {}, statusUpdateVitals() {},
                automation: { replenishVitals() {} },
                attack: { queueTimer(effect) { effect(); } }
            });
            sweeper.state.setCasts = () => {};
            const sweepSkill = new (invoke('GameServer/Model/Skill'))({
                selfId: 42, name: 'Sweeper', level: 1, mp: 0, hitTime: 0, reuse: 0
            });
            invoke('GameServer/Npc/SpoilSweep').castSweep({ dataSendToMe() {}, dataSendToMeAndOthers() {} }, sweeper, corpse, sweepSkill);
            assert.strictEqual(corpse.model.spoil.swept, true);
            assert.strictEqual(Index.find(World, corpse.id), null, 'legacy Sweep path removes its indexed corpse');
            Decay.decay(World, corpse);
            assert.strictEqual(Index.find(World, corpse.id), null, 'later corpse timer remains harmless after Sweep');
        } finally {
            DataCache.fetchNpcRewardsFromSelfId = originalRewards;
            Rates.rewardGroupRoll = originalRoll;
        }

        // Measure identical exact-ID lookups, not end-to-end server latency.
        World.npc.spawns = [...filler, replacement];
        World.indexSpawnsInGrid();
        const iterations = 2000;
        let result;
        let started = performance.now();
        for (let i = 0; i < iterations; i++) result = World.npc.spawns.find((npc) => npc.fetchId() === target.id);
        const linearMs = performance.now() - started;
        assert.strictEqual(result, replacement);
        fillerReads = 0;
        started = performance.now();
        for (let i = 0; i < iterations; i++) result = Index.find(World, target.id);
        const indexedMs = performance.now() - started;
        assert.strictEqual(result, replacement);
        assert.strictEqual(fillerReads, 0);
        console.log(`NPC lookup benchmark: ${iterations} lookups / ${World.npc.spawns.length} NPCs: linear=${linearMs.toFixed(2)}ms indexed=${indexedMs.toFixed(2)}ms`);

        World.npc = { spawns: [quest] };
        assert.strictEqual(Index.find(World, quest.id), quest, 'unindexed lightweight worlds retain legacy lookup');
        assert.strictEqual(Index.find(World, target.id), null, 'world replacement cannot retain the old index');
    } finally {
        World.npc = original.npc;
        World.user = original.user;
        BotManager.sessions = original.bots;
    }
    console.log('NPC object index lifecycle, combat parity and bounded lookup checks passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
