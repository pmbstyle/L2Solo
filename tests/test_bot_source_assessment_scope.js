'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('source-assessment-scope');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const native = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const filename = require.resolve('../src/GameServer/Bot/AI/GearAcquisitionPlanner');
const source = fs.readFileSync(filename, 'utf8');
// Literal native assessment body from 9318ccab. Only a test counter is added.
const oldAssessment = require('./helpers/sourceAssessmentReference');
function compile(text, old = false) {
    if (old) {
        const begin = text.indexOf('function partyNeedAssessmentForSource(');
        const end = text.indexOf('\nfunction sourceTargetLevel(', begin);
        text = text.slice(0, begin) + oldAssessment + text.slice(end);
    } else {
        text = text.replace('function sourceAssessmentReason(readiness, targetLevel) {',
            'function sourceAssessmentReason(readiness, targetLevel) { assessmentComputations++;');
    }
    text += `\nlet assessmentComputations = 0;
module.exports._probe = {
    calls: () => assessmentComputations,
    scope: () => readinessScope,
    record: state => readinessScope?.get(state),
    limit: MAX_SOURCE_ASSESSMENTS
};`;
    const compiled = new Module(filename, module);
    compiled.filename = filename; compiled.paths = Module._nodeModulePaths(path.dirname(filename));
    compiled._compile(text, filename);
    return compiled.exports;
}
const current = compile(source), reference = compile(source, true);
const saved = require('./fixtures/wish_spot_native_state.json');
const variants = [saved, { ...saved, inventory: {} }, { ...saved, level: 39 },
    ...[0, 2, 12, 16, 57].map(classId => {
        const state = { ...saved, inventory: {}, stats: { ...saved.stats, classId, role: undefined } };
        const role = native.roleFor(state);
        const weapon = Data.items.find(item => [7, 14].includes(Number(item.etc?.slot)) && native.suitable(item, state, role, String(item.etc?.rank || 'none')));
        assert(weapon, `native compatible weapon for ${classId}`);
        state.inventory[weapon.selfId] = { selfId: weapon.selfId, amount: 1, equipped: true, equippedCount: 1, slot: Number(weapon.etc.slot) };
        return state;
    })];
const sources = [{ npcLevel: 40, spotLevel: 1 }, { npcLevel: 1, spotLevel: 40 }, { spotLevel: 40 },
    { npcLevel: '40' }, { npcLevel: 0, spotLevel: 40 }, { npcLevel: 'invalid' }, { npcLevel: NaN },
    { npcLevel: Infinity }, { npcLevel: -1 }, { npcLevel: 40.5 }, {},
    { raidBoss: true, npcLevel: 1 }, { sourceKind: 'raid', npcLevel: 1 }];
function outputs(api, state, input) {
    return api.withReadiness(() => input.map(source => ({ need: api.partyNeedForSource(state, source),
        reason: api.partyNeedReasonForSource(state, source), safe: api.soloSafeForSource(state, source),
        effort: api.sourceEffort({ ...source, expectedYield: 0.01 }, state) })));
}
try {
    const reasons = new Set();
    for (const original of variants) {
        const state = structuredClone(original), before = structuredClone(state);
        const readiness = reference.combatReadiness(state);
        const edges = [readiness.effectiveLevel - 0.01, readiness.effectiveLevel,
            readiness.effectiveLevel + 0.01, readiness.effectiveLevel + 2, readiness.effectiveLevel + 2.01];
        const input = [...sources, ...edges.map(npcLevel => ({ npcLevel }))];
        const expected = outputs(reference, state, input), actual = outputs(current, state, input);
        assert.deepEqual(actual, expected, 'all native assessment readers keep exact level/raid/margin semantics');
        for (const row of actual) reasons.add(row.reason);
        assert.deepEqual(current.combatReadiness(state), native.combatReadiness(state), 'public readiness fields stay unchanged');
        assert.deepEqual(state, before, 'assessment does not mutate authoritative state');
        current.withReadiness(() => {
            const first = current.combatReadiness(state); first.hasWeapon = !first.hasWeapon;
            assert.deepEqual(current.combatReadiness(state), readiness, 'public readiness copies do not expose the scope record');
            assert.equal(current._probe.record(state).assessments, null, 'readiness alone creates no source table');
        });
    }
    for (const reason of ['missing_weapon', 'unprepared_support', 'underleveled', 'tight_level_margin', 'solo_ready', 'raid_roster_required']) {
        assert(reasons.has(reason), `native fixtures cover ${reason}`);
    }
    const state = structuredClone(saved);
    current.withReadiness(() => {
        const firstCalls = current._probe.calls();
        for (let repeat = 0; repeat < 100; repeat++) {
            for (const npcLevel of [40, '40', 41, 'invalid']) {
                assert.equal(current.partyNeedForSource(state, { npcLevel }), reference.partyNeedForSource(state, { npcLevel }));
                assert.equal(current.partyNeedReasonForSource(state, { npcLevel }), reference.partyNeedReasonForSource(state, { npcLevel }));
            }
        }
        assert.equal(current._probe.calls() - firstCalls, 3, 'number/string levels and NaN share only identical answers');
        const record = current._probe.record(state);
        assert.equal(record.assessments.size, 3);
        assert([...record.assessments.values()].every(value => typeof value === 'string'));
        current.withReadiness(() => {
            assert.equal(current._probe.record(state), record, 'nested call uses the same owner');
            current.soloSafeForSource(state, { npcLevel: 40 });
        });
        assert.equal(current._probe.record(state), record, 'nested return preserves outer scope');
        const changed = { ...state, inventory: {} };
        assert.equal(current.partyNeedReasonForSource(changed, { npcLevel: 40 }), 'missing_weapon');
        assert.notEqual(current._probe.record(changed), record, 'hypothetical state owns distinct facts');
    });
    assert.equal(current._probe.scope(), null, 'outer return releases the scope');
    const overflow = Array.from({ length: 160 }, (_, i) => ({ npcLevel: i + 0.125 }));
    current.withReadiness(() => {
        const before = current._probe.calls();
        for (let repeat = 0; repeat < 2; repeat++) for (const source of overflow) {
            assert.equal(current.partyNeedForSource(state, source), reference.partyNeedForSource(state, source));
        }
        assert.equal(current._probe.record(state).assessments.size, 128);
        assert.equal(current._probe.calls() - before, 160 + 32, 'overflow recomputes without dropping goals');
    });
    // Early raid reads do not prepare a kit or allocate its table.
    current.withReadiness(() => {
        assert.equal(current.partyNeedReasonForSource(state, { sourceKind: 'raid' }), 'raid_roster_required');
        assert.equal(current._probe.record(state), undefined);
    });
    assert.throws(() => current.withReadiness(() => {
        current.soloSafeForSource(state, { npcLevel: 40 });
        throw Error('scope failure');
    }), /scope failure/);
    assert.equal(current._probe.scope(), null, 'throw releases the scope');
    state.inventory = {};
    assert.equal(current.withReadiness(() => current.partyNeedReasonForSource(state, { npcLevel: 40 })), 'missing_weapon',
        'the next decision sees changed equipment on the same object');
    // Outside a scope, no old answer may hide changes between individual reads.
    const exposed = current.combatReadiness(saved);
    assert(exposed.hasWeapon);
    assert.equal(current.partyNeedReasonForSource(state, { npcLevel: 40 }), 'missing_weapon');
    assert.equal(current._probe.scope(), null);
    const srcs = [{ spotId: 'mixed', npcLevel: 100 }, { spotId: 'low', npcLevel: 10 }];
    const selected = current.bestSourceForState(srcs, saved);
    assert.deepEqual(selected, reference.bestSourceForState(srcs, saved), 'real wrapped source selector keeps ranking');
    assert.equal(current._probe.scope(), null, 'selector closes its own scope');
    assert.equal(invoke('Database').isReady(), false);
    console.log(JSON.stringify({ variants: variants.length, casesPerVariant: sources.length + 5,
        reasonKinds: reasons.size, limit: current._probe.limit, overflowComputations: 192 }));
    console.log('test_bot_source_assessment_scope: native reference, ownership, freshness, bounds and lifecycle PASS');
} finally {
    fs.rmSync(isolated.directory, { recursive: true, force: true });
}
process.exit(0);
