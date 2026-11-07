'use strict';
// The decision trace (situations.md §13 level 2): off it records nothing and touches no file; on, a situation, a
// stop and a decision become records of the bot they belong to, scripts/trace.js joins them into "situation →
// decision", a rate past its bound is a counted drop, and the file stays inside its rotation.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
require('../src/Global');
const { DecisionTraceWriter, FILES } = require('../src/DecisionTraceWriter');
const DecisionTrace = require('../src/GameServer/Bot/DecisionTrace');
const Config = require('../src/GameServer/Bot/Population/PopulationConfig');
const Situations = require('../src/GameServer/Bot/Situations');
const Trace = require('../scripts/trace');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-trace-'));
try {
    // Off: nothing recorded, no file, no clock.
    const off = DecisionTrace.create({ config: {}, now() { throw Error('off clock'); } });
    assert.equal(off.record({ kind: 'raise', bot: 1 }), false);
    assert.deepEqual(off.stats(), { enabled: false });
    const offWriter = new DecisionTraceWriter(path.join(directory, 'off'), {}, { now() { throw Error('off clock'); } });
    assert.equal(offWriter.write(new Proxy([], { get() { throw Error('off payload'); } })), 0); offWriter.cleanup(); offWriter.rotate();
    assert(!fs.existsSync(path.join(directory, 'off')));

    // On: a far bot's new grade at work waits for its stop (the earning spot, the build and the gear plan hear it);
    // the stop wakes them; the earning spot is taken.
    Config.decisionTrace = true;
    const sent = [];
    DecisionTrace.connect(batch => { sent.push(...batch.records); });
    // A bot holding its answers (with none a decision reads woken).
    const stats = { woken: 0, earning: { spotId: '9_24' }, wishSections: {}, equipmentPlan: null };
    Situations.raise(stats, 'grade_changed', null, Situations.place({ phase: 'cold', activity: 'hunting' }), 501);
    Situations.stop(stats, Situations.REST, 501);
    Situations.decided(stats, 'earning_spot', { caller: 'step', subject: 501, answer: '11_6', was: '9_24' });
    Situations.decided({ woken: 0, earning: { spotId: '9_24' } }, 'earning_spot', { caller: 'party', subject: 502 });
    DecisionTrace.ack(1, sent.length);
    const rows = sent.map(row => JSON.parse(row));
    assert.deepEqual(rows.map(row => [row.bot, row.kind]), [[501, 'raise'], [501, 'stop'], [501, 'decided'], [502, 'decided']]);
    assert.equal(rows[0].name, 'grade_changed'); assert.equal(rows[0].waits, 'earning_spot,build,gear_plan'); assert.equal(rows[0].woke, '');
    assert.equal(rows[1].woke, 'earning_spot,build,gear_plan');
    assert.equal(rows[2].answer, '11_6'); assert.equal(rows[2].was, '9_24'); assert.equal(rows[2].how, 'taken');
    assert.equal(rows[3].how, 'unwoken', 'a decision taken with no situation is named so');
    const summary = Trace.summary(rows);
    assert.equal(summary.pairs['stop@rest → earning_spot (moved)'], 1);
    assert.equal(summary.pairs['unwoken:party → earning_spot (kept)'], 1);
    assert.equal(Trace.line(rows[2]), 'earning_spot taken by step: 11_6 (was 9_24)');

    // A worker's record keeps its candidates' hours through main's queue.
    const forwarded = DecisionTrace.create({ config: { decisionTrace: true }, thread: 'main' }), out = [];
    forwarded.connect(batch => { out.push(...batch.records); });
    const worker = DecisionTrace.create({ config: { decisionTrace: true }, thread: 'worker' }), sentByWorker = [];
    worker.connect(batch => { sentByWorker.push(...batch.records); });
    worker.detail({ bot: 64, phase: 'town_choice', candidates: [{ town: 'Giran', value: 1.5 }] });
    forwarded.accept(sentByWorker);
    assert.deepEqual(JSON.parse(out[0]).candidates, [{ town: 'Giran', hours: 1.5 }], 'hours survive the hop to main');
    assert.equal(JSON.parse(out[0]).thread, 'worker');

    // The rate bound: records past it in one second are dropped and counted; a detail record never takes the
    // decisions' reserve.
    const clock = { at: 1000 }, bounded = DecisionTrace.create({ config: { decisionTrace: true }, thread: 'main', now: () => clock.at });
    let kept = 0;
    for (let i = 0; i < DecisionTrace.LIMITS.perSecond + 10; i++) kept += bounded.record({ kind: 'raise', bot: 7, name: 'died' }) ? 1 : 0;
    assert.equal(kept, DecisionTrace.LIMITS.perSecond);
    assert.equal(bounded.stats().drops.rate, 10, 'every record past the rate is counted');
    clock.at += 1000;
    let details = 0;
    for (let i = 0; i < DecisionTrace.LIMITS.perSecond; i++) details += bounded.detail({ bot: 7, phase: 'funding' }) ? 1 : 0;
    assert(details < DecisionTrace.LIMITS.perSecond && bounded.record({ kind: 'death', bot: 7, killer: 'npc:20001' }),
        'detail records leave the decisions their share');

    // The file: bounded batch split and rotation, an oversized row an explicit loss.
    const writer = new DecisionTraceWriter(directory, { build: 'fixture' }, { enabled: true, maxFile: 1024 });
    const lines = new Array(16).fill(JSON.stringify({ bot: 64, reason: 'x'.repeat(390) }));
    assert.equal(writer.write(lines), 16); assert.equal(writer.snapshot().records, 16);
    assert(writer.snapshot().rotations > 0);
    const names = fs.readdirSync(directory).filter(name => name.startsWith('decision-trace')); assert(names.length <= FILES);
    for (const name of names) { assert(fs.statSync(path.join(directory, name)).size <= 1024);
        for (const line of fs.readFileSync(path.join(directory, name), 'utf8').trim().split('\n')) assert.doesNotThrow(() => JSON.parse(line)); }
    assert.equal(writer.write([JSON.stringify({ reason: 'x'.repeat(950) })]), 0, 'a row that cannot fit is an explicit loss');
    assert.equal(writer.snapshot().dropped, 1);
} finally {
    Config.decisionTrace = false;
    DecisionTrace.stop();
    fs.rmSync(directory, { recursive: true, force: true });
}
console.log('Decision trace: off records nothing, raise/stop/decided per bot, situation → decision summary, counted rate drops, bounded file passed');
