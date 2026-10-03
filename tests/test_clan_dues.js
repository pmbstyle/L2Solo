const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

require('../src/Global');

// The clan's dues (one mechanism for all levels): once per member and hour a
// share of what it earned since its last settlement, never of its savings; a busy
// member (party, live actor, leased worker row) pays at the next pass; a one-off
// investment from savings toward the clan's current target; rates follow the
// members' personas.
const rootDir = path.resolve(__dirname, '..');
const databasePath = path.join(rootDir, 'tmp', 'test-clan-dues.sqlite');
const Database = invoke('Database');
const Policy = invoke('GameServer/Clan/ClanContributionPolicy');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Runtime = invoke('GameServer/ClanHall/Runtime');
const GoalService = invoke('GameServer/Clan/ClanGoalService');

const LEADER = 4600001, PAYER = 4600002, PARTIED = 4600003, SAVER = 4600004;

function seedDatabase() {
    [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].forEach((file) => fs.rmSync(file, { force: true }));
    const seed = new DatabaseSync(databasePath);
    seed.exec(fs.readFileSync(path.join(rootDir, 'database', 'sql', 'sqlite.sql'), 'utf8'));
    seed.prepare('INSERT INTO accounts(username, password) VALUES (?, ?)').run('bot_pop_dues', 'test-only');
    for (const [id, adena, partyId] of [[LEADER, 0, null], [PAYER, 1000000, null], [PARTIED, 1000000, 'party-1'], [SAVER, 4000000, null]]) {
        seed.prepare(`INSERT INTO characters(id, username, name, classId, race, level, maxHp, maxMp, sex, face, hair, hairColor,
            locX, locY, locZ) VALUES (?, 'bot_pop_dues', ?, 0, 0, 30, 500, 250, 0, 0, 0, 0, 0, 0, 0)`).run(id, `Dues${id}`);
        seed.prepare(`INSERT INTO bot_life_state(characterId, accountName, characterName, level, adena, activity, phase, partyId,
            inventorySummary, statsJson, updatedAt) VALUES (?, 'bot_pop_dues', ?, 30, ?, 'hunting', 'cold', ?, ?, '{}', 1)`)
            .run(id, `Dues${id}`, adena, partyId, JSON.stringify({ 57: { selfId: 57, name: 'Adena', amount: adena } }));
        if (adena) seed.prepare(`INSERT INTO items(selfId, name, amount, enchant, equipped, slot, characterId)
            VALUES (57, 'Adena', ?, 0, 0, 0, ?)`).run(adena, id);
    }
    seed.close();
}

async function main() {
    // Rates by persona.
    const ambitious = { ambition: 0.85, empathy: 0.3, commitment: 0.3, sociability: 0.3 };
    const generous = { ambition: 0.5, empathy: 0.9, commitment: 0.9, sociability: 0.9 };
    const near = (actual, expected, message) => assert(Math.abs(actual - expected) < 1e-9, `${message}: ${actual}`);
    near(Policy.duesRate([ambitious, ambitious]), 0.30, 'an ambitious clan: 10% + 20%');
    near(Policy.duesRate([generous]), 0.10, 'an unambitious clan: the 10% base');
    near(Policy.memberRate(0.30, generous), 0.35, 'dues and top-up stay under the 35% cap');
    near(Policy.memberRate(0.10, ambitious), 0.10, 'a stingy member adds nothing');
    const buying = { adena: 1000000, level: 30, stats: { equipmentPlan: { strategy: 'market', market: { price: 500000 } } } };
    near(Policy.memberRate(0.10, generous, buying), 0.10, 'no top-up while the member is about to buy its gear');
    const bridge = { adena: 2300, level: 30, stats: { equipmentPlan: { strategy: 'market', weaponBridge: true, market: { price: 1766, reserve: 500 } } } };
    near(Policy.memberRate(0.10, generous, bridge), 0.10, 'the plan\'s stored reserve counts: a member about to buy its bridge weapon gets no top-up');
    near(Policy.investFraction({ commitment: 0.6, ambition: 0.8 }), 0.245, 'investment share');
    // One funding rule (U5): the member's reserve is the bot's operating reserve,
    // and its own buy-order escrow counts toward its purchase.
    const PurchaseFunding = invoke('GameServer/Bot/Economy/PurchaseFunding');
    for (const wallet of [{ level: 20, adena: 10000 }, { level: 40, adena: 3000000 }, { level: 1, adena: 0 }]) {
        assert.strictEqual(Policy.personalReserve(wallet), PurchaseFunding.operatingReserve(wallet), `the clan reserve is the operating reserve (${wallet.adena})`);
    }
    const AfkMarket = invoke('GameServer/Bot/Economy/BotAfkMarketService');
    const escrowOf = AfkMarket.buyOrderEscrow;
    AfkMarket.buyOrderEscrow = (characterId) => (characterId === 4600099 ? 300000 : 0);
    const escrowed = { characterId: 4600099, adena: 300000, level: 30, stats: { equipmentPlan: { strategy: 'market', market: { price: 500000, reserve: 10000 } } } };
    assert.strictEqual(Policy.ownGearPurchase(escrowed), 'funded', 'the buy order\'s escrow funds the member\'s purchase');
    AfkMarket.buyOrderEscrow = escrowOf;
    near(Policy.investFraction({ commitment: 0.6, ambition: 0.8 }, buying), 0,
        'no investment while the member is about to buy its gear (K10)');
    const saving = { adena: 100000, level: 30, stats: { equipmentPlan: { strategy: 'market', market: { price: 500000 } } } };
    near(Policy.investFraction({ commitment: 0.6, ambition: 0.8 }, saving), 0.245, 'a member still saving invests as before');

    seedDatabase();
    options.default.Database.path = path.relative(rootDir, databasePath);
    Database.init();
    await Database.initClanHalls();
    await LifeState.init();
    try {
        const created = await Database.createAutonomousClan({ name: 'DuesClan', leaderId: LEADER,
            memberIds: [LEADER, PAYER, PARTIED, SAVER], founderQuorum: 4, maxBotClans: 40, maxBotMemberShare: 1,
            stateJson: { level: 0, goal: null } });
        assert.strictEqual(created.ok, true);
        await Database.execute(['UPDATE clans SET level = 1 WHERE id = ?', [created.clanId]]);
        await Database.execute([`UPDATE clan_simulation_clans SET stateJson = json_set(stateJson, '$.level', 1) WHERE clanId = ?`, [created.clanId]]);
        const settle = (characterId, extra = {}) => Database.settleClanDues({ clanId: created.clanId, characterId, rate: 0.2, ...extra });

        // A party member is held by the party simulation: it pays next time (K2).
        assert.strictEqual((await settle(PARTIED)).code, 'member_busy');

        // Investment once per target: the next level's fund.
        const required = Policy.scaledAdenaRequirement(1);
        const first = await settle(SAVER, { investFraction: 0.25, timestamp: 10 });
        assert.strictEqual(first.dues, 0, 'the first settlement only marks the wallet');
        assert.strictEqual(first.investment, Math.min(required, Math.floor((4000000 - 400000) * 0.25)), 'a quarter of the free savings');
        const second = await settle(SAVER, { investFraction: 0.25, timestamp: 11 });
        assert.strictEqual(second.investment, 0, 'one investment per target');

        // Only what was earned since the last settlement is due: the mark follows the wealth down after a
        // purchase, so spending exempts its own hour, not the hours until the old peak returns (user, 2026-10-03).
        await settle(PAYER, { timestamp: 12 });
        await Database.execute(['UPDATE items SET amount = amount - 500000 WHERE characterId = ? AND selfId = 57', [PAYER]]);
        await Database.execute(['UPDATE bot_life_state SET adena = 500000 WHERE characterId = ?', [PAYER]]);
        await Database.execute(['UPDATE items SET amount = amount + 300000 WHERE characterId = ? AND selfId = 57', [PAYER]]);
        assert.strictEqual((await settle(PAYER, { timestamp: 13 })).dues, 0, 'the hour of the purchase: nothing earned above the mark');
        await Database.execute(['UPDATE items SET amount = amount + 400000 WHERE characterId = ? AND selfId = 57', [PAYER]]);
        assert.strictEqual((await settle(PAYER, { timestamp: 14 })).dues, 80000, '20% of the 400k earned since the last settlement, the old peak forgotten');

        // The hourly pass (ClanHall/Runtime) settles every member once and then
        // refreshes the stored level goal from the ledger (K11).
        await GoalService.resolveClan(await GoalService.clanProjectionById(created.clanId));
        await Database.execute(['UPDATE items SET amount = amount + 1000000 WHERE characterId = ? AND selfId = 57', [PAYER]]);
        await Runtime.tick();
        const [ledger] = await Database.execute(['SELECT COALESCE(SUM(amount), 0) AS n FROM clan_contributions WHERE clanId = ? AND targetLevel = 1', [created.clanId]]);
        const goal = JSON.parse((await Database.execute(['SELECT stateJson FROM clan_simulation_clans WHERE clanId = ?', [created.clanId]]))[0].stateJson).goal;
        assert(Number(ledger.n) > first.investment + 40000, 'the pass collected the new earnings');
        assert.strictEqual(goal.progress, Number(ledger.n), 'the stored goal shows the ledger after the pass');
        const before = Number(ledger.n);
        await Database.execute(['UPDATE items SET amount = amount + 1000000 WHERE characterId = ? AND selfId = 57', [PAYER]]);
        await Runtime.tick();
        const [after] = await Database.execute(['SELECT COALESCE(SUM(amount), 0) AS n FROM clan_contributions WHERE clanId = ? AND targetLevel = 1', [created.clanId]]);
        assert.strictEqual(Number(after.n), before, 'one pass per clan and hour');
        console.log('Clan dues checks passed');
    } finally {
        await Database.close();
    }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
