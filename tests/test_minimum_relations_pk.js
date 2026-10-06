'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-relations-pk-'));
const previousConfig = process.env.L2NODE_CONFIG_FILE, previousShared = process.env.L2NODE_SHARED_CONFIG_FILE;
const previousLearning = process.env.BOT_KNOWLEDGE_ERRORS_ENABLED;
const ini = path.join(directory, 'test.ini');
fs.writeFileSync(ini, fs.readFileSync(path.join(root, 'config/default.ini'), 'utf8').replace(
    /^\[Database\]\r?\npath\s*=\s*[^\r\n]+/m,
    `[Database]\npath = ${path.join(directory, 'world.sqlite')}\nhistoryPath = ${path.join(directory, 'history.sqlite')}`));
process.env.L2NODE_CONFIG_FILE = ini; delete process.env.L2NODE_SHARED_CONFIG_FILE;
require('../src/Global');
const Database = invoke('Database'), Data = invoke('GameServer/DataCache');
const Policy = require('../src/GameServer/Social/InteractionMemoryPolicy');
const Layers = require('../src/GameServer/Social/RelationshipLayers');
const Memory = require('../src/GameServer/Social/InteractionMemory');
const Rows = require('../src/GameServer/Social/InteractionMemoryRows');
const Drops = require('../src/GameServer/PkDropPolicy');
const People = require('../src/GameServer/Social/PeopleKnowledge');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const at = Date.now();
let groups = 0;
const done = name => { groups++; console.log('PASS ' + name); };
const near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
const item = (id, kind, equipped = false) => ({ selfId: id, kind, equipped, amount: 1 });
function event(key, targetId = 2, extra = {}) {
    return { key, sourceId: 1, targetId, type: 'mob_contested', at, playedHours: 4, hours: 0.5,
        traits: { loyalty: 0.5, resilience: 0.5 }, ...extra };
}
async function createBot(id, pk = 6) {
    await Database.execute(['INSERT INTO accounts(username,password) VALUES (?,?)', [`bot_relations_${id}`, 'test']]);
    await Database.execute([`INSERT INTO characters(id,username,name,classId,race,level,exp,hp,maxHp,mp,maxMp,karma,pk,sex,face,hair,hairColor,locX,locY,locZ)
        VALUES (?,?,?,0,0,1,1000,100,100,50,50,100,?,0,0,0,0,20,30,0)`, [id, `bot_relations_${id}`, `Relations${id}`, pk]]);
    const stats = { classId: 0, classProgressionLevel: 1, classProgressionClassId: 0, deaths: 0, karma: 100, pk };
    await Database.execute([`INSERT INTO bot_life_state(characterId,accountName,characterName,level,exp,hp,maxHp,mp,maxMp,phase,activity,locX,locY,locZ,
        nextResolveAt,updatedAt,statsJson,inventorySummary) VALUES (?,?,?,1,1000,100,100,50,50,'cold','hunting',20,30,0,?,?,?,'{}')`,
    [id, `bot_relations_${id}`, `Relations${id}`, at + 1000, at, JSON.stringify(stats)]]);
    for (const [selfId, amount, equipped, slot] of [[57, 500, 0, 0], [10, 1, 0, 7], [19, 1, 1, 8], [1864, 3, 0, 0]]) {
        await Database.execute(['INSERT INTO items(selfId,name,amount,enchant,equipped,slot,characterId) VALUES (?,?,?,4,?,?,?)',
            [selfId, `Item${selfId}`, amount, equipped, slot, id]]);
    }
    const inventory = Life.inventorySummaryFromItems(await Database.execute(['SELECT * FROM items WHERE characterId=? ORDER BY id', [id]]));
    await Database.execute(['UPDATE bot_life_state SET inventorySummary=? WHERE characterId=?', [JSON.stringify(inventory), id]]);
    return id;
}
async function main() {
    try {
        const bag = item(19, 'Armor.Shield'), armor = item(20, 'Armor.Chest', true), weapon = item(21, 'Weapon.Sword', true);
        const rolls = [0, 0.9, 0, 0.9];
        assert.deepEqual(Drops.rollPlan({ karma: 1, pk: 6, inventory: [bag, armor, weapon] }, () => rolls.shift()), [armor]);
        near(Drops.expectedValue({ karma: 1, pk: 6, inventory: [bag, armor] }, id => id === 19 ? 10 : 100), 13.2);
        assert.equal(Drops.rollPlan({ karma: 1, pk: 6, inventory: Array.from({ length: 20 }, () => bag) }, () => 0).length, 10);
        assert.equal(Drops.expectedValue({ karma: 1, pk: 5, inventory: [bag] }, () => 100), 0);
        for (const protectedItem of [item(57, 'Etc.Adena'), item(5575, 'Etc.Adena'), item(10, 'Weapon.Sword'),
            item(6611, 'Weapon.Sword'), item(300, 'Other.Quest'), { ...bag, shadow: true }]) assert.equal(Drops.eligible(protectedItem), false);
        assert.equal(Drops.chance(weapon), 0.1); assert.equal(Drops.chance(armor), 0.4);
        done('ordered shared PK rolls, valuation, ten cap and protected items');

        let snapshot = Policy.apply(Policy.empty(1), event('contest:1'), at).snapshot;
        assert.equal(snapshot.relations[0].hostility, 3, 'resource theft keeps its shared lasting hostility alongside the grudge layer');
        const row = snapshot.relations[0];
        near(Layers.persistent(row, 4 + Layers.durations(row.traits).middle).grudge, 0.25);
        const fast = Layers.fast(null, event('contest:1'));
        near(Layers.fastValue(fast, 4 + fast.halfLife), 0.25);
        assert.equal(Policy.apply(snapshot, event('contest:1'), at).status, 'duplicate');
        assert.throws(() => Policy.event(event('bad', 2, { hours: NaN })));
        assert.throws(() => Policy.event(event('bad', 2, { traits: { loyalty: NaN } })));
        for (let i = 3; i < 103; i++) snapshot = Policy.apply(snapshot, event(`player:${i}`, i, { player: true }), at).snapshot;
        for (let i = 103; i < 170; i++) snapshot = Policy.apply(snapshot, event(`bot:${i}`, i), at).snapshot;
        assert.equal(snapshot.relations.filter(row => row.player).length, 100);
        assert(snapshot.relations.some(row => row.targetId === 3)); Policy.validate(snapshot);
        done('playing-hour layers, immutable event admission and player retention');

        const { DatabaseSync } = require('node:sqlite');
        const old = new DatabaseSync(':memory:');
        old.exec(`PRAGMA foreign_keys=ON; CREATE TABLE characters(id INTEGER PRIMARY KEY); INSERT INTO characters VALUES(1),(2);
            CREATE TABLE bot_interaction_memory(ownerId INTEGER PRIMARY KEY,snapshotJson TEXT);
            CREATE TABLE bot_social_memory(botId INTEGER,playerId INTEGER,trust INTEGER,familiarity INTEGER,updatedAt INTEGER,
                groupRuns INTEGER,wipesTogether INTEGER,helpedInCombat INTEGER,gaveUsefulLoot INTEGER,ignoredLootRequests INTEGER,
                tradesCompleted INTEGER,insults INTEGER,recentlyAbandonedAt INTEGER);
            INSERT INTO bot_social_memory VALUES(1,2,800,400,${at},2,0,3,1,0,4,0,NULL);`);
        Rows.install(old);
        const migrated = Rows.load({ one: (sql, params) => old.prepare(sql).get(...params), all: (sql, params) => old.prepare(sql).all(...params) }, 1);
        assert.equal(migrated.relations[0].player, true); assert.equal(migrated.relations[0].trust, 100);
        assert.equal(migrated.relations[0].social.trade_completed, 4);
        assert.equal(old.prepare("SELECT count(*) n FROM sqlite_master WHERE name IN ('bot_social_memory','bot_interaction_memory')").get().n, 0);
        old.close(); done('legacy player memory migrates into one directed pair store');

        Data.init();
        const config = invoke('GameServer/Bot/Population/PopulationConfig');
        config.knowledgeErrorsEnabled = true;
        const learned = People.statsAfter({ peoplePoints: 7 }, 'fight:1');
        assert.equal(learned.peoplePoints, 8); assert.equal(People.statsAfter(learned, 'fight:1'), learned);
        assert(People.uncertainty({ level: 20, stats: { peoplePoints: 100 } }, { traits: { understanding: 0.5 } })
            < People.uncertainty({ level: 20, stats: { peoplePoints: 0 } }, { traits: { understanding: 0.5 } }));
        const estimateSource = { characterId: 1, level: 20, stats: { peoplePoints: 0 } };
        const persona = { understanding: 0.25, traits: {} };
        const firstEstimate = People.estimate(1, estimateSource, persona, 'same-fight');
        assert.equal(People.estimate(1, estimateSource, persona, 'same-fight'), firstEstimate);
        const experienced = { ...estimateSource, stats: { peoplePoints: 1000000 } };
        assert(Math.abs(People.estimate(1, experienced, persona, 'same-fight') - 1) < Math.abs(firstEstimate - 1));
        const Visible = require('../src/GameServer/Social/VisibleStrength');
        const odds = { own: { look: Visible.NOTHING, people: 1 }, other: { look: Visible.NOTHING, people: 1 }, traits: {} };
        const informed = Visible.canWin({ ...odds, knowledge: { source: estimateSource, persona, key: 'same-fight' } });
        assert.notEqual(informed.chance, Visible.canWin(odds).chance, 'the existing visible-strength verdict consumes the learned estimate');
        config.knowledgeErrorsEnabled = false;
        assert.deepEqual(Visible.canWin({ ...odds, knowledge: { source: estimateSource, persona, key: 'same-fight' } }), Visible.canWin(odds));
        assert.equal(People.statsAfter(learned, 'fight:2'), learned); assert.equal(People.uncertainty({}, {}), 0);
        done('lifelong people learning, episode dedup and shared off switch');

        Database.init();
        await createBot(1); await createBot(2, 5); await createBot(3);
        // Reopen the real migration driver from a disposable version-57 shape.
        await Database.close();
        const legacy = new DatabaseSync(path.join(directory, 'world.sqlite'));
        legacy.exec(`PRAGMA foreign_keys=ON;
            DELETE FROM schema_migrations WHERE version=58;
            DROP TABLE interaction_relations; DROP TABLE interaction_journal; DROP TABLE interaction_owners;
            CREATE TABLE bot_interaction_memory(ownerId INTEGER PRIMARY KEY REFERENCES characters(id),snapshotJson TEXT NOT NULL,updatedAt INTEGER NOT NULL);
            CREATE TABLE bot_social_memory(botId INTEGER,playerId INTEGER,trust INTEGER,familiarity INTEGER,updatedAt INTEGER,
                groupRuns INTEGER,wipesTogether INTEGER,helpedInCombat INTEGER,gaveUsefulLoot INTEGER,ignoredLootRequests INTEGER,
                tradesCompleted INTEGER,insults INTEGER,recentlyAbandonedAt INTEGER);`);
        const legacySnapshot = Policy.apply(Policy.empty(1), { key: 'old:hunt', sourceId: 1, targetId: 2, type: 'hunted_together', at }, at).snapshot;
        legacy.prepare('INSERT INTO bot_interaction_memory VALUES (?,?,?)').run(1, JSON.stringify(legacySnapshot), at);
        legacy.exec(`INSERT INTO bot_social_memory VALUES(1,2,8,9,${at},2,0,3,1,0,4,0,NULL)`);
        legacy.close(); Database.init();
        const migratedActual = (await Database.loadInteractionMemories([1]))[0];
        assert.equal(migratedActual.relations.length, 1, 'the overlapping legacy memories merge once');
        assert.equal(migratedActual.relations[0].player, true);
        assert.equal(migratedActual.relations[0].trust, 8);
        assert.equal(migratedActual.relations[0].social.hunted_together, 1);
        assert.equal(migratedActual.relations[0].social.trade_completed, 4);
        assert.equal((await Database.execute(['SELECT count(*) n FROM schema_migrations WHERE version=58', []]))[0].n, 1);
        assert.equal((await Database.execute(["SELECT count(*) n FROM sqlite_master WHERE name IN ('bot_interaction_memory','bot_social_memory')", []]))[0].n, 0);
        await Database.close(); Database.init();
        assert.deepEqual((await Database.loadInteractionMemories([1]))[0], migratedActual);
        done('actual legacy 57→58 init/reinit merges existing pair and player counters once');
        await Life.init();
        const red = Life.cachedState(1), white = Life.cachedState(2), ordinary = Life.cachedState(3);
        // Non-dropping deaths must not consume the PK sequence or return a bag.
        for (const [id, karma, pk] of [[4, 0, 6], [5, 100, 3]]) {
            await createBot(id, pk);
            await Database.execute(['UPDATE characters SET hp=0,karma=? WHERE id=?', [karma, id]]);
            await Database.execute(["UPDATE bot_life_state SET activity='dead',deathCount=1 WHERE characterId=?", [id]]);
            await Database.execute(['UPDATE items SET slot=0 WHERE characterId=? AND equipped=0', [id]]);
            const bag = await Database.fetchItems(id);
            const result = await Database.syncInventorySummary(id, Life.inventorySummaryFromItems(bag), 'resolve_death');
            assert.deepEqual(result, { drops: [] });
            assert.deepEqual(await Database.fetchItems(id), bag);
            const [saved] = await Database.execute(['SELECT statsJson FROM bot_life_state WHERE characterId=?', [id]]);
            assert.equal(JSON.parse(saved.statsJson).pkDropDeathSequence, undefined);
        }
        done('ineligible PK deaths return early without changing the bag or sequence');

        const repository = invoke('GameServer/Social/InteractionMemoryRepository');
        const memory = new Memory(repository); memory.playingHours = () => 4;
        const committed = await memory.recordBatch([event('durable:1')]);
        assert(committed.ok); near(memory.views.get(1).relation('character', 2, at).irritation, 0.5);
        const worker = new Memory(); worker.accept(memory.snapshot(1));
        near(worker.views.get(1).relation('character', 2, at).irritation, 0.5);
        const saved = await repository.load(1);
        await assert.rejects(memory.recordBatch([event('rollback:1'), event('rollback:2', 2, { sourceId: 999 })]), /FOREIGN KEY/);
        assert.deepEqual(await repository.load(1), saved);
        await Database.close(); Database.init();
        assert.deepEqual(await repository.load(1), saved);
        const restarted = new Memory(repository); await restarted.load(1);
        assert.equal(restarted.views.get(1).relation('character', 2, at).irritation, 0, 'fast layer is not persisted');
        near(restarted.views.get(1).relation('character', 2, at).grudge, 0.5);
        done('actual row/journal atomicity, restart and ephemeral worker projection');

        const rng = Math.random, World = invoke('GameServer/World/World'), oldGround = World.items;
        World.items = { spawns: [], nextId: 5000000 };
        try {
            Math.random = () => 0;
            const originalIds = (await Database.execute(['SELECT id FROM items WHERE characterId=1 ORDER BY id', []])).map(row => row.id);
            // The existing inventory transaction is the ordinary new-death writer.
            await Database.execute(["UPDATE characters SET hp=0 WHERE id=1", []]);
            await Database.execute(["UPDATE bot_life_state SET activity='dead',deathCount=1,statsJson=json_set(statsJson,'$.deaths',1) WHERE characterId=1", []]);
            const deathDrop = await Database.syncInventorySummary(1, red.inventory, 'resolve_death');
            assert.equal(deathDrop.drops.length, 2);
            assert(deathDrop.drops.every(item => originalIds.includes(item.id)));
            const remaining = await Database.execute(['SELECT selfId FROM items WHERE characterId=1 ORDER BY id', []]);
            assert.deepEqual(remaining.map(row => row.selfId), [57, 10]);
            assert.deepEqual((await Database.syncInventorySummary(1, deathDrop.inventory, 'resolve_death')).drops, []);
            assert.equal(JSON.parse((await Database.execute(['SELECT statsJson FROM bot_life_state WHERE characterId=1', []]))[0].statsJson).pkDropDeathSequence, 1);
            done('ordinary physical PK inventory transaction and same-death replay');

            const hotActor = new (invoke('GameServer/Model/Actor'))({ id: 999, karma: 1, pk: 6, locX: 10, locY: 20, locZ: 30 });
            const Backpack = invoke('GameServer/Model/Backpack'), Item = invoke('GameServer/Item/Item');
            hotActor.backpack = new Backpack({ 8: { id: 9991, selfId: 19 } });
            const shield = new Item(9991, { selfId: 19, kind: 'Armor.Shield', amount: 1, slot: 8, equipped: true, enchant: 4 });
            hotActor.backpack.items = [shield, new Item(9992, { selfId: 57, amount: 20 })];
            hotActor.setPrivateStore({ items: [{ objectId: 9991 }, { objectId: 9992 }] });
            const packets = [], session = { persistenceMode: 'ephemeral', actor: hotActor,
                dataSendToMe: packet => packets.push(packet), dataSendToMeAndOthers: packet => packets.push(packet) };
            hotActor.session = session;
            const groundBefore = World.items.spawns.length;
            assert.deepEqual(require('../src/GameServer/Actor/Generics/PkDeathDrop').drop(session, hotActor, () => 0), [shield]);
            assert.equal(World.items.spawns.length, groundBefore + 1);
            assert.equal(World.items.spawns.at(-1).fetchEnchantLevel(), 4);
            assert.equal(hotActor.backpack.fetchItemRaw(9991), undefined);
            assert.deepEqual(hotActor.fetchPrivateStore().items, [{ objectId: 9992 }]);
            assert.deepEqual(hotActor.backpack.paperdoll[8], {}); assert(packets.length > 0);
            done('native hot item, paperdoll, shop line and ground enchant conservation');

            // Actual fenced owner commit removes items and reflects its durable bag.
            await Database.execute(["UPDATE characters SET hp=100,karma=100,pk=5 WHERE id=2", []]);
            const state = { ...white, stats: { ...white.stats, pk: 5 } };
            Life.acceptSimulationOwnership(2, state.simulation, state);
            const claim = await Owner.claimBatch([{ state, leaseId: 'pk-drop' }], { timestamp: at + 100, leaseMs: 60000 });
            assert.equal(claim.grants.length, 1);
            const current = Life.cachedState(2), next = { ...current, activity: 'dead', vitals: { ...current.vitals, hp: 0 },
                stats: { ...current.stats, deaths: 1 }, updatedAt: at + 200 };
            const [result] = await Owner.commitAndReleaseBatch([{ token: claim.grants[0], nextState: next,
                options: { allowLifecycle: true }, proposal: { baseState: current, durable: { pvpKills: [{ victimId: 1, victimLevel: 1, pvp: false }] } } }], { timestamp: at + 200 });
            assert(result.ok); assert.equal(result.pkDrops.length, 2);
            assert.equal(Life.cachedState(2).inventory['19'], undefined);
            assert.equal(Life.cachedState(2).inventory['1864'], undefined);
            assert.equal(Life.cachedState(2).inventory['57'].amount, 500);
            assert.equal((await Database.execute(['SELECT pk FROM characters WHERE id=2', []]))[0].pk, 6);
            assert.equal(World.items.spawns.length, groundBefore + 3, 'accepted cold drop reaches actual ground once');
            done('fenced sixth-PK death drop reflects actual inventory and ground without resurrection');

            const beforeResolveGround = World.items.spawns.length;
            const resolved = await Life.prepareResolve(ordinary, { patch: { activity: 'dead', deathCount: 1, vitals: { hp: 0 } },
                debug: { died: true, fights: 1, wins: 0 }, materialize: {} }, { timestamp: at + 1000 });
            assert(resolved, 'actual ordinary lifecycle completes');
            assert.equal(resolved.inventory['19'], undefined); assert.equal(resolved.inventory['1864'], undefined);
            assert.equal(Life.cachedState(3), resolved); assert.equal(resolved.stats.pkDropDeathSequence, 1);
            assert.equal(World.items.spawns.length, beforeResolveGround + 2);
            assert.equal((await Database.execute(['SELECT hp FROM characters WHERE id=3', []]))[0].hp, 0);
            assert.deepEqual((await Database.execute(['SELECT selfId FROM items WHERE characterId=3 ORDER BY id', []])).map(row => row.selfId), [57, 10]);
            done('ordinary prepare/save/physical inventory/publication returns the actual dropped bag');
        } finally { Math.random = rng; World.items = oldGround; }
        assert.equal((await Database.execute(['PRAGMA integrity_check', []]))[0].integrity_check, 'ok');
        console.log(`Minimum relations / PK block: ${groups} groups passed`);
    } finally {
        await Database.close();
        if (previousConfig === undefined) delete process.env.L2NODE_CONFIG_FILE; else process.env.L2NODE_CONFIG_FILE = previousConfig;
        if (previousShared === undefined) delete process.env.L2NODE_SHARED_CONFIG_FILE; else process.env.L2NODE_SHARED_CONFIG_FILE = previousShared;
        if (previousLearning === undefined) delete process.env.BOT_KNOWLEDGE_ERRORS_ENABLED; else process.env.BOT_KNOWLEDGE_ERRORS_ENABLED = previousLearning;
        fs.rmSync(directory, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
