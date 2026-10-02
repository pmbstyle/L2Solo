const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

require('../src/Global');

// A clan production goal is a purchase the member and the clan can pay now:
// the member's funds above its reserve plus the clan's share (at most 35% of
// its free money). The clan hands the missing Adena over at assignment. An
// unaffordable NPC weapon (the planner's saving target) is no clan route, so the
// goal does not lock on it. A finished goal picks the next one at once.
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

const LEADER = 4900001, POOR = 4900002;

async function main() {
    DataCache.init();
    const member = (id, adena) => ({ characterId: id, id, classId: 1, level: 40, phase: 'cold', currentRegion: 'Giran',
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

    [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].forEach((file) => fs.rmSync(file, { force: true }));
    const seed = new DatabaseSync(databasePath);
    seed.exec(fs.readFileSync(path.join(rootDir, 'database', 'sql', 'sqlite.sql'), 'utf8'));
    seed.prepare('INSERT INTO accounts(username, password) VALUES (?, ?)').run('bot_pop_funding', 'test-only');
    seed.prepare("INSERT INTO clans(id, name, level, leaderId) VALUES (91, 'Funding', 2, ?)").run(LEADER);
    seed.prepare(`INSERT INTO clan_simulation_clans(clanId, mode, stateJson, createdAt, updatedAt)
        VALUES (91, 'autonomous', '{"mode":"autonomous","warehouseRevision":0,"updatedAt":1}', 0, 0)`).run();
    seed.prepare(`INSERT INTO clan_warehouse_items(clanId, selfId, name, kind, amount, enchant, reservedAmount)
        VALUES (91, 57, 'Adena', 'Other.Currency', 3000000, 0, 0)`).run();
    for (const [id, adena] of [[LEADER, 5000000], [POOR, 10000]]) {
        seed.prepare(`INSERT INTO characters(id, username, name, classId, race, level, maxHp, maxMp, sex, face, hair, hairColor,
            locX, locY, locZ, clanId) VALUES (?, 'bot_pop_funding', ?, 1, 0, 40, 500, 250, 0, 0, 0, 0, 82000, 148000, -3400, 91)`).run(id, `Fund${id}`);
        seed.prepare(`INSERT INTO bot_life_state(characterId, accountName, characterName, level, adena, activity, phase,
            currentRegion, partyId, inventorySummary, statsJson, updatedAt) VALUES (?, 'bot_pop_funding', ?, 40, ?, 'hunting', 'cold', 'Giran', ?, ?, ?, 1)`)
            .run(id, `Fund${id}`, adena, id === LEADER ? 'party-busy' : null, JSON.stringify({ 57: { selfId: 57, name: 'Adena', amount: adena } }), JSON.stringify({ classId: 1 }));
        seed.prepare(`INSERT INTO items(selfId, name, amount, enchant, equipped, slot, characterId) VALUES (57, 'Adena', ?, 0, 0, 0, ?)`).run(adena, id);
        // The leader is busy in a party and already armed; the poor member has no weapon.
        if (id === LEADER) seed.prepare(`INSERT INTO items(selfId, name, amount, enchant, equipped, slot, characterId) VALUES (?, 'Weapon', 1, 0, 1, 7, ?)`).run(helped.target.selfId, id);
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
        const [poor] = await Database.execute(['SELECT COALESCE(SUM(amount), 0) AS n FROM items WHERE characterId = ? AND selfId = 57', [POOR]]);
        const [left] = await Database.execute(['SELECT amount FROM clan_warehouse_items WHERE clanId = 91 AND selfId = 57']);
        const given = 3000000 - Number(left.amount);
        assert(given > 0 && given <= 1050000, `the clan gives at most 35% of its free money (${given})`);
        assert.strictEqual(Number(poor.n), 10000 + given);
        assert(Number(poor.n) >= price, 'the member can now pay its goal');

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
