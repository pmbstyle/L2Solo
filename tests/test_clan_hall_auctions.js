const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
require('../src/Global');
const Database = invoke('Database');
const Policy = require('../src/GameServer/ClanHall/Policy');
const Runtime = require('../src/GameServer/ClanHall/Runtime');
const dir = fs.mkdtempSync(path.resolve('tmp/clan-hall-test-'));
const file = path.join(dir, 'world.sqlite');
const start = 1800000000000;
async function main() {
    const seed = new DatabaseSync(file);
    seed.exec(fs.readFileSync('database/sql/sqlite.sql', 'utf8'));
    seed.prepare('INSERT INTO accounts(username,password) VALUES (?,?)').run('bot_pop_hall', 'test');
    for (let id = 1; id <= 5; id++) {
        seed.prepare(
            `INSERT INTO characters(id,username,name,classId,race,level,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ,clanId,clanPrivileges)
            VALUES (?,'bot_pop_hall',?,11,0,40,500,250,0,0,0,0,0,0,0,?,2047)`
        ).run(id, `HallMember${id}`, id);
        seed.prepare('INSERT INTO clans(id,name,level,leaderId) VALUES (?,?,?,?)').run(
            id,
            `HallClan${id}`,
            id === 4 ? 1 : 2,
            id
        );
        if (id === 3) {
            seed.prepare(
                `INSERT INTO clan_simulation_clans(clanId,mode,stateJson,createdAt,updatedAt) VALUES (3,'autonomous',?,0,0)`
            ).run(
                JSON.stringify({
                    mode: 'autonomous',
                    // A planned 2.5M progression purchase is the protected money below.
                    goal: { type: 'level', status: 'executing', target: { level: 3 }, plan: { maxPrice: 2500000 } },
                    warehouseRevision: 0
                })
            );
            seed.prepare(
                `INSERT INTO bot_life_state(characterId,accountName,characterName,level,adena,activity,phase,inventorySummary,statsJson,updatedAt)
                VALUES (3,'bot_pop_hall','HallMember3',40,1000000,'hunting','cold',?, '{}',0)`
            ).run(JSON.stringify({ 57: { selfId: 57, name: 'Adena', amount: 1000000 } }));
            seed.prepare(
                "INSERT INTO items(selfId,name,amount,enchant,equipped,slot,characterId) VALUES (57,'Adena',1000000,0,0,0,3)"
            ).run();
        }
        seed.prepare(
            `INSERT INTO clan_warehouse_items(clanId,selfId,name,kind,amount,enchant,createdAt,updatedAt) VALUES (?,57,'Adena','Other.Currency',100000000,0,0,0)`
        ).run(id);
    }
    // Existing installations have weekly rounds without a duration marker.
    seed.exec(`CREATE TABLE clan_halls (id INTEGER PRIMARY KEY, ownerId INTEGER NOT NULL DEFAULT 0,
        round INTEGER NOT NULL DEFAULT 1, auctionEndsAt INTEGER NOT NULL, rentDueAt INTEGER NOT NULL DEFAULT 0,
        serviceDueAt INTEGER NOT NULL DEFAULT 0, functionsJson TEXT NOT NULL DEFAULT '{}')`);
    seed.prepare('INSERT INTO clan_halls(id,auctionEndsAt) VALUES (?,?)').run(31, start + Policy.WEEK);
    seed.close();
    options.default.Database.path = file;
    Database.init();
    const exec = (sql, params = []) => Database.execute([sql, params]);
    try {
        assert.equal(Policy.catalog.halls.length, 27);
        assert.equal(new Set(Policy.catalog.halls.flatMap((h) => h.managerIds)).size, 27);
        assert.equal(
            Policy.bidAmount(8000000, () => 0),
            8400000
        );
        assert.equal(
            Policy.bidAmount(8000000, () => 1),
            9200000
        );
        const rows = await Database.initClanHalls(start);
        assert.equal(rows.length, 27);
        assert(rows.every((h) => h.auctionEndsAt === start + Policy.DAY), 'old and new rounds last 24 hours');
        const place = (clanId, hallId, amount, timestamp = start) =>
            Database.placeClanHallBid({ clanId, actorId: clanId, hallId, amount, timestamp });
        assert.equal((await place(4, 31, 9000000)).code, 'clan_ineligible');
        assert.equal(
            (await Database.placeClanHallBid({ clanId: 1, actorId: 2, hallId: 31, amount: 9000000, timestamp: start }))
                .code,
            'not_leader'
        );
        assert((await place(1, 31, 9000000)).ok);
        assert.equal((await place(1, 32, 9000000)).code, 'already_bidding');
        assert.equal((await place(1, 31, 9000000)).code, 'invalid_bid');
        assert((await place(1, 31, 9500000, start + 1)).ok);
        assert((await place(2, 31, 9500000, start + 2)).ok);
        const hidden = (await Database.fetchClanHallAuctions(5)).find((h) => h.id === 31);
        assert.equal(hidden.ownBid, 0);
        assert(!('highestBid' in hidden));
        const bidBeforeRestart = (await Database.fetchClanHallFinance(1)).bid;
        await Database.close();
        Database.init();
        const beforeDeadline = await Database.initClanHalls(start + 3600000);
        assert(beforeDeadline.every((h) => h.auctionEndsAt === start + Policy.DAY), 'restart never pushes back a deadline');
        assert.deepEqual((await Database.fetchClanHallFinance(1)).bid, bidBeforeRestart, 'restart preserves bids');
        await Database.close();
        Database.init();
        Runtime.applyRows(await Database.initClanHalls(start + Policy.WEEK));
        assert.equal(Runtime.owned(1).id, 31, 'earliest equal bid wins');
        assert.equal(Runtime.owned(1).rentDueAt, start + 2 * Policy.WEEK, 'late startup charges one rent from the actual award');
        const reopened = Runtime.all().filter((h) => !h.ownerId);
        assert(reopened.every((h) => h.round === 2 && h.auctionEndsAt === start + Policy.WEEK + Policy.DAY),
            'downtime settles once and opens the next round for 24 hours from startup');
        assert.equal((await Database.fetchClanHallFinance(2)).available, 100000000, 'loser gets a full refund');
        assert.equal((await Database.fetchClanHallFinance(1)).available, 90300000, 'winner pays bid plus first rent');
        await Database.tickClanHalls(start + Policy.WEEK);
        assert.equal((await exec("SELECT COUNT(*) AS n FROM clan_hall_events WHERE kind='hall_won'"))[0].n, 1,
            'startup/tick retries must not award twice');
        assert.equal(
            (await Database.fetchClanHallFinance(1)).available,
            90300000,
            'settlement retry cannot double charge'
        );
        assert.equal((await place(1, 32, 9000000, start + Policy.WEEK)).code, 'already_owns_hall');
        assert.equal((await Database.dissolveClan({ clanId: 1, leaderId: 1 })).code, 'clan_hall_owned_or_bid');
        assert((await place(2, 32, 9000000, start + Policy.WEEK)).ok);
        assert((await Database.cancelClanHallBid({ clanId: 2, actorId: 2, timestamp: start + Policy.WEEK })).ok);
        assert.equal((await Database.fetchClanHallFinance(2)).available, 99100000);
        assert.equal(
            (await Database.cancelClanHallBid({ clanId: 2, actorId: 2, timestamp: start + Policy.WEEK })).code,
            'no_bid'
        );
        assert.equal(
            (
                await Database.configureClanHall({
                    clanId: 1,
                    actorId: 2,
                    kind: 'hp',
                    level: 100,
                    timestamp: start + Policy.WEEK
                })
            ).code,
            'not_authorized'
        );
        assert(
            (
                await Database.configureClanHall({
                    clanId: 1,
                    actorId: 1,
                    kind: 'hp',
                    level: 100,
                    timestamp: start + Policy.WEEK
                })
            ).ok
        );
        assert.equal(
            (
                await Database.configureClanHall({
                    clanId: 1,
                    actorId: 1,
                    kind: 'hp',
                    level: 999,
                    timestamp: start + Policy.WEEK
                })
            ).code,
            'invalid_function'
        );
        Runtime.applyRows(await Database.fetchClanHallAuctions());
        const actor = {
            fetchClanId: () => 1,
            fetchLocX: () => Runtime.owned(1).spawn.locX,
            fetchLocY: () => Runtime.owned(1).spawn.locY,
            fetchLocZ: () => Runtime.owned(1).spawn.locZ
        };
        assert.equal(Runtime.regen(actor, 'hp'), 2);
        assert.equal(Runtime.regen({ ...actor, fetchClanId: () => 2 }, 'hp'), 1);
        await exec('DELETE FROM clan_warehouse_items WHERE clanId=1');
        await Database.tickClanHalls(start + 2 * Policy.WEEK);
        assert((await Database.fetchClanHallFinance(1)).hall, 'unpaid rent has one week of grace');
        await Database.tickClanHalls(start + 3 * Policy.WEEK);
        assert.equal((await Database.fetchClanHallFinance(1)).hall, null);
        assert.equal((await Database.fetchClanHallAuctions()).find((h) => h.id === 31).auctionEndsAt,
            start + 3 * Policy.WEEK + Policy.DAY, 'repossessed halls return to a daily auction');
        // Financial planning must never replace the level goal or touch its reserve.
        await exec('UPDATE clan_warehouse_items SET amount=2500000 WHERE clanId=3');
        const plan = await Database.planClanHallFinance(3, start + 3 * Policy.WEEK, () => 0.4);
        assert.equal(plan.goal.status, 'saving');
        assert.equal(plan.goal.progress, 0);
        const again = await Database.planClanHallFinance(3, start + 3 * Policy.WEEK + 1, () => 0.99);
        assert.equal(again.goal.bid, plan.goal.bid, 'bid jitter persists for a round');
        const initialGoal = (await exec('SELECT stateJson FROM clan_simulation_clans WHERE clanId=3'))[0].stateJson;
        assert.equal(JSON.parse(initialGoal).goal.target.level, 3);
        assert.equal(
            (await Database.contributeClanHall({ clanId: 3, characterId: 3, timestamp: start })).amount,
            0,
            'existing wallet is not repeatedly taxed'
        );
        await exec('UPDATE items SET amount=amount+100000 WHERE characterId=3 AND selfId=57');
        assert.equal(
            (await Database.contributeClanHall({ clanId: 3, characterId: 3, timestamp: start + 1 })).amount,
            15000
        );
        assert.equal(
            (await Database.contributeClanHall({ clanId: 3, characterId: 3, timestamp: start + 2 })).amount,
            0,
            'same earnings cannot be collected twice'
        );
        assert.equal((await Database.fetchClanHallFinance(3)).available, 2515000);
        assert.equal(
            JSON.parse((await exec('SELECT stateJson FROM clan_simulation_clans WHERE clanId=3'))[0].stateJson).goal
                .target.level,
            3
        );
        // Only the hall contribution ledger changes, never the level contribution total.
        assert.equal(Number((await exec('SELECT COUNT(*) AS n FROM clan_contributions WHERE clanId=3'))[0].n), 0);
        // A worker-owned balance may exceed the physical inventory. Active leases
        // are untouched; an unleased debit must fence old worker proposals.
        await exec(
            `UPDATE bot_life_state SET simulationOwner='cold_simulation_owner', simulationLeaseUntil=?,
            adena=1200000,inventorySummary=? WHERE characterId=3`,
            [start + 1000, JSON.stringify({ 57: { selfId: 57, name: 'Adena', amount: 1200000 } })]
        );
        assert.equal(
            (await Database.contributeClanHall({ clanId: 3, characterId: 3, timestamp: start + 3 })).code,
            'member_busy'
        );
        const revision = Number(
            (await exec('SELECT simulationRevision FROM bot_life_state WHERE characterId=3'))[0].simulationRevision
        );
        const workerContribution = await Database.contributeClanHall({
            clanId: 3,
            characterId: 3,
            timestamp: start + 1001
        });
        assert.equal(workerContribution.amount, 17250);
        assert.equal(workerContribution.row.simulationRevision, revision + 1);
        assert.equal(workerContribution.row.adena, 1182750);
        assert.equal(workerContribution.row.simulationOwner, 'cold_simulation_owner');
        assert.equal(
            Number((await exec('SELECT SUM(amount) AS n FROM items WHERE characterId=3 AND selfId=57'))[0].n),
            1182750
        );
        assert.equal(
            (await Database.contributeClanHall({ clanId: 3, characterId: 3, timestamp: start + 1002 })).amount,
            0
        );
        // Manual bids cannot spend the protected progression money either.
        await exec('UPDATE clan_warehouse_items SET amount=10000000 WHERE clanId=3');
        assert.equal((await place(3, 31, 9000000, start + 3 * Policy.WEEK + 1)).code, 'budget_reserved');
        // Exact funding includes the activation charge, so a saved upgrade
        // cannot get stuck one daily payment short of execution.
        await exec('UPDATE clan_halls SET ownerId=3,auctionEndsAt=0,rentDueAt=?,serviceDueAt=? WHERE id=33', [
            start + 4 * Policy.WEEK,
            start + 3 * Policy.WEEK + Policy.DAY
        ]);
        await exec('UPDATE clan_warehouse_items SET amount=2500000 WHERE clanId=3');
        const upgradePlan = await Database.planClanHallFinance(3, start + 3 * Policy.WEEK + 3, () => 0);
        await exec('UPDATE clan_warehouse_items SET amount=? WHERE clanId=3', [2500000 + upgradePlan.goal.target]);
        await Database.planClanHallFinance(3, start + 3 * Policy.WEEK + 4, () => 0);
        const purchased = await Database.fetchClanHallFinance(3);
        assert(JSON.parse(purchased.hall.functionsJson).support > 0, 'support is the first useful upgrade');
        assert(purchased.available >= 2500000, 'upgrades preserve progression funding');
        const before = (await Database.fetchClanHallFinance(3)).goal;
        await Database.close();
        Database.init();
        await Database.initClanHalls(start + 3 * Policy.WEEK + 2);
        assert.deepEqual((await Database.fetchClanHallFinance(3)).goal, before, 'restart keeps the chosen bid');
        const scheduledStart = start + 3 * Policy.WEEK + 10000;
        await exec('INSERT INTO clan_hall_startup_schedule(id,delayMs,requestedAt) VALUES (1,300000,?)', [start]);
        const bidsBeforeSchedule = await exec('SELECT * FROM clan_hall_bids ORDER BY clanId');
        const ownedBeforeSchedule = (await Database.fetchClanHallAuctions()).filter(h => h.ownerId);
        await Database.close();
        Database.init();
        const scheduled = await Database.initClanHalls(scheduledStart);
        assert(scheduled.filter(h => !h.ownerId).every(h => h.auctionEndsAt === scheduledStart + 300000),
            'one-time test schedule starts five minutes after startup, not after the request');
        assert.deepEqual(await exec('SELECT * FROM clan_hall_bids ORDER BY clanId'), bidsBeforeSchedule);
        assert.equal((await exec('SELECT * FROM clan_hall_startup_schedule')).length, 0);
        assert.deepEqual((await Database.fetchClanHallAuctions()).filter(h => h.ownerId), ownedBeforeSchedule,
            'scheduling an auction leaves existing ownership and payments unchanged');
        const restarted = await Database.initClanHalls(scheduledStart + 60000);
        assert(restarted.filter(h => !h.ownerId).every(h => h.auctionEndsAt === scheduledStart + 300000),
            'restarting must not restart the five-minute countdown');
        const settledDaily = await Database.tickClanHalls(scheduledStart + 300000);
        assert(settledDaily.filter(h => !h.ownerId).every(h => h.auctionEndsAt === scheduledStart + 300000 + Policy.DAY),
            'ordinary 24-hour rounds resume after the one-time short auction');
        console.log('Clan hall auction, rent, ownership, permissions, contribution and restart checks passed');
    } finally {
        Runtime.stop();
        await Database.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
