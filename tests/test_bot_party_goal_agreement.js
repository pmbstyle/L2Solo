'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'party-goal-agreement-'));
const previous = process.env.L2NODE_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = path.join(directory, 'test.ini');
fs.writeFileSync(process.env.L2NODE_CONFIG_FILE, `[Database]\npath=${directory}/world.sqlite\nhistoryPath=${directory}/history.sqlite\n`);
require('../src/Global');
const DB = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Agreement = require('../src/GameServer/Bot/Population/PartyAgreement');
const Goals = require('../src/GameServer/Bot/Population/PartyGoalPolicy');
const Composition = invoke('GameServer/Bot/Population/BackgroundPartyComposition');
const held = (items, id) => items.filter(item => Number(item.selfId) === id).reduce((sum, item) => sum + Number(item.amount), 0);
let serial = 0;
async function seed() {
    const username = `bot_party_goal_${++serial}`;
    await DB.createAccount(username, 'test');
    const id = Number((await DB.createCharacter(username, { name: `PartyGoal${serial}`, classId: 0,
        race: 0, sex: 0, face: 0, hair: 0, hairColor: 0, maxHp: 100, maxMp: 100,
        locX: 0, locY: 0, locZ: 0 })).insertId);
    await DB.execute(['UPDATE characters SET level=10,hp=100,mp=100 WHERE id=?', [id]]);
    await DB.setItem(id, { selfId: 57, name: 'Adena', amount: 10000, equipped: false, slot: 0, enchant: 0 });
    return Life.upsertState({ characterId: id, accountName: username, name: `PartyGoal${serial}`,
        level: 10, phase: 'cold', activity: 'hunting', loc: { locX: 0, locY: 0, locZ: 0 },
        spotId: 'test-party-goal', vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, adena: 10000,
        inventory: Life.inventorySummaryFromItems(await DB.fetchItems(id)),
        stats: { classId: 0, generatedCold: true }, timing: {} }, 'party_goal_seed');
}
async function images(ids) {
    return { items: await DB.execute([`SELECT * FROM items WHERE characterId IN (${ids.map(() => '?').join(',')}) ORDER BY id`, ids]),
        lives: await DB.execute([`SELECT * FROM bot_life_state WHERE characterId IN (${ids.map(() => '?').join(',')}) ORDER BY characterId`, ids]),
        parties: await DB.execute(['SELECT * FROM bot_background_parties ORDER BY partyId', []]) };
}
async function fund(states, suffix) {
    const objective = { spotId: 'test-party-goal', itemId: 1869, priority: 'required',
        helpDeal: { payerId: states[0].characterId, itemId: 1869, count: 2, fee: 1001 } };
    const party = Parties.prepareCommit({ partyId: `help-${suffix}`, leaderId: states[0].characterId,
        memberIds: states.map(state => state.characterId), spotId: objective.spotId, startedAt: Date.now(),
        nextResolveAt: Date.now() + 60000, status: 'active', stats: { objective,
            agreement: Agreement.propose(states[0], states, objective, { rng: () => 0.99 }) } });
    const members = states.map(state => Life.preparePartyAssignment(state, party.row.partyId, 'dps', states[0].characterId));
    const result = await DB.commitBackgroundPartyMembership({ party: party.row, members });
    if (result.ok) { result.lifeRows.forEach(row => Life.acceptNewerLifecycleRow(row)); Parties.acceptRow(result.partyRow); }
    return { result, prepared: party, members, party: result.partyRow && Parties.acceptRow(result.partyRow) };
}
async function loot(party, units, { stale = false } = {}) {
    const members = party.memberIds.map(id => Life.cachedState(id));
    const { grants } = await Owner.claimBatch(members, { allowParty: true, allowLifecycle: true });
    assert.equal(grants.length, members.length);
    const atomicGroup = { id: `help:${grants[0].leaseId}`, memberIds: party.memberIds,
        partyChanges: [{ partyId: party.partyId, memberIds: party.memberIds, expectedUpdatedAt: party.updatedAt,
            updatedAt: Math.max(Date.now(), party.updatedAt + 1), nextResolveAt: Date.now() + 60000,
            statsJson: JSON.stringify({ ...party.stats, agreement: { ...party.stats.agreement,
                help: { ...party.stats.agreement.help, remaining: 99999999 } } }) }] };
    const rewards = Agreement.allocate(members.map((state, index) => ({ state,
        result: { materialize: { items: index === 1 ? [{ selfId: 1869, name: 'Iron Ore', amount: units }] : [] } } })),
    party.stats.agreement);
    assert.equal(rewards.memberResults[0].result.materialize.items.length, 1, 'funded customer receives ordered actual drop');
    const entries = rewards.memberResults.map(({ state, result }) => {
        const inventory = { ...state.inventory };
        for (const item of result.materialize.items) inventory[item.selfId] = { ...item, amount: Number(inventory[item.selfId]?.amount || 0) + item.amount };
        return { token: grants.find(grant => grant.characterId === state.characterId), atomicGroup,
            options: { allowParty: true, allowLifecycle: true }, proposal: { baseState: state }, nextState: { ...state, inventory } };
    });
    if (stale) entries[1].token = { ...entries[1].token, revision: entries[1].token.revision - 1 };
    const before = await images(party.memberIds);
    const results = await Owner.commitAndReleaseBatch(entries);
    if (stale) { assert(results.every(result => !result.ok)); assert.deepEqual(await images(party.memberIds), before);
        await Owner.releaseBatch(grants); }
    else { assert(results.every(result => result.ok)); assert(results.every(result => result.row.simulationRevision === result.revision));
        Parties.acceptRow(results[0].partyRow); }
    return { results, entries };
}
async function run() {
    DB.init(); invoke('GameServer/DataCache').init(); await Life.init(); await Parties.init();
    const a = await seed(), b = await seed(), c = await seed();
    if (process.argv.includes('--loot')) {
        const spoil = [{ state: a, result: { materialize: { items: [] } } },
            { state: b, result: { materialize: { items: [
                { selfId: 1869, amount: 1, partySpoil: true },
                { selfId: 1864, amount: 1, partySpoil: true } ] } } }];
        const agreement = { mode: 'turn', cursor: 1, spoil: 'spoiler',
            help: { status: 'funded', payerId: a.characterId, itemId: 1869 } };
        const divided = Agreement.allocate(spoil, agreement);
        assert.deepEqual(divided.memberResults[0].result.materialize.items, [{ selfId: 1869, amount: 1 }]);
        assert.deepEqual(divided.memberResults[1].result.materialize.items, [{ selfId: 1864, amount: 1 }]);
        assert.equal(divided.agreement.cursor, 1, 'ordered and retained spoil do not advance ordinary turns');
        assert.equal(spoil[1].result.materialize.items.length, 2, 'original earned rewards remain unchanged');

        const World = invoke('GameServer/World/World'), Actor = invoke('GameServer/Model/Actor');
        const Party = invoke('GameServer/Bot/AI/PartyCompanionService');
        const previousUser = World.user;
        World.user = { sessions: [], revision: 0 };
        const sessions = [a, b, c].map(state => {
            const actor = new Actor({ id: state.characterId, name: state.name, isOnline: false,
                locX: 0, locY: 0, locZ: 0, hp: 100, maxHp: 100, mp: 100, maxMp: 100 });
            const session = { actor, accountId: state.accountName, fetchAccountId() { return this.accountId; },
                hotBackgroundPartyId: 'hot-loot-policy', socket: { destroy() {} } };
            actor.session = session; World.insertUser(session); actor.setIsOnline(true);
            return session;
        });
        try {
            // Native roster and loot policy control; this does not simulate a hot handoff or payment.
            const prepared = Parties.prepareCommit({ partyId: 'hot-loot-policy', leaderId: a.characterId,
                memberIds: [a.characterId, b.characterId, c.characterId], status: 'hot', stats: { agreement } });
            Parties.acceptRow(prepared.row);
            assert.equal(Party.resolveLootSession(sessions[1], 1869, null, { spoil: true }), sessions[0]);
            assert.equal(Party.resolveLootSession(sessions[1], 1864, null, { spoil: true }), sessions[1]);
            assert.equal(Party.resolveLootSession(sessions[1], 1870, null), sessions[0]);
            assert.equal(Party.resolveLootSession(sessions[1], 1870, null), sessions[1]);
            const split = Party.adenaAllocations(sessions[1], 1001);
            assert.deepEqual(split.map(entry => entry.amount), [334, 334, 333]);
            sessions[2].actor.setIsOnline(false);
            assert(!Party.lootMembersForLeader(sessions[0]).includes(sessions[2]));
            // Actual player companion distribution remains Finder/Turn, without an autonomous agreement.
            sessions[0].hotBackgroundPartyId = null; sessions[1].hotBackgroundPartyId = null;
            sessions[1].partyCompanion = true; sessions[1].followPlayerSession = sessions[0];
            const Manager = invoke('GameServer/Bot/BotManager'), oldSessions = Manager.sessions;
            Manager.sessions = [sessions[1]];
            try {
                Party.syncClientDistribution(sessions[0], 0);
                assert.equal(Party.resolveLootSession(sessions[1], 1869), sessions[1]);
                Party.syncClientDistribution(sessions[0], 3);
                assert.equal(Party.resolveLootSession(sessions[1], 1869), sessions[0]);
            } finally { Manager.sessions = oldSessions; }
        } finally { World.user = previousUser; }
        console.log('PASS ordered spoil priority, native hot roster/turn/Adena and player distribution parity');
        return;
    }
    if (process.argv.includes('--membership')) {
        const outsider = await seed();
        const objective = { helpDeal: { payerId: a.characterId, itemId: 1869, count: 1, fee: 1000 } };
        const prepared = Parties.prepareCommit({ partyId: 'foreign-help-member', leaderId: a.characterId,
            memberIds: [a.characterId, b.characterId, outsider.characterId], status: 'active', stats: {
                agreement: Agreement.propose(a, [a, b, outsider], objective, { rng: () => 0 }) } });
        const members = [a, b, c].map(state => Life.preparePartyAssignment(state, prepared.row.partyId, 'dps', a.characterId));
        const ids = [a, b, c, outsider].map(state => state.characterId), before = await images(ids);
        await assert.rejects(DB.commitBackgroundPartyMembership({ party: prepared.row, members }), /party_help_membership_changed/);
        assert.deepEqual(await images(ids), before);
        console.log('PASS declared foreign helper cannot borrow an unassigned native payment recipient');
        return;
    }
    const pure = [a, b, c].map((state, index) => ({ state, result: { materialize: { items: index === 0
        ? [{ selfId: 1869, amount: 1 }, { selfId: 1864, amount: 1, partySpoil: true }] : [] } } }));
    const turn = Agreement.allocate(pure, { mode: 'turn', cursor: 1, spoil: 'spoiler' });
    assert.equal(turn.memberResults[1].result.materialize.items[0].selfId, 1869);
    assert.equal(turn.memberResults[0].result.materialize.items[0].selfId, 1864);
    assert.equal(turn.agreement.cursor, 2); assert.equal(pure[0].result.materialize.items.length, 2);
    const need = Agreement.allocate(pure, { mode: 'need', spoil: 'spoiler' }, { needScore: state => state === c ? 2 : 1 });
    assert.equal(need.memberResults[2].result.materialize.items[0].selfId, 1869);
    const social = { traits: { sociability: 0.5, empathy: 0.5, commitment: 0.5 } };
    const solo = { hunt: { perHour: 100 } };
    const weak = Goals.participation(a, [b], { persona: social, context: solo, groupContext: { hunt: { perHour: 100 } } });
    const strong = Goals.participation(a, [b], { persona: social, context: solo, groupContext: { hunt: { perHour: 400 } } });
    assert.equal(strong.probability, weak.probability, 'party admission ignores hourly income');
    assert.equal(weak.probability, Goals.participation(a, [b], { persona: social }).probability);
    assert(Math.abs(weak.probability - 7 / 12) < 1e-12);
    assert(Goals.participation(a, [b], { persona: social, context: solo, groupContext: { hunt: { perHour: 100 } }, fee: 100, hours: 0.5 }).probability === weak.probability);
    const candidates = [{ characterId: 901, level: 10, stats: { role: 'dps' } },
        { characterId: 902, level: 10, stats: { role: 'dps' } }, { characterId: 903, level: 14, stats: { role: 'healer' } }];
    const selected = Composition.selectMembers(candidates, { maxSize: 2, minSize: 2,
        memory: { assess: () => ({ ready: false }) } });
    assert.deepEqual(selected.map(state => state.characterId).sort(), [901, 903], 'a free healer takes the support slot');
    const joint = Goals.joint({ stats: {} }, [a, b], { context: { network: { activity: { activity: 'hunting', spotId: 'shared', itemId: 1869, nodeKey: '1:gear' } } } });
    assert.equal(joint.objective.spotId, 'shared'); assert.equal(joint.memberGoals.length, 2);
    console.log('PASS shared goals/trait participation/support slots/need-turn-spoil contract');

    const funded = await fund([a, b, c], 'paid'); assert(funded.result.ok);
    assert.equal(funded.party.stats.agreement.help.remaining, 1001);
    assert.equal(held(await DB.fetchItems(a.characterId), 57), 8999);
    assert.equal(Life.cachedState(a.characterId).adena, 8999);
    console.log('PASS native membership atomically reserves real help fee');
    await loot(funded.party, 1, { stale: true });
    console.log('PASS one stale member refuses the complete loot/payment group');
    const first = await loot(Parties.find(funded.party.partyId), 1);
    const partial = Parties.find(funded.party.partyId);
    assert.equal(partial.stats.agreement.help.remaining, 501); assert.equal(partial.stats.agreement.help.paid, 500);
    assert.equal(held(await DB.fetchItems(b.characterId), 57), 10250);
    assert.equal(held(await DB.fetchItems(c.characterId), 57), 10250);
    const conserved = await images(partial.memberIds);
    assert((await Owner.commitAndReleaseBatch(first.entries)).every(result => !result.ok));
    assert.deepEqual(await images(partial.memberIds), conserved);
    console.log('PASS actual ordered drop pays proportionally/equally; replay cannot pay twice');
    await loot(partial, 1);
    const complete = Parties.find(partial.partyId);
    assert.equal(complete.stats.agreement.help.status, 'completed'); assert.equal(complete.stats.agreement.help.remaining, 0);
    assert.equal(held(await DB.fetchItems(a.characterId), 1869), 2);
    assert.equal(held(await DB.fetchItems(b.characterId), 57) + held(await DB.fetchItems(c.characterId), 57), 21001);
    console.log('PASS completion delivers original ordered items and every escrow Adena once');
    const d = await seed(), e = await seed(), f = await seed();
    const cancelled = await fund([d, e, f], 'cancelled'); assert(cancelled.result.ok);
    const closed = await Parties.setStatus(cancelled.party.partyId, 'dissolved');
    assert.equal(closed.stats.agreement.help.status, 'cancelled');
    assert.equal(held(await DB.fetchItems(d.characterId), 57), 10000);
    await Parties.setStatus(closed.partyId, 'dissolved');
    assert.equal(held(await DB.fetchItems(d.characterId), 57), 10000);
    console.log('PASS existing party ending refunds held money exactly once');
    const g = await seed(), h = await seed(), i = await seed();
    const token = await Owner.claim(g); assert(token.ok);
    const before = await images([g.characterId, h.characterId, i.characterId]);
    const refused = await fund([g, h, i], 'busy'); assert(!refused.result.ok);
    assert.deepEqual(await images([g.characterId, h.characterId, i.characterId]), before);
    await Owner.release(token);
    console.log('PASS native active owner blocks help funding without partial membership/payment');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await DB.close(); fs.rmSync(directory, { recursive: true, force: true });
    if (previous === undefined) delete process.env.L2NODE_CONFIG_FILE; else process.env.L2NODE_CONFIG_FILE = previous;
    console.log('CLEANUP', !fs.existsSync(directory));
});
