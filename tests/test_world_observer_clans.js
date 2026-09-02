const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
DataCache.init();
const Observer = invoke('WorldObserver/WorldObserverServer');
const observerApp = fs.readFileSync(path.join(__dirname, '..', 'src', 'WorldObserver', 'public', 'app.js'), 'utf8');
assert.match(observerApp, /const crestAvailable = Number\(clan\.level \|\| 0\) >= 3/,
    'the clan manager must only expose crest selection from clan level 3');
assert.match(observerApp, /Clan crest locked/,
    'lower-level player clans should explain why crest selection is unavailable');

const goal = Observer.compactClanGoal({
    updatedAt: 1234,
    goal: {
        status: 'active',
        type: 'item',
        progress: 0,
        required: 1,
        target: { itemId: 1419, itemName: 'Blood Mark', npcId: 12079 },
        plan: { kind: 'market', reasonCode: 'market_purchase', label: 'Buy a Blood Mark' },
        failureCount: 2
    }
});
assert.deepStrictEqual(goal, {
    status: 'active',
    type: 'item',
    progress: 0,
    required: 1,
    target: { itemId: 1419, itemName: 'Blood Mark', iconUrl: null, npcId: 12079, npcName: null },
    plan: { kind: 'market', reasonCode: 'market_purchase', label: 'Buy a Blood Mark' },
    failureCount: 2,
    updatedAt: 1234
}, 'clan goals must expose a bounded observer-friendly summary');

const itemGoal = Observer.compactClanGoal({
    status: 'executing',
    type: 'equipment',
    progress: 0,
    required: 1,
    target: { itemId: 2406, itemName: 'Avadon Robe' }
});
assert.strictEqual(itemGoal.target.iconUrl, '/observer/item-icons/armor_t59_ul_i00.png',
    'item goals must reuse the local Observer item-icon catalog');

const compactOrder = Observer.compactClanOrder({
    id: 4,
    revision: 2,
    status: 'active',
    itemId: 2406,
    itemName: 'Avadon Robe',
    amount: 1,
    strategy: 'farm',
    maxUnitPrice: 500000,
    budget: 800000,
    spent: 0,
    memberIds: [42],
    plan: { kind: 'farm' },
    createdAt: 100,
    updatedAt: 200
});
assert.strictEqual(compactOrder.iconUrl, '/observer/item-icons/armor_t59_ul_i00.png');
assert.deepStrictEqual(compactOrder.memberIds, [42]);
assert(Observer.clanOrderItems('Avadon Robe', 5).some((item) => item.id === 2406 && item.iconUrl),
    'the order item catalog must expose searchable item icons');

const overview = Observer.compactClanOverview({
    id: 7,
    name: 'Dawn Covenant',
    level: 2,
    crestId: 17,
    leaderId: 42,
    leaderName: 'Aster',
    simulationVersion: 1,
    simulationCreatedAt: 100,
    simulationUpdatedAt: 200,
    stateJson: JSON.stringify({ updatedAt: 200, goal: { status: 'active', type: 'adena', progress: 10, required: 100 } }),
    memberCount: 5,
    botMembers: 5,
    playerMembers: 0,
    onlineMembers: 2,
    botOnlineMembers: 2,
    hotMembers: 1,
    averageLevel: 38.4,
    highestLevel: 42,
    lowestLevel: 35
}, {
    warehouse: { adena: 1200000, bloodMarks: 1, itemStacks: 3 },
    contributions: [{ targetLevel: 1, entries: 5, amount: 650000 }],
    demand: { openDemands: 1, requestedUnits: 1, latestDemandAt: 300 },
    operation: { activeOperations: 1, latestOperationAt: 400 }
});
assert.strictEqual(overview.autonomous, true);
assert.strictEqual(overview.automationMode, 'autonomous');
assert.strictEqual(overview.memberCount, 5);
assert.strictEqual(overview.botMembers, 5);
assert.strictEqual(overview.warehouse.bloodMarks, 1);
assert.strictEqual(overview.goal.status, 'active');
assert.strictEqual(overview.operations.active, 1);
assert.strictEqual(overview.crestUrl, null, 'clans below level 3 must not expose a crest');

const crestOverview = Observer.compactClanOverview({
    id: 8,
    name: 'Silver Oath',
    level: 3,
    crestId: 18,
    memberCount: 1,
    botMembers: 1
});
assert.strictEqual(crestOverview.crestUrl, '/observer/api/clan/8/crest?v=18', 'eligible assigned clan crests must expose a versioned observer URL');

const playerManagedOverview = Observer.compactClanOverview({
    id: 9,
    name: 'Player Vanguard',
    level: 3,
    leaderId: 43,
    simulationVersion: 1,
    simulationMode: 'player_managed',
    stateJson: '{}',
    memberCount: 2,
    botMembers: 1,
    playerMembers: 1
});
assert.strictEqual(playerManagedOverview.automated, true);
assert.strictEqual(playerManagedOverview.autonomous, false);
assert.strictEqual(playerManagedOverview.playerManaged, true);

assert.deepStrictEqual(Observer.compactActorClan({
    fetchId: () => 42,
    fetchClanId: () => 8,
    fetchClan: () => ({ id: 8, name: 'Silver Oath' })
}), { id: 8, name: 'Silver Oath' }, 'actor details must expose a compact clan link target');
assert.strictEqual(Observer.compactActorClan({ fetchId: () => 43, fetchClanId: () => 0 }), null,
    'clanless actor details must not expose a link target');

const autonomousCrest = fs.readFileSync(path.join(__dirname, '..', 'data', 'crests', 'clan', 'crest-001.bmp'));
assert.deepStrictEqual(Observer.browserClanCrestData(autonomousCrest), autonomousCrest, 'browser-ready BMP crests must remain byte-exact');
const clientCrest = invoke('GameServer/Clan/ClanCrestService').clientCrestData(autonomousCrest);
const browserClientCrest = Observer.browserClanCrestData(clientCrest);
assert.strictEqual(browserClientCrest.toString('ascii', 0, 2), 'BM', 'client DDS crests must be decoded for browsers');
assert.strictEqual(browserClientCrest.readInt32LE(18), 16);
assert.strictEqual(browserClientCrest.readInt32LE(22), -12);

const observerPixels = Buffer.alloc(16 * 12 * 4, 255);
const decodedObserverPixels = Observer.decodeClanCrestPixels({
    width: 16,
    height: 12,
    pixels: observerPixels.toString('base64')
});
assert.strictEqual(decodedObserverPixels.ok, true);
assert.deepStrictEqual(decodedObserverPixels.pixels, observerPixels);
assert.strictEqual(Observer.decodeClanCrestPixels({ width: 16, height: 12, pixels: 'AAAA' }).code, 'invalid_crest_pixels');

const botMember = Observer.compactClanMember({
    id: 42,
    name: 'Aster',
    classId: 20,
    race: 0,
    level: 42,
    exp: 900,
    sp: 80,
    clanId: 7,
    isOnline: 0,
    locX: 83400,
    locY: 147943,
    locZ: -3400,
    karma: 0,
    pvp: 3,
    pk: 0,
    accountName: 'bot_pop_42',
    activity: 'hunting',
    phase: 'cold',
    statsJson: JSON.stringify({ role: 'tank', classId: 20 }),
    inventorySummary: JSON.stringify({}),
    isBot: 1
}, null, 42);
assert.strictEqual(botMember.kind, 'bot');
assert.strictEqual(botMember.isBot, true);
assert.strictEqual(botMember.isLeader, true);
assert.strictEqual(botMember.role, 'tank');
assert.strictEqual(botMember.level, 42);
assert.strictEqual(botMember.online, false);

const playerMember = Observer.compactClanMember({
    id: 43,
    name: 'Slava',
    classId: 0,
    race: 0,
    level: 20,
    clanId: 7,
    isOnline: 1,
    locX: 0,
    locY: 0,
    locZ: 0,
    statsJson: '{}',
    inventorySummary: '{}',
    isBot: 0
}, null, 42);
assert.strictEqual(playerMember.kind, 'player');
assert.strictEqual(playerMember.isBot, false);
assert.strictEqual(playerMember.online, true);

async function databaseBackedChecks() {
    const rootDir = path.resolve(__dirname, '..');
    const databasePath = path.join(rootDir, 'tmp', 'test-world-observer-clans.sqlite');
    [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].forEach((file) => fs.rmSync(file, { force: true }));
    const seed = new DatabaseSync(databasePath);
    seed.exec(fs.readFileSync(path.join(rootDir, 'database', 'sql', 'sqlite.sql'), 'utf8'));
    seed.prepare('INSERT INTO accounts(username, password) VALUES (?, ?)').run('bot_pop_observer', 'test-only');
    seed.prepare('INSERT INTO accounts(username, password) VALUES (?, ?)').run('observer_player', 'test-only');
    const insertCharacter = seed.prepare(`INSERT INTO characters(
        id, username, name, classId, race, level, maxHp, maxMp,
        sex, face, hair, hairColor, locX, locY, locZ
    ) VALUES (?, ?, ?, ?, 0, ?, 500, 250, 0, 0, 0, 0, 83400, 148600, -3400)`);
    insertCharacter.run(9101, 'bot_pop_observer', 'ObserverTank', 20, 42);
    insertCharacter.run(9102, 'bot_pop_observer', 'ObserverHealer', 15, 40);
    insertCharacter.run(9103, 'observer_player', 'ObserverPlayer', 0, 35);
    seed.prepare('INSERT INTO clans(id, name, level, leaderId) VALUES (91, ?, 3, 9101)').run('Observer Vanguard');
    seed.prepare('INSERT INTO clan_crests(id, clanId, kind, data, createdAt) VALUES (91001, 91, ?, ?, 200)')
        .run('pledge', fs.readFileSync(path.join(rootDir, 'data', 'crests', 'clan', 'crest-001.bmp')));
    seed.prepare('UPDATE clans SET crestId = 91001 WHERE id = 91').run();
    seed.prepare('UPDATE characters SET clanId = 91 WHERE id IN (9101, 9102, 9103)').run();
    const insertState = seed.prepare(`INSERT INTO bot_life_state(
        characterId, accountName, characterName, level, adena, activity, phase,
        currentRegion, inventorySummary, statsJson, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insertState.run(9101, 'bot_pop_observer', 'ObserverTank', 42, 120000, 'hunting', 'cold', 'Giran',
        JSON.stringify({ '57': { selfId: 57, name: 'Adena', amount: 120000 } }), JSON.stringify({ role: 'tank' }), 1000);
    insertState.run(9102, 'bot_pop_observer', 'ObserverHealer', 40, 90000, 'resting', 'cold', 'Giran',
        JSON.stringify({ '57': { selfId: 57, name: 'Adena', amount: 90000 } }), JSON.stringify({ role: 'healer' }), 1000);
    seed.prepare(`INSERT INTO clan_simulation_clans(clanId, version, mode, createdAt, updatedAt, stateJson)
        VALUES (91, 1, 'player_managed', 100, 200, ?)`).run(JSON.stringify({
        updatedAt: 200,
        goal: { status: 'active', type: 'item', progress: 1, required: 3, target: { itemId: 1419, itemName: 'Blood Mark' } }
    }));
    seed.prepare(`INSERT INTO clan_warehouse_items(clanId, selfId, name, kind, amount, createdAt, updatedAt)
        VALUES (91, 57, 'Adena', 'currency', 120000, 100, 200)`).run();
    seed.prepare(`INSERT INTO clan_warehouse_items(clanId, selfId, name, kind, amount, createdAt, updatedAt)
        VALUES (91, 1419, 'Blood Mark', 'quest', 2, 100, 200)`).run();
    seed.prepare(`INSERT INTO clan_contributions(clanId, characterId, targetLevel, amount, resolveKey, createdAt)
        VALUES (91, 9101, 4, 50000, 'observer:test', 200)`).run();
    seed.prepare(`INSERT INTO clan_goal_events(clanId, eventType, goalType, plan, reasonCode, payloadJson, occurredAt)
        VALUES (91, 'goal_updated', 'item', 'market', 'observer_test', '{}', 300)`).run();
    seed.prepare(`INSERT INTO clan_orders(
        clanId, revision, kind, status, itemId, itemName, amount, strategy,
        maxUnitPrice, budget, spent, memberIdsJson, planJson, reasonCode, createdAt, updatedAt
    ) VALUES (91, 1, 'gather_item', 'active', 1419, 'Blood Mark', 3, 'market',
        500000, 1500000, 0, '[9101,9102]', '{"kind":"market"}', 'market_demand_open', 200, 300)`).run();
    seed.prepare(`INSERT INTO clan_market_demands(clanId, itemId, amount, maxPrice, goalKey, status, createdAt, updatedAt)
        VALUES (91, 1419, 2, 500000, 'observer:test', 'open', 200, 300)`).run();
    seed.prepare(`INSERT INTO clan_operations(
        id, clanId, operationKey, operationType, targetNpcId, leaderId, memberIdsJson,
        status, createdAt, updatedAt
    ) VALUES (91, 91, 'observer:operation', 'farm', 12079, 9101, '[9101,9102]', 'active', 400, 450)`).run();
    seed.prepare(`INSERT INTO clan_operation_members(operationId, clanId, characterId, status, reservedAt)
        VALUES (91, 91, 9101, 'active', 400), (91, 91, 9102, 'active', 400)`).run();
    seed.close();

    options.default.Database.path = path.relative(rootDir, databasePath);
    Database.init();
    try {
        const directory = await Observer.clanSnapshot();
        assert.strictEqual(directory.total, 1);
        assert.strictEqual(directory.clans[0].name, 'Observer Vanguard');
        assert.strictEqual(directory.clans[0].memberCount, 3);
        assert.strictEqual(directory.clans[0].botMembers, 2);
        assert.strictEqual(directory.clans[0].warehouse.bloodMarks, 2);
        assert.strictEqual(directory.clans[0].operations.active, 1);
        assert.strictEqual(directory.clans[0].crestUrl, '/observer/api/clan/91/crest?v=91001');

        const crest = await Observer.clanCrest(91);
        assert.strictEqual(crest.clanId, 91);
        assert.strictEqual(crest.kind, 'pledge');
        assert.strictEqual(crest.data.toString('ascii', 0, 2), 'BM');

        const uploadedCrest = invoke('GameServer/Clan/ClanCrestService').clientCrestData(crest.data);
        await Database.execute(['UPDATE clan_crests SET data = ? WHERE id = 91001', [uploadedCrest]], 'test:observer-uploaded-crest');
        const decodedUpload = await Observer.clanCrest(91);
        assert.strictEqual(decodedUpload.data.toString('ascii', 0, 2), 'BM', 'observer must render byte-exact client DDS uploads as BMP');

        const managedPixels = Buffer.alloc(16 * 12 * 4, 255);
        const managedUpdate = await Observer.updatePlayerManagedClanCrest(91, {
            width: 16,
            height: 12,
            pixels: managedPixels.toString('base64')
        });
        assert.strictEqual(managedUpdate.ok, true);
        assert(Number(managedUpdate.crestId) > 0);
        assert.strictEqual(managedUpdate.crestUrl, `/observer/api/clan/91/crest?v=${managedUpdate.crestId}`);
        const managedCrests = await Database.execute([`SELECT id, data FROM clan_crests
            WHERE clanId = 91 AND kind = 'pledge'`, []], 'test:observer-managed-crest');
        assert.strictEqual(managedCrests.length, 1, 'Observer crest replacement must not retain stale blobs');
        assert.strictEqual(Buffer.from(managedCrests[0].data).length, 256);

        const detail = await Observer.clanDetail(91);
        assert.strictEqual(detail.clan.id, 91);
        assert.strictEqual(detail.members.length, 3);
        assert.strictEqual(detail.bots.length, 2);
        assert.strictEqual(detail.operation.memberCount, 2);
        assert.strictEqual(detail.operation.startedAt, 400);
        assert.strictEqual(detail.operation.members[0].role, 'tank');
        assert.strictEqual(detail.events.length, 1);
        assert.strictEqual(detail.order.itemName, 'Blood Mark');
        assert.deepStrictEqual(detail.order.memberIds, [9101, 9102]);
        assert.strictEqual(detail.orderHistory.length, 1);
        const offlinePlayer = await Observer.actorDetail('player', 9103);
        assert.strictEqual(offlinePlayer.kind, 'player', 'offline clan players must remain selectable in Selected actor');
        assert.strictEqual(offlinePlayer.name, 'ObserverPlayer');
        assert.strictEqual(offlinePlayer.online, false);
        assert.strictEqual(offlinePlayer.clan.id, 91);
    } finally {
        await Database.close();
        [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].forEach((file) => fs.rmSync(file, { force: true }));
    }
}

databaseBackedChecks()
    .then(() => console.log('World observer clan directory checks passed'))
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
