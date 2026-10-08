const assert = require('assert');
require('../src/Global');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Diagnostics = invoke('GameServer/Bot/Economy/EconomyDiagnostics');
const Consumption = invoke('GameServer/Bot/Economy/ConsumptionDiagnostics');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Cache = invoke('GameServer/DataCache'); Cache.init();
const Backpack = invoke('GameServer/Actor/Backpack');
const Item = invoke('GameServer/Item/Item');
const Response = invoke('GameServer/Network/Response');
const { ColdCommitQueue } = require('../src/GameServer/Bot/Population/ColdCommitQueue');
const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const state = { characterId: 900, level: 12, phase: 'cold', activity: 'hunting', exp: 0, sp: 0, adena: 0,
    loc: { locX: 0, locY: 0, locZ: 0 }, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
    inventory: { 129: { selfId: 129, amount: 1, equipped: true, slot: 7 },
        1463: { selfId: 1463, amount: 100 }, 1539: { selfId: 1539, amount: 5 } },
    stats: { classId: 0, classProgressionLevel: 12, classProgressionClassId: 0, coldCombat: { version: 1, classId: 0 } } };
const result = { patch: { activity: 'hunting' }, materialize: { exp: 0, sp: 0, adena: 0, items: [] },
    debug: { shotActions: 3, drunkPotions: { 1539: 2 } }, events: [] };
function fixture(accountId = 'bot_fixture') {
    const backpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
    const item = (id, fields) => new Item(id, { amount: 1, stackable: true, ...fields });
    backpack.items = [item(1, { selfId: 1, kind: 'Weapon.Sword', equipped: true, slot: 7, rank: 'none', soulshot: 2 }),
        item(2, { selfId: 1835, kind: 'Other.Shot', amount: 5 }), item(3, { selfId: 1539, kind: 'Other.Potion', amount: 5 })];
    const actor = { backpack, fetchId: () => 900, fetchClassId: () => 0, fetchLocX: () => 0, fetchLocY: () => 0,
        fetchLocZ: () => 0, isDead: () => false, state: { fetchCasts: () => false, setCasts() {} } };
    return { backpack, session: { accountId, actor, persistenceMode: 'ephemeral', dataSendToMe() {}, dataSendToMeAndOthers() {} } };
}
async function main() {
    const record = Diagnostics.push, count = Diagnostics.count, enabled = Diagnostics.enabled;
    const facts = [], totals = [];
    Diagnostics.push = row => { facts.push(row); return true; };
    Diagnostics.count = (...row) => totals.push(row);
    Diagnostics.enabled = () => Config.developerDiagnostics === true;
    try {
        Config.developerDiagnostics = false;
        const capture = Consumption.fact, hot = Consumption.hot;
        Consumption.fact = Consumption.hot = () => { throw Error('diagnostic helper called off'); };
        let off;
        try {
            off = await Life.prepareResolve(structuredClone(state), structuredClone(result), { persist: false, timestamp: 1000, projectClassProgression: true });
            const f = fixture(); f.backpack.consumeSoulshot(f.session);
            assert.strictEqual(f.backpack.fetchItemFromSelfId(1835).fetchAmount(), 3);
        } finally { Consumption.fact = capture; Consumption.hot = hot; }
        assert.strictEqual(off.stats.lastResolveDebug, null);
        assert.strictEqual(Life.targetCombatSummary(), null);
        Config.developerDiagnostics = true;
        const onResult = structuredClone(result);
        const on = await Life.prepareResolve(structuredClone(state), onResult, { persist: false, timestamp: 1000, projectClassProgression: true });
        const rows = onResult.consumptionDiagnostics;
        assert.strictEqual(rows.length, 2);
        assert(rows.some(row => row[0] === 1539 && row[1] === 5 && row[2] === 3));
        assert(rows.some(row => row[0] === 1463 && row[1] === 100 && row[2] === on.inventory[1463].amount));
        assert.strictEqual(facts.length, 0, 'projection cannot claim a committed debit');
        assert(!JSON.stringify(on).includes('consumptionDiagnostics'), 'facts cannot enter persisted state');
        delete on.stats.lastResolveDebug; delete off.stats.lastResolveDebug;
        assert.deepStrictEqual(on, off, 'diagnostics cannot change projected gameplay');
        const p = { proposalId: 'consume-900', characterId: 900, priority: 'P2', enqueuedAt: 0,
            token: { characterId: 900, ownerId: 'cold_simulation_owner', revision: 1, leaseId: 'lease', leaseUntil: 30000 },
            baseState: { characterId: 900 }, result: { consumptionDiagnostics: rows } };
        for (const accepted of [false, true]) {
            const queue = new ColdCommitQueue({ now: () => 1000, prepare: async e => e.baseState,
                commit: async entries => entries.map(() => ({ ok: accepted, characterId: 900 })),
                afterCommit: async entry => Consumption.publish(900, entry.proposal.result.consumptionDiagnostics, { commandId: 'consume-900', revision: 1 }) });
            queue.enqueue(p); await queue.flushCharacter(900);
            assert.strictEqual(facts.length, accepted ? 2 : 0, 'only an accepted durable commit publishes consumption');
        }
        assert.strictEqual(facts[0].commandId, 'consume-900');
        assert(totals.some(row => row[0] === 'consumption' && row[1] === 'items' && row[2] === 'potion' && row[3] === 2));
        const f = fixture(); f.backpack.consumeSoulshot(f.session);
        assert.strictEqual(facts.at(-1).actual, 2);
        const human = fixture('player_fixture'), beforeHuman = facts.length;
        human.backpack.consumeSoulshot(human.session); assert.strictEqual(facts.length, beforeHuman);
        Diagnostics.enabled = () => false;
        const unselectedRecords = facts.length, unselectedTotals = totals.length;
        const unselected = fixture(); unselected.backpack.consumeSoulshot(unselected.session);
        Consumption.publish(900, rows);
        assert.strictEqual(facts.length, unselectedRecords, 'unselected bots produce no detailed consumption payload');
        assert.strictEqual(totals.length - unselectedTotals, 6, 'hot and cold consumption aggregates cover unselected bots');
        Diagnostics.enabled = () => Config.developerDiagnostics === true;
        const skill = { fetchSkillType: () => -1, fetchTargetKind: () => 'self', fetchHitTime: () => 0 };
        const oldPacket = Response.skillStarted; Response.skillStarted = () => Buffer.from([0]);
        try {
            f.backpack.buildItemSkill = () => skill; f.backpack.applySelfItemSkill = () => {};
            f.backpack.useSkillItem(f.session, 3, { consume: true });
            assert.strictEqual(facts.at(-1).item, 1539); assert.strictEqual(facts.at(-1).before, 5); assert.strictEqual(facts.at(-1).after, 4);
        } finally { Response.skillStarted = oldPacket; }
        const cap = [];
        for (let i = 0; i < 16; i++) Consumption.fact(cap, i + 1, 5, 4, 1);
        Consumption.fact(cap, 999, 5, 4, 0);
        Consumption.fact(cap, 1000, 5, 4, 1);
        assert.strictEqual(cap.length, 17); assert(Buffer.byteLength(JSON.stringify(cap)) <= 1024);
        assert(totals.some(row => row[0] === 'consumption_capture' && row[2] === 'fact_limit'));
        const bigRows = [];
        for (let i = 0; i < 17; i++) Consumption.fact(bigRows, Number.MAX_SAFE_INTEGER,
            Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1, i ? 1 : 0);
        assert(Buffer.byteLength(JSON.stringify(bigRows)) <= 1024);
        assert.strictEqual(bigRows.length, 17, 'even the widest legal compact tuples fit the fixed byte budget');
        let emitted;
        const kernel = new ColdSimulationKernel({ resolveSolo: () => ({}), now: () => 1000, emit: (type, payload) => { if (type === 'proposal_batch') emitted = payload; } });
        const wide = { ...p, result: { debug: { padding: '' }, consumptionDiagnostics: rows } };
        const core = structuredClone(wide); delete core.result.consumptionDiagnostics;
        const emptySize = Buffer.byteLength(JSON.stringify({ proposals: [core] }));
        wide.result.debug.padding = 'x'.repeat(240 * 1024 - emptySize - 2);
        const offCore = structuredClone(wide); delete offCore.result.consumptionDiagnostics;
        kernel.dirty.set(900, wide);
        assert.strictEqual(kernel.flush(null, true), 1, 'optional facts cannot reject a gameplay proposal at the byte limit');
        assert.strictEqual(emitted.proposals[0].result.consumptionDiagnostics, undefined);
        assert(totals.some(row => row[0] === 'consumption_capture' && row[2] === 'ipc_capacity'));
        Config.developerDiagnostics = false;
        let offEmitted;
        const offKernel = new ColdSimulationKernel({ resolveSolo: () => ({}), now: () => 1000,
            emit: (type, payload) => { if (type === 'proposal_batch') offEmitted = payload; } });
        offKernel.dirty.set(900, offCore);
        assert.strictEqual(offKernel.flush(null, true), 1);
        assert.deepStrictEqual(emitted, offEmitted, 'the near-cap native packet is identical on/off after stripping optional facts');
        console.log('Consumption diagnostics: off no helpers; exact debit; accepted-only; no persisted facts; on/off gameplay; human filter; caps and core-budget stripping passed');
    } finally { Diagnostics.push = record; Diagnostics.count = count; Diagnostics.enabled = enabled; Config.developerDiagnostics = false; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
