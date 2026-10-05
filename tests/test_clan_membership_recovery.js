const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
require('../src/Global');
const Cache = invoke('GameServer/DataCache');
Cache.init();
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Policy = invoke('GameServer/Clan/ClanMembershipPolicy');
const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const root = path.resolve(__dirname, '..');
const dbPath = path.join(root, 'tmp/test-clan-membership-recovery.sqlite');
const ids = Array.from({ length: 8 }, (_, index) => 4920001 + index);
const clanId = 790001;
const personalPlan = { strategy: 'craft', status: 'active', recipeId: 2, target: { selfId: 3, name: 'Broadsword', slot: 7 } };
const clanPlan = { ...personalPlan, clanGoal: { clanId, goalKey: 'clan-test', beneficiaryId: ids[2] } };
const inventory = { 1864: { selfId: 1864, name: 'Stem', amount: 20, stackable: true } };
const query = (sql, args = []) => Database.execute([sql, args]);
const cleanup = () => [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].forEach(file => fs.rmSync(file, { force: true }));
const lifeRow = async id => (await query('SELECT * FROM bot_life_state WHERE characterId = ?', [id]))[0];
const partyRow = async id => (await query('SELECT * FROM bot_background_parties WHERE partyId = ?', [id]))[0];

async function main() {
    cleanup();
    const seed = new DatabaseSync(dbPath);
    seed.exec(fs.readFileSync(path.join(root, 'database/sql/sqlite.sql'), 'utf8'));
    seed.prepare("INSERT INTO accounts(username,password) VALUES ('bot_membership_test','test')").run();
    seed.prepare("INSERT INTO clans(id,name,leaderId) VALUES (?,'RecoveryClan',?)").run(clanId, ids[0]);
    for (const [index, id] of ids.entries()) {
        seed.prepare(`INSERT INTO characters(id,username,name,clanId,classId,race,level,maxHp,maxMp,
            sex,face,hair,hairColor,locX,locY,locZ) VALUES (?,'bot_membership_test',?,?,4,0,20,500,250,0,0,0,0,100,100,0)`)
            .run(id, `Membership${index}`, index < 3 ? clanId : 0);
        seed.prepare(`INSERT INTO bot_life_state(characterId,accountName,characterName,level,activity,phase,partyId,
            locX,locY,locZ,hp,mp,maxHp,maxMp,inventorySummary,statsJson,updatedAt)
            VALUES (?,'bot_membership_test',?,20,'hunting','cold',?,100,100,0,321,123,500,250,?,?,1)`)
            .run(id, `Membership${index}`, index < 2 ? 'old-personal' : index === 2 ? 'clan-production' : null,
                JSON.stringify(inventory), JSON.stringify({ classId: 4, generatedCold: true,
                    clanId: index === 1 || index === 2 ? clanId : 0,
                    equipmentPlan: index === 2 ? clanPlan : personalPlan }));
    }
    for (const [partyId, leaderId, memberIds, objective] of [
        ['old-personal', ids[0], ids.slice(0, 2), { strategy: 'craft', targetSelfId: 3 }],
        ['clan-production', ids[2], [ids[2]], { strategy: 'craft', clanId, clanGoalKey: 'clan-test' }],
        ['solo-production', ids[3], [ids[3]], { strategy: 'craft', targetSelfId: 3 }]
    ]) {
        seed.prepare(`INSERT INTO bot_background_parties(partyId,leaderId,memberIdsJson,statsJson) VALUES (?,?,?,?)`)
            .run(partyId, leaderId, JSON.stringify(memberIds), JSON.stringify({ objective, acquisitionGoal: objective }));
    }
    seed.close();
    options.default.Database.path = path.relative(root, dbPath);
    Database.init();
    try {
        assert(await Life.init(), 'startup recovery must succeed');
        for (const id of ids.slice(0, 2)) {
            const row = await lifeRow(id);
            const state = Life.cachedState(id);
            assert.equal(JSON.parse(row.statsJson).clanId, clanId, 'authoritative membership repairs durable state');
            assert.equal(state.stats.clanId, clanId, 'cache receives corrected membership');
            assert(!state.stats.equipmentPlan, 'old grouped personal crafting is removed');
            assert.equal(row.partyId, 'old-personal', 'recovery does not disband the party');
            assert.deepEqual(JSON.parse(row.inventorySummary), inventory);
            assert.equal(row.hp, 321);
            assert.equal(row.mp, 123);
            assert.equal(Disposition.saleCandidates(state).length, 0, 'resources cannot leak into personal sales');
        }
        assert.equal(JSON.parse((await partyRow('old-personal')).statsJson).objective, null);
        assert.equal(JSON.parse((await partyRow('clan-production')).statsJson).objective.clanGoalKey, 'clan-test');
        assert.equal(JSON.parse((await partyRow('solo-production')).statsJson).objective.strategy, 'craft');
        assert.deepEqual(Life.cachedState(ids[2]).stats.equipmentPlan, clanPlan, 'valid clan manufacturing remains');
        assert.equal(Life.cachedState(ids[3]).stats.equipmentPlan.strategy, 'craft', 'unaffiliated bots retain personal crafting');
        const beforeRepeat = await lifeRow(ids[0]);
        assert.deepEqual(await Database.reconcileBotClanMembership(), { repairedMembers: 0, repairedParties: 0 });
        assert.deepEqual(await lifeRow(ids[0]), beforeRepeat, 'repeated recovery is a no-op');

        const staleParty = await Parties.createOrUpdate({ partyId: 'old-personal', leaderId: ids[0], memberIds: ids.slice(0, 2),
            stats: { objective: { strategy: 'craft', targetSelfId: 3 }, acquisitionGoal: personalPlan } });
        assert.equal(staleParty.stats.objective, null, 'stale party persistence cannot restore personal crafting');
        assert.equal(staleParty.stats.acquisitionGoal, null);
        const refreshed = await Life.upsertState({ ...Life.cachedState(ids[0]), stats: {
            ...Life.cachedState(ids[0]).stats, equipmentPlan: personalPlan } });
        assert(!refreshed.stats.equipmentPlan);
        assert(!JSON.parse((await lifeRow(ids[0])).statsJson).equipmentPlan);

        // Every founder is updated, including a bot currently owned by a worker.
        const founders = ids.slice(4, 7);
        const staleFounder = Life.cachedState(founders[0]);
        await query("UPDATE bot_life_state SET simulationOwner = 'cold_simulation_owner' WHERE characterId = ?", [founders[1]]);
        const created = await Database.createAutonomousClan({ name: 'NewRecoveryClan', leaderId: founders[0], memberIds: founders,
            founderQuorum: 3, maxBotClans: 40, maxBotMemberShare: 1 });
        assert(created.ok, JSON.stringify(created));
        for (const id of founders) {
            assert.equal(JSON.parse((await lifeRow(id)).statsJson).clanId, created.clanId);
            assert.equal(Life.cachedState(id).stats.clanId, created.clanId);
            assert(!Life.cachedState(id).stats.equipmentPlan);
        }
        assert.equal((await lifeRow(founders[1])).simulationOwner, 'cold_simulation_owner');
        assert.equal(await Life.upsertState(staleFounder), null, 'pre-membership lifecycle snapshot is fenced');
        assert.equal(JSON.parse((await lifeRow(founders[0])).statsJson).clanId, created.clanId);

        const joined = await Database.joinAutonomousClan({ clanId: created.clanId, characterId: ids[7], maxBotMemberShare: 1 });
        assert(joined.ok, JSON.stringify(joined));
        assert.equal(Life.cachedState(ids[7]).stats.clanId, created.clanId);
        assert(!Life.cachedState(ids[7]).stats.equipmentPlan);

        const hotActor = { effects: {}, fetchId: () => ids[7], fetchName: () => 'Membership7', fetchLevel: () => 20,
            fetchClanId: () => 0, fetchClassId: () => 4, fetchExp: () => 0, fetchSp: () => 0,
            fetchLocX: () => 100, fetchLocY: () => 100, fetchLocZ: () => 0,
            fetchHp: () => 321, fetchMaxHp: () => 500, fetchMp: () => 123, fetchMaxMp: () => 250 };
        const session = { actor: hotActor, accountId: 'bot_membership_test', plan: 'hunting', coldLifeState: Life.cachedState(ids[7]) };
        hotActor.session = session;
        const cooled = await Life.markCold(session, 'membership_handoff');
        assert.equal(cooled.stats.clanId, created.clanId, 'a delayed hot actor update cannot erase committed membership on cooldown');
        assert(cooled.stats.clanMembershipVersion > 0);

        // A membership change invalidates work already running on the old revision.
        await Life.upsertState({ ...Life.cachedState(ids[3]), stats: { generatedCold: true, clanId: 0 } });
        const timestamp = Date.now();
        const claimed = await Database.claimColdSimulationLease({ characterId: ids[3], expectedRevision: Number((await lifeRow(ids[3])).simulationRevision),
            leaseId: 'membership-race', timestamp, leaseUntil: timestamp + 60000 });
        assert(claimed.ok, JSON.stringify(claimed));
        await Database.updateCharacterClan(ids[3], clanId, 0, 0, 0);
        const staleCommit = await Database.commitColdSimulationLease({ characterId: ids[3], expectedRevision: claimed.revision,
            leaseId: 'membership-race', timestamp: timestamp + 1, leaseUntil: timestamp + 60000,
            patch: { statsJson: JSON.stringify({ clanId: 0 }) } });
        assert(!staleCommit.ok, 'running worker cannot erase a newer membership');
        assert.equal(Life.cachedState(ids[3]).stats.clanId, clanId);
        const directPlan = { ...personalPlan, strategy: 'direct_drop' };
        const merged = await Database.commitColdSimulationLease({ characterId: ids[3],
            expectedRevision: Number((await lifeRow(ids[3])).simulationRevision),
            leaseId: 'membership-race', timestamp: timestamp + 2, leaseUntil: timestamp + 60000,
            patch: { statsJson: JSON.stringify({ clanId: 0, equipmentPlan: directPlan }) } });
        assert(merged.ok, JSON.stringify(merged));
        assert.equal(JSON.parse(merged.row.statsJson).clanId, clanId);
        assert.deepEqual(JSON.parse(merged.row.statsJson).equipmentPlan, directPlan, 'membership metadata merge preserves ordinary drop plans');
        const sanitized = await Database.commitColdSimulationLease({ characterId: ids[3], expectedRevision: merged.revision,
            leaseId: 'membership-race', timestamp: timestamp + 3, leaseUntil: timestamp + 60000,
            patch: { statsJson: JSON.stringify({ ...JSON.parse(merged.row.statsJson), equipmentPlan: personalPlan }) } });
        assert(sanitized.ok, JSON.stringify(sanitized));
        assert(!JSON.parse(sanitized.row.statsJson).equipmentPlan, 'current worker writes also discard personal clan crafting');
        await Database.removeCharacterFromClan(ids[3], 0);
        assert.equal(Life.cachedState(ids[3]).stats.clanId, 0);
        const dissolved = await Database.dissolveClan({ clanId: created.clanId, leaderId: founders[0] });
        assert(dissolved.ok, JSON.stringify(dissolved));
        for (const id of [...founders, ids[7]]) assert.equal(Life.cachedState(id).stats.clanId, 0);

        // Leaving a clan cancels its work, but keeps unrelated travel and craft shops.
        const left = Policy.reconcileState({ activity: 'traveling', stats: { clanId, equipmentPlan: clanPlan,
            clanPartyObjective: { clanId }, partyRequest: { clanId, clanGoalKey: 'clan-test' },
            travel: { reason: 'equipment_craft' }, craftReturn: {} } }, 0);
        assert.equal(left.activity, 'hunting');
        assert(!left.stats.travel && !left.stats.craftReturn && !left.stats.equipmentPlan && !left.stats.clanPartyObjective && !left.stats.partyRequest);
        const shop = Policy.reconcileState({ activity: 'crafting', stats: { clanId, craftShop: { active: true }, equipmentPlan: personalPlan } });
        assert.equal(shop.activity, 'crafting');
        assert(shop.stats.craftShop);
        console.log('Clan membership recovery: startup, parties, resource retention, atomic membership and stale worker/lifecycle fencing passed');
    } finally { await Database.close(); cleanup(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
