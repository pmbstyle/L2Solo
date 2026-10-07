'use strict';
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = 'config/default.ini';
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Valuation = invoke('GameServer/Bot/Economy/EconomicValuation');
const Context = invoke('GameServer/Clan/ClanEconomyContext');
const Decisions = invoke('GameServer/Bot/Population/ColdSimulationCoordinator').economyDecisions;
const Hall = require('../src/GameServer/ClanHall/Policy');
const Runtime = require('../src/GameServer/ClanHall/Runtime');
const Repository = require('../src/GameServer/ClanHall/Repository');
const Events = require('../src/GameServer/Clan/ClanReviewEvents');
const timestamp = 1800000000000, ids = [719500, 719501, 719502];
const persona = { traits: { ambition: 0.8, empathy: 0.8, commitment: 0.5, sociability: 0.7 } };
async function run() {
    const world = await createWorld(ids.map(id => ({ id, level: 40, classId: 1 })), 'clan-finance-decided');
    let sync, otherConnection;
    const restores = [];
    const stub = (object, key, value) => { const before = object[key]; object[key] = value; restores.push(() => { object[key] = before; }); };
    try {
        const members = ids.map((id, index) => ({ characterId: id, level: 40, classId: 1, phase: index === 2 ? 'hot' : 'cold',
            updatedAt: 100 + index, stats: { classId: 1, clanId: 77, ...(index === 0 ? { equipmentPlan: {
                status: 'active', strategy: 'market', target: { selfId: 391 }, market: { price: 10000 } } } : {}) },
            inventory: {}, persona, currentRegion: 'Giran' }));
        const originalBasics = Economy.basics, originalHorizon = Valuation.stageHours;
        let basicsCalls = 0;
        stub(Economy, 'forState', () => { throw Error('clan review cannot build a member wish network'); });
        stub(Economy, 'basics', member => { basicsCalls++; return { persona: member.persona,
            hunt: { perHour: 45000, expPerHour: 1000 }, deathHours: 1 }; });
        stub(Valuation, 'stageHours', () => 35);
        stub(Decisions, 'clanNumbers', id => id === ids[0] ? { horizonHours: 40, huntPerHour: 60000,
            plan: { itemId: 391, valueHours: 6 }, updatedAt: 100 } : id === ids[1]
            ? { horizonHours: 20, huntPerHour: 0, plan: null, updatedAt: 101 } : null);
        const clan = { id: 77, level: 0, leaderId: ids[0], state: {}, members };
        const inputs = { warehouse: [{ selfId: 57, amount: 300000, reservedAmount: 0 }], halls: [] };
        const result = Context.forClan(clan, inputs);
        assert.equal(basicsCalls, 3, 'one network-free basics call per member');
        const equipmentWish = result.network.queue.find(row => row.key === `clan-item:${ids[0]}:391`);
        assert.ok(equipmentWish.valueHours > 0);
        assert.equal(result.incomePerHour, 105000 * invoke('GameServer/Clan/ClanContributionPolicy').duesRate(members.map(() => persona.traits)));
        const oracle = Context.build(clan, { ...inputs, equipment: [{ memberId: ids[0], plan: members[0].stats.equipmentPlan }],
            memberContexts: members.map((member, index) => ({ persona, clanHorizon: [40, 20, 35][index],
                hunt: { perHour: [60000, 0, 45000][index] }, inputKey: `${member.characterId}:${100 + index}`,
                clanItemUsefulness: id => index === 0 && id === 391 ? 6 : 0 })) });
        assert.deepEqual(result.network.queue, oracle.network.queue);
        assert.deepEqual(result.network.focus, oracle.network.focus);
        Economy.basics = originalBasics; Valuation.stageHours = originalHorizon;

        await Database.initClanHalls(timestamp);
        await Database.execute(["INSERT INTO clans(id,name,level,leaderId) VALUES(77,'DecidedFinance',2,?)", [ids[0]]]);
        await Database.execute(["INSERT INTO clan_simulation_clans(clanId,mode,stateJson,createdAt,updatedAt) VALUES(77,'autonomous','{}',1,1)"]);
        await Database.execute(['UPDATE characters SET clanId=77 WHERE id IN (?,?,?)', ids]);
        await Database.execute(["INSERT INTO clan_warehouse_items(clanId,selfId,name,kind,amount,reservedAmount) VALUES(77,57,'Adena','Other.Currency',100000000,0)"]);
        for (const member of members) await Database.execute([`INSERT INTO bot_life_state(characterId,accountName,characterName,level,phase,activity,statsJson,inventorySummary,updatedAt)
            VALUES(?,'quests',?,40,?,'hunting',?,'{}',?)`, [member.characterId, `Finance${member.characterId}`, member.phase, JSON.stringify(member.stats), member.updatedAt]]);
        sync = new DatabaseSync(options.default.Database.path);
        let inside = false, mutate = null, lifecycleReads = 0, decisions = 0;
        const writeTimes = [];
        const one = (sql, parameters = []) => {
            if (inside) assert.ok(sql === 'SELECT total_changes() AS epoch' || sql === 'PRAGMA data_version', `unexpected read in tx: ${sql}`);
            return sync.prepare(sql).get(...parameters);
        };
        const all = (sql, parameters = []) => {
            assert.equal(inside, false, `no row scan in tx: ${sql}`);
            if (sql.includes('bot_life_state')) lifecycleReads++;
            return sync.prepare(sql).all(...parameters);
        };
        const write = (sql, parameters = []) => { assert.equal(inside, true); return sync.prepare(sql).run(...parameters); };
        const inTransaction = work => Promise.resolve().then(() => {
            mutate?.(); mutate = null;
            sync.exec('BEGIN IMMEDIATE'); inside = true;
            const start = performance.now();
            try { const value = work(); writeTimes.push(performance.now() - start); sync.exec('COMMIT'); return value; }
            catch (error) { sync.exec('ROLLBACK'); throw error; } finally { inside = false; }
        });
        const repository = Repository({ one, all, write, withCharacterFlush: (_id, work) => work(), inTransaction,
            // The factory fixture owns native SQL, not the production queue.
            // Keep its deliberate mutation AFTER prepare and BEFORE BEGIN.
            inPreparedTransaction: prepare => Promise.resolve().then(() => {
                const prepared = prepare();
                return typeof prepared === 'function' ? inTransaction(prepared) : prepared;
            }),
            inPreparedTransactionBatch: async (candidates, prepare, { deadline, before, failed, committed }) => {
                const admitted = [...candidates], completed = [];
                for (const id of admitted) {
                    if (Date.now() >= deadline) break;
                    before?.(id);
                    try {
                        const prepared = prepare(id, Date.now());
                        const value = typeof prepared === 'function' ? await inTransaction(prepared) : prepared;
                        completed.push({ id, result: committed ? committed(id, value) : value });
                    } catch (error) { failed?.(id, error); throw error; }
                }
                return completed;
            } });
        stub(Life, 'cachedState', id => members.find(member => member.characterId === id));
        stub(Context, 'forClan', (projection, { halls }) => {
            assert.equal(inside, false); decisions++;
            assert.equal(projection.members.length, 3);
            assert.equal(projection.members[0].stats, members[0].stats, 'the cached state is used instead of stored statsJson');
            return { hall: halls.find(row => !row.ownerId), hallBid: hall => hall.minimumBid,
                budgetFor: () => Infinity, reserve: 0, network: { focus: [], dormant: [] }, moneyPrice: 1, incomePerHour: 1000 };
        });
        const first = await repository.planClanHallFinance(77, timestamp);
        assert.equal(first.ok, true); assert.equal(first.goal.status, 'bidding');
        assert.equal(lifecycleReads, 0, 'all cached members need no lifecycle SELECT');
        assert.ok(sync.prepare('SELECT * FROM clan_hall_bids WHERE clanId=77').get());
        const moneyAfterBid = sync.prepare('SELECT amount FROM clan_warehouse_items WHERE clanId=77').get().amount;
        mutate = () => sync.prepare('UPDATE clans SET level=3 WHERE id=77').run();
        const stale = await repository.planClanHallFinance(77, timestamp + 1);
        assert.deepEqual(stale, { ok: false, staleFinance: true });
        assert.equal(sync.prepare('SELECT amount FROM clan_warehouse_items WHERE clanId=77').get().amount, moneyAfterBid);
        assert.equal(JSON.parse(sync.prepare('SELECT stateJson FROM clan_hall_finances WHERE clanId=77').get().stateJson).updatedAt, timestamp);
        otherConnection = new DatabaseSync(options.default.Database.path);
        const localEpoch = sync.prepare('SELECT total_changes() AS epoch').get().epoch;
        mutate = () => otherConnection.prepare('UPDATE clan_warehouse_items SET amount=amount-1 WHERE clanId=77').run();
        assert.deepEqual(await repository.planClanHallFinance(77, timestamp + 1), { ok: false, staleFinance: true });
        assert.equal(sync.prepare('SELECT total_changes() AS epoch').get().epoch, localEpoch,
            'data_version catches another connection even when total_changes is unchanged');
        otherConnection.close(); otherConnection = null;
        const lot = sync.prepare('SELECT hallId FROM clan_hall_bids WHERE clanId=77').get().hallId;
        sync.prepare("UPDATE clan_halls SET ownerId=77,functionsJson='{}' WHERE id=?").run(lot);
        sync.prepare('DELETE FROM clan_hall_bids WHERE clanId=77').run();
        const upgrade = await repository.planClanHallFinance(77, timestamp + 2);
        assert.equal(upgrade.ok, true);
        assert.ok(Object.keys(JSON.parse(sync.prepare('SELECT functionsJson FROM clan_halls WHERE id=?').get(lot).functionsJson)).length);
        stub(Life, 'cachedState', id => id === ids[2] ? null : members.find(member => member.characterId === id));
        await repository.planClanHallFinance(77, timestamp + 3);
        assert.equal(lifecycleReads, 1, 'only uncached members are read before tx');
        for (let i = 0; i < 20; i++) await repository.planClanHallFinance(77, timestamp + 4 + i);
        const sorted = [...writeTimes].sort((a, b) => a - b), p95 = sorted[Math.ceil(sorted.length * .95) - 1];
        assert.ok(p95 <= 2, `native finance tx p95 ${p95.toFixed(3)}ms exceeds 2ms`);

        stub(Database, 'initClanHalls', async () => []);
        stub(Database, 'tickClanHalls', async () => []);
        stub(Database, 'fetchClanHallAuctions', async () => []);
        stub(Database, 'execute', async query => String(query[0]).includes('SELECT clanId FROM clan_simulation_clans') ? [{ clanId: 77 }] : []);
        stub(invoke('GameServer/Clan/ClanSimulationConfig'), 'enabled', true);
        stub(require('../src/GameServer/ClanHall/Doors'), 'start', () => null);
        let retries = 0;
        stub(Database, 'planClanHallFinance', async () => ({ ok: ++retries > 1, staleFinance: retries === 1 }));
        // Runtime now submits a bounded batch; retain the original single-clan
        // controlled outcomes and native dirty retry purpose of this facade.
        stub(Database, 'planClanHallFinanceBatch', async (candidates, { deadline, before, settled, failed }) => {
            const completed = [];
            for (const id of candidates) {
                if (Date.now() >= deadline) break;
                before?.(id);
                try {
                    const result = await Database.planClanHallFinance(id);
                    settled?.(id, result); completed.push({ id, result });
                } catch (error) { failed?.(id, error); throw error; }
            }
            return completed;
        });
        await Runtime.start();
        await Runtime.tick(); await Runtime.tick(); await Runtime.tick();
        assert.equal(retries, 2, 'stale finance is retried at next tick and removed after success');
        assert.equal(Runtime.financeSummary().samples, 3);
        assert.ok(Runtime.financeSummary().p95Ms >= 0);
        Runtime.stop();
        console.log(`test_clan_finance_decided: worker numbers/fallback parity; cached/missing states; native bid/upgrade; CAS retry; no row read/build in tx; tx p95=${p95.toFixed(3)}ms decisions=${decisions}`);
    } finally {
        Runtime.stop(); Events.stop();
        for (const restore of restores.reverse()) restore();
        otherConnection?.close(); sync?.close(); await world.close();
    }
}
run().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
