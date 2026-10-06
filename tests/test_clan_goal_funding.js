const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

require('../src/Global');

// A clan production goal is a purchase the member and the clan can pay now:
// the member's funds above its reserve plus the clan's free money. The clan buys
// the item for the member at once; the member pays what it can, the clan the
// rest. An unaffordable NPC weapon (the planner's saving target) is no clan
// route, so the goal does not lock on it. A finished goal picks the next one at once.
const rootDir = path.resolve(__dirname, '..');
const databasePath = path.join(rootDir, 'tmp', 'test-clan-goal-funding.sqlite');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Policy = invoke('GameServer/Clan/ClanEquipmentPolicy');
const Equipment = invoke('GameServer/Clan/ClanEquipmentService');
const Goals = invoke('GameServer/Clan/ClanGoalService');
const Actions = invoke('GameServer/Clan/ClanActionService');
const { planForMember } = require('../src/GameServer/Clan/ClanEquipmentPlanner');

const LEADER = 4900001, POOR = 4900002, GLADIATOR = 4900022;

async function main() {
    DataCache.init();
    const member = (id, adena) => ({ characterId: id, id, classId: 1, level: 40, phase: 'cold', currentRegion: 'Ant fields',
        inventory: {}, adena, stats: { classId: 1 } });
    const planOptions = { maxExpectedKills: 1500 };

    // The NPC bridge offers a weapon the member cannot pay: no clan route.
    const alone = planForMember(member(POOR, 10000), [], [], planOptions);
    assert.strictEqual(Policy.isAcquisitionPlan(alone), false,
        `an unfunded NPC purchase is no clan route, got ${alone.strategy} ${alone.target?.name} @${alone.market?.price}`);
    // With the clan's share the same purchase is a route.
    const helped = planForMember(member(POOR, 10000), [], [], { ...planOptions, clanShare: 1000000 });
    assert.strictEqual(helped.strategy, 'market');
    assert(Policy.isAcquisitionPlan(helped), 'the clan share funds the purchase');

    // A dual sword is two bought blades: the clan funds the whole combination or none of it.
    const broadsword = DataCache.items.find((item) => item.template?.name === 'Broadsword');
    const held = { selfId: Number(broadsword.selfId), name: 'Broadsword', amount: 1, equipped: true, equippedCount: 1, equippedSlots: [7], slot: 7 };
    const gladiator = { characterId: GLADIATOR, id: GLADIATOR, classId: 2, level: 42, phase: 'cold', currentRegion: 'Ant fields',
        inventory: { [held.selfId]: held }, adena: 20000, stats: { classId: 2, role: 'dps' } };
    const dual = planForMember(gladiator, [], [], { ...planOptions, clanShare: 3000000 });
    assert(dual.combine && Number(dual.bridgeCost) === 2 * Number(dual.market.price),
        `fixture: a dual sword of two bought blades, got ${dual.strategy} ${dual.target?.name}`);
    const oneBlade = planForMember(gladiator, [], [], { ...planOptions, clanShare: Number(dual.market.price) });
    assert(!(Policy.isAcquisitionPlan(oneBlade) && oneBlade.combine), 'money for one blade is no clan route to a dual sword');

    [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].forEach((file) => fs.rmSync(file, { force: true }));
    const seed = new DatabaseSync(databasePath);
    seed.exec(fs.readFileSync(path.join(rootDir, 'database', 'sql', 'sqlite.sql'), 'utf8'));
    seed.prepare('INSERT INTO accounts(username, password) VALUES (?, ?)').run('bot_pop_funding', 'test-only');
    for (const [clanId, leaderId, poorId] of [[91, LEADER, POOR], [92, LEADER + 10, POOR + 10]]) {
        seed.prepare("INSERT INTO clans(id, name, level, leaderId) VALUES (?, ?, 2, ?)").run(clanId, `Funding${clanId}`, leaderId);
        seed.prepare(`INSERT INTO clan_simulation_clans(clanId, mode, stateJson, createdAt, updatedAt)
            VALUES (?, 'autonomous', '{"mode":"autonomous","warehouseRevision":0,"updatedAt":1}', 0, 0)`).run(clanId);
        seed.prepare(`INSERT INTO clan_warehouse_items(clanId, selfId, name, kind, amount, enchant, reservedAmount)
            VALUES (?, 57, 'Adena', 'Other.Currency', 3000000, 0, 0)`).run(clanId);
        // The poor member's wallet is earmarked for its own unpaid wish.
        for (const [id, adena] of [[leaderId, 5000000], [poorId, 20000]]) {
            seed.prepare(`INSERT INTO characters(id, username, name, classId, race, level, maxHp, maxMp, sex, face, hair, hairColor,
                locX, locY, locZ, clanId) VALUES (?, 'bot_pop_funding', ?, 1, 0, 40, 500, 250, 0, 0, 0, 0, 82000, 148000, -3400, ?)`).run(id, `Fund${id}`, clanId);
            seed.prepare(`INSERT INTO bot_life_state(characterId, accountName, characterName, level, adena, activity, phase,
                currentRegion, partyId, inventorySummary, statsJson, updatedAt) VALUES (?, 'bot_pop_funding', ?, 40, ?, 'hunting', 'cold', 'Ant fields', ?, ?, ?, 1)`)
                .run(id, `Fund${id}`, adena, id === leaderId ? 'party-busy' : null, JSON.stringify({ 57: { selfId: 57, name: 'Adena', amount: adena } }), JSON.stringify({ classId: 1,
                    ...(id === POOR ? { money: [77000, 2e-5, 15000, 1200000, 4e-5, 20000, 1463] } : {}),
                    ...(id === POOR + 10 ? { money: [77000, 0, 15000, 0] } : {}) }));
            seed.prepare(`INSERT INTO items(selfId, name, amount, enchant, equipped, slot, characterId) VALUES (57, 'Adena', ?, 0, 0, 0, ?)`).run(adena, id);
            // The leader is busy in a party and already armed; the poor member has no weapon.
            if (id === leaderId) seed.prepare(`INSERT INTO items(selfId, name, amount, enchant, equipped, slot, characterId) VALUES (?, 'Weapon', 1, 0, 1, 7, ?)`).run(helped.target.selfId, id);
        }
    }
    // Clan 93: a Gladiator holding one sword, and another member in gear debt
    // the goal would rotate to after one blade.
    seed.prepare("INSERT INTO clans(id, name, level, leaderId) VALUES (93, 'Funding93', 2, ?)").run(LEADER + 20);
    seed.prepare(`INSERT INTO clan_simulation_clans(clanId, mode, stateJson, createdAt, updatedAt)
        VALUES (93, 'autonomous', '{"mode":"autonomous","warehouseRevision":0,"updatedAt":1}', 0, 0)`).run();
    seed.prepare(`INSERT INTO clan_warehouse_items(clanId, selfId, name, kind, amount, enchant, reservedAmount)
        VALUES (93, 57, 'Adena', 'Other.Currency', 3000000, 0, 0)`).run();
    for (const [id, classId, level, partyId, weapon] of [[LEADER + 20, 1, 40, 'party-busy', helped.target.selfId], [GLADIATOR, 2, 42, null, held.selfId],
        [GLADIATOR + 1, 1, 40, null, helped.target.selfId]]) {
        seed.prepare(`INSERT INTO characters(id, username, name, classId, race, level, maxHp, maxMp, sex, face, hair, hairColor,
            locX, locY, locZ, clanId) VALUES (?, 'bot_pop_funding', ?, ?, 0, ?, 500, 250, 0, 0, 0, 0, 82000, 148000, -3400, 93)`).run(id, `Fund${id}`, classId, level);
        seed.prepare(`INSERT INTO bot_life_state(characterId, accountName, characterName, level, adena, activity, phase,
            currentRegion, partyId, inventorySummary, statsJson, updatedAt) VALUES (?, 'bot_pop_funding', ?, ?, 20000, 'hunting', 'cold', 'Ant fields', ?, ?, ?, 1)`)
            .run(id, `Fund${id}`, level, partyId, JSON.stringify({ 57: { selfId: 57, name: 'Adena', amount: 20000 }, [weapon]: { ...held, selfId: Number(weapon) } }),
                JSON.stringify({ classId, role: 'dps' }));
        seed.prepare(`INSERT INTO items(selfId, name, amount, enchant, equipped, slot, characterId) VALUES (57, 'Adena', 20000, 0, 0, 0, ?)`).run(id);
        seed.prepare(`INSERT INTO items(selfId, name, amount, enchant, equipped, slot, characterId) VALUES (?, 'Weapon', 1, 0, 1, 7, ?)`).run(weapon, id);
    }
    seed.close();
    options.default.Database.path = path.relative(rootDir, databasePath);
    Database.init();
    await Database.initClanHalls();
    await LifeState.init();
    try {
        const clan = await Goals.clanProjectionById(91);
        const result = await Equipment.resolveClan(clan, null);
        assert.strictEqual(result.ok, true, JSON.stringify(result.reason || result.code));
        assert.strictEqual(result.goal.target.memberId, POOR, 'the clan equips the member without a weapon');
        const price = Number(result.selection.plan.market.price);
        const weaponId = Number(result.selection.plan.target.selfId);
        const [owned] = await Database.execute(['SELECT COUNT(*) AS n FROM items WHERE characterId = ? AND selfId = ?', [POOR, weaponId]]);
        assert.strictEqual(Number(owned.n), 1, 'the clan bought the weapon for the member');
        const [left] = await Database.execute(['SELECT COALESCE(SUM(amount), 0) AS n FROM clan_warehouse_items WHERE clanId = 91 AND selfId = 57']);
        const [poor] = await Database.execute(['SELECT COALESCE(SUM(amount), 0) AS n FROM items WHERE characterId = ? AND selfId = 57', [POOR]]);
        const clanPaid = 3000000 - Number(left.n);
        const memberPaid = 20000 - Number(poor.n);
        assert(price > 10000, `the goal needs the clan (${price})`);
        assert.strictEqual(memberPaid, 0, 'the clan purchase preserves money earmarked for the member\'s unpaid own wish');
        assert.strictEqual(clanPaid, price - memberPaid, 'the clan pays the rest');
        const after = await LifeState.findByCharacterId(POOR);
        assert.strictEqual(after.activity, 'hunting', 'the member keeps hunting where it is');
        assert.strictEqual(after.currentRegion, 'Ant fields');

        // A purchase that fails gives the clan its part back.
        const Market = invoke('GameServer/Bot/Economy/ColdMarketService');
        const buyOffer = Market.buyOffer;
        Market.buyOffer = async () => ({ purchased: false, reason: 'test_sold_out' });
        let failed;
        try {
            failed = await Equipment.resolveClan(await Goals.clanProjectionById(92), null);
        } finally {
            Market.buyOffer = buyOffer;
        }
        const [kept] = await Database.execute(['SELECT COALESCE(SUM(amount), 0) AS n FROM clan_warehouse_items WHERE clanId = 92 AND selfId = 57']);
        const [own] = await Database.execute(['SELECT COALESCE(SUM(amount), 0) AS n FROM items WHERE characterId = ? AND selfId = 57', [POOR + 10]]);
        assert.strictEqual(Number(kept.n), 3000000, 'the clan gets its part back');
        assert.strictEqual(Number(own.n), 20000, 'the member keeps its own money');
        assert.strictEqual(Number((await LifeState.findByCharacterId(POOR + 10)).adena), 20000, 'and its cached state agrees');

        // An unchanged goal is not written again when the saved operating reserve moves.
        await Database.execute(['UPDATE characters SET level = 44 WHERE id = ?', [POOR + 10]]);
        await Database.execute(["UPDATE bot_life_state SET level = 44, statsJson = json_set(statsJson, '$.money[2]', 16000) WHERE characterId = ?", [POOR + 10]]);
        LifeState.acceptLifecycleRow((await Database.execute(['SELECT * FROM bot_life_state WHERE characterId = ?', [POOR + 10]]))[0]);
        const reserveBefore = Number((await LifeState.findByCharacterId(POOR + 10)).stats.equipmentPlan.market.reserve);
        const upsertState = LifeState.upsertState;
        let goalWrites = 0;
        LifeState.upsertState = (state, reason, ...rest) => {
            if (reason === 'clan_equipment_goal') goalWrites += 1;
            return upsertState.call(LifeState, state, reason, ...rest);
        };
        Market.buyOffer = async () => ({ purchased: false, reason: 'test_sold_out' });
        try {
            const again = await Equipment.resolveClan(await Goals.clanProjectionById(92), failed.goal);
            assert.notStrictEqual(Number(again.selection.plan.market.reserve), reserveBefore, 'fixture: the saved operating reserve moved');
        } finally {
            Market.buyOffer = buyOffer;
            LifeState.upsertState = upsertState;
        }
        assert.strictEqual(goalWrites, 0, 'the same goal is not rewritten for a moved reserve');

        // A member the cold worker owns is not bought for (its next review is).
        await Database.execute(["UPDATE bot_life_state SET simulationOwner = 'cold_simulation_owner' WHERE characterId = ?", [POOR + 10]]);
        LifeState.acceptLifecycleRow((await Database.execute(['SELECT * FROM bot_life_state WHERE characterId = ?', [POOR + 10]]))[0]);
        let buys = 0;
        Market.buyOffer = async (...args) => { buys += 1; return buyOffer(...args); };
        try {
            await Equipment.resolveClan(await Goals.clanProjectionById(92), null);
        } finally {
            Market.buyOffer = buyOffer;
        }
        assert.strictEqual(buys, 0, 'no purchase is tried for a worker-owned member');
        const [untouched] = await Database.execute(['SELECT COALESCE(SUM(amount), 0) AS n FROM clan_warehouse_items WHERE clanId = 92 AND selfId = 57']);
        assert.strictEqual(Number(untouched.n), 3000000, 'no money moves for a worker-owned member');

        // The clan buys both blades of a dual sword in one review.
        const bladeId = Number(dual.target.selfId);
        const blades = async () => Number((await Database.execute(['SELECT COALESCE(SUM(amount), 0) AS n FROM items WHERE characterId = ? AND selfId = ?',
            [GLADIATOR, bladeId]]))[0].n);
        const first = await Equipment.resolveClan(await Goals.clanProjectionById(93), null, { selectedCandidate: { memberId: GLADIATOR } });
        assert.strictEqual(first.goal?.target?.memberId, GLADIATOR, JSON.stringify(first.reason || first.code));
        assert.strictEqual(await blades(), 2, 'the clan bought both blades at once');

        // The goal is done: the completion event picks the next goal at once.
        await Database.execute([`UPDATE clan_simulation_clans SET stateJson = json_set(stateJson, '$.productionGoal', json(?)) WHERE clanId = 91`,
            [JSON.stringify(result.goal)]]);
        await Database.enqueueClanAction({ clanId: 91, actionKey: 'clan:91:equipment-advance:test', actionType: Actions.actionTypes.PLAN,
            priority: 100, payload: { reason: 'equipment_goal_completed', goalKey: result.goal.goalKey } });
        const claim = await Database.claimClanAction({});
        const advanced = await Actions.resolveAction(claim.action);
        assert.notStrictEqual(advanced.result?.level, 2, 'not the level goal');
        assert(Object.hasOwn(advanced.result || {}, 'goal') || advanced.result?.reason, 'the production review ran');
        console.log('Clan goal funding checks passed');
    } finally {
        await Database.close();
    }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
