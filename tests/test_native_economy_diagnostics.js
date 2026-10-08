'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('native-developer-diagnostics');
require('../src/Global');
fixture.assertConfigured(options.default);
const Database = invoke('Database'), Data = invoke('GameServer/DataCache'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const Commit = require('../src/GameServer/Bot/Economy/EconomyCommit');
const Diagnostics = require('../src/GameServer/Bot/Economy/EconomyDiagnostics');
const Config = require('../src/GameServer/Bot/Population/PopulationConfig');
const Native = require('./helpers/nativeMarketFixture');
Data.init();
async function seed(id) {
    await Native.character(Database, id, 'Diagnostic' + id, 'bot_diagnostic_' + id);
    await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 1000, stackable: true });
    return Life.upsertState({ characterId: id, accountName: 'bot_diagnostic_' + id, name: 'Diagnostic' + id, level: 40,
        phase: 'cold', activity: 'shopping', adena: 1000, homeRegion: 'Dion', currentRegion: 'Dion',
        inventory: { 57: { selfId: 57, amount: 1000 } }, stats: { classId: 1, money: [36000, 0, 100, 0], decisionSeq: 9, activityLeaf: 7, wishFocus: ['stock:potions'] },
        simulation: { ownerId: 'legacy_main', revision: 0 }, timing: {}, vitals: {}, updatedAt: Date.now() }, 'fixture');
}
async function purchase(state, amount = 6) {
    const admitted = await Commit.admit(state, Commit.KINDS.npcBuy);
    try {
        const args = { selfId: 1060, name: 'Healing Potion', amount, unitPrice: 10, stackable: true, slot: 0,
            coldState: admitted.state, economyCommand: admitted.command, autoEquip: false };
        return { admitted, args, result: await Database.purchaseNpcInventoryItem(state.characterId, args) };
    } finally { Commit.finish(state.characterId, admitted.command); }
}
async function run() {
    Database.init();
    Config.economyDiagnostics = true; Config.economyDiagnosticsBotIds = '64,128';
    Config.developerDiagnostics = false;
    const offState = await seed(64);
    const original = { push: Diagnostics.push, count: Diagnostics.count, enabled: Diagnostics.enabled };
    for (const key of Object.keys(original)) Diagnostics[key] = () => { throw Error('off called ' + key); };
    const off = await purchase(offState);
    Object.assign(Diagnostics, original);
    assert.equal(off.result.units, 6); assert.equal(off.result.spent, 60);
    assert.equal(Database.stats().diagnostics.enabled, false);
    assert.equal(Database.stats().total, undefined); assert.equal(Database.stats().operations, undefined);
    Config.developerDiagnostics = true;
    const rows = [];
    Diagnostics.connect(batch => { rows.push(...batch.records.map(JSON.parse)); Diagnostics.ack(batch.id, batch.records.length); return true; });
    const on = await purchase(await seed(128));
    assert.equal(on.result.units, off.result.units); assert.equal(on.result.spent, off.result.spent);
    const id = on.admitted.command[0];
    const correlated = rows.filter(row => row.commandId === id);
    assert(correlated.some(row => row.phase === 'native_quantity' && row.requested === 6 && row.unitPrice === 10));
    const funding = correlated.find(row => row.phase === 'native_funding');
    assert.equal(funding.wallet, 1000); assert.equal(funding.budget, 900); assert.equal(funding.reserve, 100);
    assert.equal(funding.cost, 60); assert.equal(funding.decisionSeq, 9);
    assert(correlated.some(row => row.phase === 'native_result' && row.actual === 6 && row.spent === 60));
    assert(correlated.every(row => row.sequence === on.admitted.command[2] && row.outcome === 'committed'));
    const replay = await Database.purchaseNpcInventoryItem(128, on.args);
    assert.equal(replay.replayed, true);
    const replayTrace = rows.find(row => row.phase === 'native_replay' && row.commandId === id && row.reason === 'saved_receipt');
    assert(replayTrace); assert.equal(replayTrace.actual, 0); assert.equal(replayTrace.spent, 0);
    assert.equal(replayTrace.receiptUnits, 6); assert.equal(replayTrace.receiptSpent, 60);
    const current = Commit.acceptRow(on.result.coldLifeRow);
    const before = Native.amount(await Database.fetchItems(128), 57);
    const rejected = await Commit.admit(current, Commit.KINDS.npcBuy);
    const beforeIndex = rows.length;
    await assert.rejects(Database.purchaseNpcInventoryItem(128, { ...on.args, amount: 100, unitPrice: 10,
        coldState: rejected.state, economyCommand: rejected.command }), /economy_funding_changed/);
    Commit.finish(128, rejected.command);
    assert.equal(Native.amount(await Database.fetchItems(128), 57), before);
    const failed = rows.slice(beforeIndex);
    assert(failed.length && failed.every(row => row.outcome === 'rolled_back' && row.actual === 0 && row.spent === 0));
    assert(failed.some(row => row.phase === 'native_funding' && row.reason === 'economy_funding_changed'));
    assert.equal(Database.stats().pending, 0);
    await Database.close(); Diagnostics.stop();
    console.log('Native diagnostics: off no hooks, canonical quantities unchanged, funding/correlation, replay and rollback passed');
}
run().catch(async error => { console.error(error); try { await Database.close(); } catch { /* Preserve the original test failure. */ } process.exitCode = 1; }).finally(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
