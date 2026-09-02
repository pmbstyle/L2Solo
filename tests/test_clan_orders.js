const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

require('../src/Global');

const rootDir = path.resolve(__dirname, '..');
const databasePath = path.join(rootDir, 'tmp', 'test-clan-orders.sqlite');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const GoalService = invoke('GameServer/Clan/ClanGoalService');
const OrderService = invoke('GameServer/Clan/ClanOrderService');
const PartyService = invoke('GameServer/Clan/ClanPartyService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const BackgroundPartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');

function removeDatabaseFiles() {
    [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
        .forEach((file) => fs.rmSync(file, { force: true }));
}

function seedDatabase() {
    removeDatabaseFiles();
    const seed = new DatabaseSync(databasePath);
    seed.exec(fs.readFileSync(path.join(rootDir, 'database', 'sql', 'sqlite.sql'), 'utf8'));
    seed.prepare('INSERT INTO accounts(username, password) VALUES (?, ?)').run('order_player', 'test-only');
    seed.prepare('INSERT INTO accounts(username, password) VALUES (?, ?)').run('bot_pop_order', 'test-only');
    const insertCharacter = seed.prepare(`INSERT INTO characters(
        id, username, name, classId, race, level, maxHp, maxMp,
        sex, face, hair, hairColor, locX, locY, locZ, clanId, clanPrivileges
    ) VALUES (?, ?, ?, ?, 0, ?, 500, 250, 0, 0, 0, 0, 83400, 148600, -3400, 6300001, ?)`);
    insertCharacter.run(5300001, 'order_player', 'OrderLeader', 4, 55, 2047);
    insertCharacter.run(5300002, 'bot_pop_order', 'OrderTank', 4, 52, 0);
    insertCharacter.run(5300003, 'bot_pop_order', 'OrderHealer', 15, 50, 0);
    insertCharacter.run(5300004, 'bot_pop_order', 'OrderBuffer', 17, 51, 0);
    insertCharacter.run(5300005, 'bot_pop_order', 'OrderMage', 22, 53, 0);
    insertCharacter.run(5300006, 'bot_pop_order', 'OrderScout', 9, 49, 0);
    seed.prepare('INSERT INTO clans(id, name, level, leaderId) VALUES (6300001, ?, 3, 5300001)').run('OrderClan');
    const insertLife = seed.prepare(`INSERT INTO bot_life_state(
        characterId, accountName, characterName, level, activity, phase,
        inventorySummary, statsJson, updatedAt
    ) VALUES (?, 'bot_pop_order', ?, ?, 'hunting', 'cold', '{}', ?, 1000)`);
    insertLife.run(5300002, 'OrderTank', 52, JSON.stringify({ generatedCold: true, classId: 4, role: 'tank' }));
    insertLife.run(5300003, 'OrderHealer', 50, JSON.stringify({ generatedCold: true, classId: 15, role: 'healer' }));
    insertLife.run(5300004, 'OrderBuffer', 51, JSON.stringify({ generatedCold: true, classId: 17, role: 'buffer' }));
    insertLife.run(5300005, 'OrderMage', 53, JSON.stringify({ generatedCold: true, classId: 22, role: 'mage' }));
    insertLife.run(5300006, 'OrderScout', 49, JSON.stringify({ generatedCold: true, classId: 9, role: 'dps' }));
    seed.close();
}

async function projection() {
    return GoalService.clanProjectionById(6300001);
}

async function main() {
    seedDatabase();
    options.default.Database.path = path.relative(rootDir, databasePath);
    Database.init();
    DataCache.init();
    await LifeState.init();
    await BackgroundPartyState.init();

    try {
        await Database.syncPlayerManagedClan(6300001);
        const created = await OrderService.create(await projection(), {
            itemId: 1419,
            amount: 3,
            strategy: 'market',
            maxUnitPrice: 500000,
            budget: 1500000,
            memberIds: [5300002, 5300003]
        }, { offer: null });
        assert.strictEqual(created.ok, true);
        assert.strictEqual(created.order.status, 'active');
        assert.strictEqual(created.order.itemName, 'Blood Mark');
        assert.strictEqual(created.goal.controlledBy, 'player');
        assert.strictEqual(created.goal.plan.kind, 'market');
        assert.deepStrictEqual(created.goal.assignedMemberIds, [5300002, 5300003]);

        const protectedOverride = await GoalService.resolveClan(await projection());
        assert.strictEqual(protectedOverride.skipped, true);
        assert.strictEqual(protectedOverride.reason, 'player_order_active',
            'the automatic planner must not overwrite an active Observer order');

        let [action] = await Database.execute([
            `SELECT actionType, status, reasonCode FROM clan_actions
             WHERE clanId = ? ORDER BY id DESC LIMIT 1`,
            [6300001]
        ]);
        assert.deepStrictEqual(action, { actionType: 'market', status: 'pending', reasonCode: 'player_order_created' });
        let [demand] = await Database.execute([
            `SELECT itemId, amount, maxPrice, status FROM clan_market_demands
             WHERE clanId = ? ORDER BY id DESC LIMIT 1`,
            [6300001]
        ]);
        assert.deepStrictEqual(demand, { itemId: 1419, amount: 3, maxPrice: 500000, status: 'open' });

        const invalidMembers = await OrderService.create(await projection(), {
            itemId: 1419,
            amount: 1,
            strategy: 'market',
            memberIds: [9999999]
        }, { offer: null });
        assert.strictEqual(invalidMembers.code, 'invalid_clan_order_members');

        const paused = await OrderService.transition(await projection(), 'pause', { revision: created.order.revision });
        assert.strictEqual(paused.ok, true);
        assert.strictEqual(paused.order.status, 'paused');
        [action] = await Database.execute([
            'SELECT actionType, status, reasonCode FROM clan_actions WHERE clanId = ? ORDER BY id DESC LIMIT 1',
            [6300001]
        ]);
        assert.deepStrictEqual(action, { actionType: 'market', status: 'cancelled', reasonCode: 'player_order_pause' });

        const revisionConflict = await OrderService.transition(await projection(), 'resume', {
            revision: created.order.revision
        }, { offer: null });
        assert.strictEqual(revisionConflict.code, 'clan_order_revision_conflict');

        const resumed = await OrderService.transition(await projection(), 'resume', {
            revision: paused.order.revision
        }, { offer: null });
        assert.strictEqual(resumed.ok, true);
        assert.strictEqual(resumed.order.status, 'active');
        assert.strictEqual(resumed.goal.plan.kind, 'market');

        const replanned = await OrderService.transition(await projection(), 'replan', {
            revision: resumed.order.revision
        }, { offer: null });
        assert.strictEqual(replanned.ok, true);
        assert.strictEqual(replanned.order.revision, resumed.order.revision + 1);

        await Database.execute([`
            INSERT INTO clan_warehouse_items
                (clanId, selfId, name, kind, amount, enchant, reservedAmount, createdAt, updatedAt)
            VALUES (6300001, 1419, 'Blood Mark', 'quest', 3, 0, 0, 1000, 1000)
        `, []], 'test:clan-order-stock');
        const completed = await OrderService.syncProgress(await projection(), 250000, 'market_purchase');
        assert.strictEqual(completed.ok, true);
        assert.strictEqual(completed.order.status, 'completed');
        assert.strictEqual(completed.order.spent, 250000);
        assert.strictEqual(completed.goal.progress, 3);
        assert.strictEqual(completed.goal.status, 'completed');
        const [automaticAfterCompletion] = await Database.execute([
            `SELECT actionType, status, reasonCode FROM clan_actions
             WHERE clanId = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`,
            [6300001]
        ]);
        assert.deepStrictEqual(automaticAfterCompletion, {
            actionType: 'goal_plan', status: 'pending', reasonCode: 'player_order_completed'
        }, 'the automatic clan goal must resume after a player order completes');
        [demand] = await Database.execute([
            'SELECT status FROM clan_market_demands WHERE clanId = ? ORDER BY id DESC LIMIT 1',
            [6300001]
        ]);
        assert.strictEqual(demand.status, 'fulfilled');

        const replacement = await OrderService.create(await projection(), {
            itemId: 1419,
            amount: 4,
            strategy: 'market',
            memberIds: [5300002]
        }, { offer: null });
        assert.strictEqual(replacement.ok, true);
        const cancelled = await OrderService.transition(await projection(), 'cancel', {
            revision: replacement.order.revision
        });
        assert.strictEqual(cancelled.ok, true);
        assert.strictEqual(cancelled.order.status, 'cancelled');
        assert.strictEqual(cancelled.goal, null);
        assert.strictEqual(await OrderService.current(6300001), null);
        const [automaticAfterCancel] = await Database.execute([
            `SELECT actionType, status, reasonCode FROM clan_actions
             WHERE clanId = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`,
            [6300001]
        ]);
        assert.deepStrictEqual(automaticAfterCancel, {
            actionType: 'goal_plan', status: 'pending', reasonCode: 'player_order_cancelled'
        }, 'cancelling an Observer order must return control to the automatic planner');

        const farmMembers = [5300002, 5300003, 5300004, 5300005, 5300006];
        const legacyParty = await BackgroundPartyState.createOrUpdate({
            partyId: 'legacy-clan-party',
            leaderId: 5300002,
            memberIds: farmMembers,
            spotId: 'legacy-spot',
            startedAt: 1000,
            nextResolveAt: Date.now() + 30000,
            status: 'active',
            stats: { objective: { clanId: 6300001, clanGoalKey: 'legacy-equipment-goal' } }
        });
        assert(legacyParty);
        await Database.execute([
            `UPDATE bot_life_state SET partyId = 'legacy-clan-party'
             WHERE characterId BETWEEN 5300002 AND 5300006`,
            []
        ], 'test:legacy-clan-party');
        const farmOrder = await OrderService.create(await projection(), {
            itemId: 439,
            amount: 1,
            strategy: 'farm',
            memberIds: farmMembers
        }, {
            source: { npcId: 660, npcName: 'Archer Of Greed', spotId: '28_5', npcLevel: 46 }
        });
        assert.strictEqual(farmOrder.ok, true);
        const started = await PartyService.resolveClan(await projection(), { rng: () => 0 });
        assert.strictEqual(started.ok, true);
        assert.strictEqual(started.started, true,
            'a player order must supersede an earlier protected autonomous clan party');
        assert.strictEqual(BackgroundPartyState.find('legacy-clan-party').status, 'dissolved');
        const attachedLegacyMembers = await Database.execute([
            "SELECT characterId FROM bot_life_state WHERE partyId = 'legacy-clan-party'",
            []
        ]);
        assert.deepStrictEqual(attachedLegacyMembers, []);

        const activeOperation = await Database.fetchActiveAutonomousClanOperation(6300001);
        assert(activeOperation);
        const farmCompletion = await Database.completeAutonomousClanOperation({
            operationId: activeOperation.id,
            success: true,
            drops: [{ selfId: 439, name: 'Karmian Tunic', kind: 'Armor.chest', amount: 1 }],
            reasonCode: 'party_operation_succeeded'
        });
        assert.strictEqual(farmCompletion.ok, true);

        const delivered = await OrderService.syncProgress(await projection(), 0, 'party_reward_applied');
        assert.strictEqual(delivered.ok, true);
        assert.strictEqual(delivered.order.status, 'completed');
        assert.strictEqual(delivered.goal.status, 'completed');
        assert.strictEqual(delivered.goal.progress, 1);
        assert.strictEqual(delivered.goal.plan.delivery.kind, 'best_upgrade');
        assert.strictEqual(delivered.goal.plan.delivery.deliveredAmount, 1);
        assert.strictEqual(delivered.goal.plan.delivery.recipients.length, 1);
        const beneficiaryId = Number(delivered.goal.plan.delivery.recipients[0].memberId);
        assert(farmMembers.includes(beneficiaryId));

        const remainingKarmian = (await Database.fetchClanWarehouseItems(6300001))
            .filter((item) => Number(item.selfId) === 439)
            .reduce((sum, item) => sum + Number(item.amount || 0), 0);
        assert.strictEqual(remainingKarmian, 0, 'the clan warehouse is a transit point for equipment orders');
        const deliveryLedger = await Database.fetchPlayerManagedClanOrderDeliveries({
            clanId: 6300001,
            orderId: farmOrder.order.id,
            itemId: 439
        });
        assert.strictEqual(deliveryLedger.length, 1);
        assert.strictEqual(Number(deliveryLedger[0].characterId), beneficiaryId);
        assert.match(deliveryLedger[0].resolveKey, new RegExp(`^player-order:${farmOrder.order.id}:delivery:0:${beneficiaryId}$`));

        const [equippedKarmian] = await Database.execute([`
            SELECT selfId, amount, equipped, slot
            FROM items WHERE characterId = ? AND selfId = 439
            ORDER BY id LIMIT 1
        `, [beneficiaryId]], 'test:clan-order-delivery');
        assert.deepStrictEqual(equippedKarmian, { selfId: 439, amount: 1, equipped: 1, slot: 10 });
        const beneficiary = await LifeState.findByCharacterId(beneficiaryId);
        assert.strictEqual(beneficiary.inventory[439].equipped, true);
        assert.deepStrictEqual(beneficiary.inventory[439].equippedSlots, [10]);

        console.log('Clan order lifecycle checks passed');
    } finally {
        await Database.close();
        removeDatabaseFiles();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
