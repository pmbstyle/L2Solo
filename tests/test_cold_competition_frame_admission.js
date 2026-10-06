const assert = require('assert');
require('../src/Global');
const Database = invoke('Database');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');

// Real Main constructor, scheduler, onMessage and Protocol; outbound Worker
// and held apply are transport/task probes. No DB, server or gameplay starts.
const initialActions = Config.coldCompetitionActionsEnabled;
const originalNow = Date.now;
let clock = originalNow(), sequence = 0;
Date.now = () => clock;
const failures = [], instances = [];

function gate() {
    let open;
    const promise = new Promise(resolve => { open = resolve; });
    return { promise, open };
}
function event(at, key = 'frame-probe') {
    return { key, at, action: 'yield', pressure: 2, spotId: 'probe', npcId: 10,
        actor: { id: 1, partyId: null }, peer: { id: 2, partyId: null } };
}
function frame(id, at = clock, events = [event(at, `frame-${id}`)]) {
    return { frameId: id, at, events };
}
function main() {
    const coordinator = new ColdSimulationCoordinator();
    const sent = [], calls = [];
    const worker = { postMessage(message) { sent.push(message); } };
    coordinator.worker = worker;
    coordinator.workerEpoch = `frame-source-${++sequence}`;
    coordinator.ready = true;
    coordinator.snapshotsLoaded = true;
    coordinator.competitionActions.budgetNow = () => 0;
    coordinator.competitionActions.apply = async value => {
        calls.push(value.key);
        return { ok: true };
    };
    instances.push(coordinator);
    return { coordinator, worker, sent, calls };
}
async function deliver(probe, value, source = probe.worker, epoch = probe.coordinator.workerEpoch) {
    // Additive before-source input: old telemetry contains the SAME events, so
    // the old scheduler genuinely runs them while the nested receipt is missing.
    const competition = { at: value.at, events: value.events, frame: value };
    const message = Protocol.envelope('heartbeat', epoch, { competition }, `frame-heartbeat-${++sequence}`);
    assert(Protocol.validateEnvelope(message, 'worker', { workerEpoch: epoch }).ok);
    await probe.coordinator.onMessage(message, source, epoch);
}
function receipt(probe, value) {
    return probe.sent.filter(message => message.type === 'competition_release'
        && message.payload.receipt?.frameId === value.frameId
        && message.payload.receipt?.at === value.at).at(-1)?.payload.receipt;
}
async function settled(probe) {
    if (probe.coordinator.competitionActions.running) await probe.coordinator.competitionActions.running;
}
async function check(name, work) {
    if (process.argv.includes('--malformed-frame-only') && !name.startsWith('malformed present frame')) return;
    Config.coldCompetitionActionsEnabled = true;
    try { await work(); console.log(`${name}: PASS`); }
    catch (error) { failures.push(name); console.error(`${name}: FAIL ${error.stack}`); }
    finally { for (const coordinator of instances) if (coordinator.competitionActions.running) await coordinator.competitionActions.running; }
}

async function run() {
    assert.strictEqual(Database.isReady(), false, 'transport proof must not initialize SQLite');
    if (!process.argv.includes('--admission-delta-only')) {
    await check('healthy original legacy scheduler installs and applies a changing task counter', async () => {
        const probe = main();
        probe.coordinator.competitionActions.submit({ at: clock, events: [event(clock, 'legacy-positive')] });
        await settled(probe);
        assert.deepStrictEqual(probe.calls, ['legacy-positive']);
        assert.strictEqual(probe.coordinator.competitionActions.report.applied, 1);
        assert.strictEqual(probe.coordinator.competitionActions.lastScanAt, clock);
    });
    await check('healthy current Main frame applies once and confirms admission', async () => {
        const probe = main(), value = frame(1);
        await deliver(probe, value); await settled(probe);
        console.log('current frame facts', JSON.stringify({ applied: probe.calls, receipt: receipt(probe, value) || null }));
        assert.deepStrictEqual(probe.calls, ['frame-1']);
        assert.strictEqual(probe.coordinator.competitionActions.report.applied, 1);
        assert.deepStrictEqual(receipt(probe, value), { frameId: 1, at: value.at, status: 'accepted' });
    });
    await check('busy delivery is deferred and original frame is admitted after settlement', async () => {
        const probe = main(), held = gate(), first = frame(1), second = frame(2, clock + 1);
        probe.coordinator.competitionActions.apply = async value => {
            probe.calls.push(value.key);
            if (value.key === 'frame-1') await held.promise;
            return { ok: true };
        };
        try {
            await deliver(probe, first);
            assert(probe.coordinator.competitionActions.running, 'real scheduler is held in its first task');
            clock++;
            await deliver(probe, second);
            console.log('busy frame facts', JSON.stringify({ calls: probe.calls, lastScanAt: probe.coordinator.competitionActions.lastScanAt,
                deferred: receipt(probe, second) || null }));
            assert.deepStrictEqual(probe.calls, ['frame-1']);
            assert.strictEqual(probe.coordinator.competitionActions.lastScanAt, first.at);
            assert.deepStrictEqual(receipt(probe, second), { frameId: 2, at: second.at, status: 'deferred' });
        } finally { held.open(); await settled(probe); }
        await deliver(probe, second); await settled(probe);
        assert.deepStrictEqual(probe.calls, ['frame-1', 'frame-2']);
        assert.strictEqual(receipt(probe, second)?.status, 'accepted');
    });
    await check('lost accepted receipt replays before TTL and current readiness checks without a second task', async () => {
        const probe = main(), value = frame(1);
        await deliver(probe, value); await settled(probe);
        assert.deepStrictEqual(probe.calls, ['frame-1']);
        probe.sent.length = 0;
        clock += 20000;
        probe.coordinator.ready = false;
        await deliver(probe, value);
        console.log('replay facts', JSON.stringify({ calls: probe.calls, receipt: receipt(probe, value) || null }));
        assert.deepStrictEqual(probe.calls, ['frame-1']);
        assert.strictEqual(receipt(probe, value)?.status, 'accepted');
    });
    await check('distinct same-time frames both apply once and retain manual duplicate behavior', async () => {
        const probe = main(), first = frame(1), second = frame(2);
        await deliver(probe, first); await settled(probe);
        await deliver(probe, second); await settled(probe);
        assert.deepStrictEqual(probe.calls, ['frame-1', 'frame-2']);
        probe.coordinator.competitionActions.submit({ at: clock, events: [event(clock, 'legacy-duplicate')] });
        await settled(probe);
        assert.deepStrictEqual(probe.calls, ['frame-1', 'frame-2']);
        assert.strictEqual(receipt(probe, second)?.status, 'accepted');
    });
    await check('observe-only deliberately consumes a current frame without gameplay', async () => {
        const probe = main(), value = frame(1);
        Config.coldCompetitionActionsEnabled = false;
        await deliver(probe, value); await settled(probe);
        assert.deepStrictEqual(probe.calls, []);
        assert.deepStrictEqual(receipt(probe, value), { frameId: 1, at: value.at, status: 'observed' });
    });
    await check('only an unadmitted expired frame receives expiry and performs no task', async () => {
        const probe = main(), value = frame(1, clock - 10001);
        await deliver(probe, value); await settled(probe);
        assert.deepStrictEqual(probe.calls, []);
        assert.deepStrictEqual(receipt(probe, value), { frameId: 1, at: value.at, status: 'expired' });
    });
    await check('healthy same-source skipped budget retains original release payload', async () => {
        const probe = main(), value = frame(1, clock, [0, 1, 2].map(i => event(clock, `skip-${i}`)));
        await deliver(probe, value); await settled(probe);
        assert.deepStrictEqual(probe.calls, ['skip-0', 'skip-1']);
        const released = probe.sent.filter(message => message.type === 'competition_release' && message.payload.events?.length);
        assert.strictEqual(released.length, 1);
        assert.deepStrictEqual(released[0].payload.events, [{ at: clock, action: 'yield',
            actor: { id: 1, partyId: null }, peer: { id: 2, partyId: null } }]);
    });
    await check('late skipped-budget completion cannot release into a replacement Worker', async () => {
        const probe = main(), held = gate(), replacement = [];
        const value = frame(1, clock, [0, 1, 2].map(i => event(clock, `late-${i}`)));
        probe.coordinator.competitionActions.apply = async value => {
            probe.calls.push(value.key);
            if (value.key === 'late-0') await held.promise;
            return { ok: true };
        };
        try {
            await deliver(probe, value);
            assert(probe.coordinator.competitionActions.running);
            probe.coordinator.worker = { postMessage(message) { replacement.push(message); } };
            probe.coordinator.workerEpoch = 'replacement-source';
        } finally { held.open(); await settled(probe); }
        console.log('late release facts', JSON.stringify({ calls: probe.calls, replacementTypes: replacement.map(message => message.type) }));
        assert.deepStrictEqual(probe.calls, ['late-0', 'late-1']);
        assert.strictEqual(replacement.filter(message => message.type === 'competition_release').length, 0);
    });
    await check('stopping and retired ingress perform no task and send no matching receipt', async () => {
        const probe = main(), value = frame(1);
        probe.coordinator.stopping = true;
        await deliver(probe, value); await settled(probe);
        assert.deepStrictEqual(probe.calls, []); assert.strictEqual(probe.sent.length, 0);
        probe.coordinator.stopping = false;
        await deliver(probe, value, { postMessage() { throw Error('retired fixture must not post'); } });
        assert.deepStrictEqual(probe.calls, []); assert.strictEqual(probe.sent.length, 0);
    });
    await check('Protocol rejects malformed receipt and mismatched nested event identity', async () => {
        const value = frame(1);
        assert.strictEqual(Protocol.validateEnvelope(Protocol.envelope('competition_release', 'wire-probe', {
            events: [], receipt: { frameId: 1, at: value.at, status: 'accepted' }
        }), 'main').ok, true);
        assert.strictEqual(Protocol.validateEnvelope(Protocol.envelope('competition_release', 'wire-probe', {
            events: [], receipt: { frameId: 1, at: value.at, status: 'made_up' }
        }), 'main').ok, false);
        assert.strictEqual(Protocol.validateEnvelope(Protocol.envelope('heartbeat', 'wire-probe', {
            competition: { frame: { ...value, events: [event(value.at + 1)] } }
        }), 'worker').ok, false);
    });
    }
    await check('future frame retains responsibility in enabled and observe-only modes', async () => {
        for (const enabled of [true, false]) {
            const probe = main(), value = frame(1, clock + 5000);
            Config.coldCompetitionActionsEnabled = enabled;
            await deliver(probe, value);
            assert.deepStrictEqual(probe.calls, []);
            assert.strictEqual(receipt(probe, value)?.status, 'deferred');
            assert.strictEqual(probe.coordinator.competitionFrameAdmission, null);
            assert.strictEqual(probe.coordinator.competitionActions.lastScanAt, 0);
            clock += 5000;
            await deliver(probe, value); await settled(probe);
            assert.strictEqual(receipt(probe, value)?.status, enabled ? 'accepted' : 'observed');
            assert.deepStrictEqual(probe.calls, enabled ? ['frame-1'] : []);
        }
    });
    await check('malformed present frame never falls back to valid original telemetry', async () => {
        const probe = main(), good = frame(1);
        await deliver(probe, good); await settled(probe);
        const beforeSent = probe.sent.length, beforeAdmission = probe.coordinator.competitionFrameAdmission;
        for (const bad of [undefined, null, frame(0), frame(2, clock, [event(clock + 1)])]) {
            const message = Protocol.envelope('heartbeat', probe.coordinator.workerEpoch,
                { competition: { at: clock + 1, events: [event(clock + 1, 'unframed-bypass')], frame: bad } }, `bad-frame-${++sequence}`);
            assert.strictEqual(Protocol.validateEnvelope(message, 'worker').ok, false);
            await probe.coordinator.onMessage(message, probe.worker, probe.coordinator.workerEpoch);
        }
        assert.deepStrictEqual(probe.calls, ['frame-1']);
        assert.strictEqual(probe.sent.length, beforeSent);
        assert.strictEqual(probe.coordinator.competitionFrameAdmission, beforeAdmission);
        assert.strictEqual(Protocol.validateEnvelope(Protocol.envelope('heartbeat', 'bounded-frame', {
            competition: { frame: frame(1, clock, Array.from({ length: 161 }, () => event(clock))) }
        }), 'worker').ok, false);
        assert.strictEqual(Protocol.validateEnvelope(Protocol.envelope('competition_release', 'bounded-receipt', {
            events: [], receipt: { frameId: 0, at: clock, status: 'accepted' }
        }), 'main').ok, false);
    });
    await check('lower and reused-different identities cannot replace an accepted watermark', async () => {
        const probe = main(), accepted = frame(2);
        await deliver(probe, accepted); await settled(probe);
        const beforeSent = probe.sent.length, beforeAdmission = probe.coordinator.competitionFrameAdmission;
        await deliver(probe, frame(1));
        clock++;
        await deliver(probe, frame(2));
        assert.deepStrictEqual(probe.calls, ['frame-2']);
        assert.strictEqual(probe.sent.length, beforeSent);
        assert.strictEqual(probe.coordinator.competitionFrameAdmission, beforeAdmission);
        await deliver(probe, frame(3)); await settled(probe);
        assert.deepStrictEqual(probe.calls, ['frame-2', 'frame-3']);
    });
    await check('actual task stop and Main stop fence both replay and late skipped release', async () => {
        const probe = main(), held = gate();
        const value = frame(1, clock, [0, 1, 2].map(i => event(clock, `stop-${i}`)));
        probe.coordinator.competitionActions.apply = async value => {
            probe.calls.push(value.key); await held.promise; return { ok: true };
        };
        let stopping;
        try {
            await deliver(probe, value);
            assert.strictEqual(receipt(probe, value)?.status, 'accepted');
            assert(probe.coordinator.competitionActions.running);
            const beforeSent = probe.sent.length;
            probe.coordinator.stopping = true;
            stopping = probe.coordinator.competitionActions.stop();
            await deliver(probe, value);
            assert.strictEqual(probe.sent.length, beforeSent);
        } finally { held.open(); if (stopping) await stopping; await settled(probe); }
        assert.deepStrictEqual(probe.calls, ['stop-0']);
        assert.strictEqual(probe.sent.filter(message => message.payload.events?.length).length, 0);
    });
    await check('admission watermark exists before a failed receipt send and retry installs no second task', async () => {
        const probe = main(), value = frame(1);
        const originalPost = probe.worker.postMessage;
        let drop = true;
        probe.worker.postMessage = message => {
            if (message.payload.receipt) {
                const admission = probe.coordinator.competitionFrameAdmission;
                assert(admission && admission.worker === probe.worker && admission.epoch === probe.coordinator.workerEpoch);
                assert.strictEqual(admission.frameId, value.frameId);
                assert.strictEqual(admission.status, 'accepted');
                if (drop) { drop = false; throw Error('fixture receipt send lost'); }
            }
            originalPost(message);
        };
        await assert.rejects(() => deliver(probe, value), /fixture receipt send lost/);
        await settled(probe);
        assert.deepStrictEqual(probe.calls, ['frame-1']);
        clock += 20000;
        await deliver(probe, value); await settled(probe);
        assert.deepStrictEqual(probe.calls, ['frame-1']);
        assert.strictEqual(receipt(probe, value)?.status, 'accepted');
    });
    assert.strictEqual(Database.isReady(), false);
    if (failures.length) throw Error(`${failures.length} frame-admission groups failed`);
    console.log('Competition frame Main/Protocol/task acceptance passed; no native/gameplay claim');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    for (const coordinator of instances) await coordinator.competitionActions.stop();
    Config.coldCompetitionActionsEnabled = initialActions;
    Date.now = originalNow;
});
