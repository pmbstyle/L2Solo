'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const gameRoot = process.env.N53_GAME_ROOT || path.resolve(__dirname, '..');
require(path.join(gameRoot, 'src/Global'));
const directory = fs.mkdtempSync(path.resolve(__dirname, '../tmp/actor-location-publication-'));
const paths = { world: path.join(directory, 'world.sqlite'), history: path.join(directory, 'history.sqlite') };
const previousPaths = { world: options.default.Database.path, history: options.default.Database.historyPath };
options.default.Database.path = paths.world;
options.default.Database.historyPath = paths.history;
const World = invoke('GameServer/World/World');
const Actor = invoke('GameServer/Model/Actor');
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Runtime = require(path.join(gameRoot, 'src/GameServer/World/CharacterLocationRuntime'));
const previousUser = World.user, originalUpdate = World.updateUserLocation;
const calls = [], observations = [], failures = [];
let serial = 9800000;
World.updateUserLocation = function (session, actor = session?.actor) {
    calls.push({ actor, session, point: { locX: actor?.fetchLocX?.(), locY: actor?.fetchLocY?.(), locZ: actor?.fetchLocZ?.() },
        head: actor?.fetchHead?.() });
    actor?.trace?.push('publish');
    return Reflect.apply(originalUpdate, this, [session, actor]);
};
function reset() { World.user = { sessions: [], revision: 0 }; }
function member({ id = ++serial, account = `player_location_${++serial}`, Model = Actor, ...flags } = {}) {
    const session = { ...flags, accountId: account, fetchAccountId() { return this.accountId; },
        socket: { destroy() { session.destroyed = true; } }, dataSendToMe() {}, dataSendToOthers() {}, dataSendToMeAndOthers() {} };
    session.actor = new Model({ id, name: account, username: account, clanId: 0, isOnline: false,
        locX: 0, locY: 0, locZ: 0, head: 10, hp: 100, maxHp: 100, mp: 100, maxMp: 100 });
    session.actor.session = session;
    World.insertUser(session); session.actor.setIsOnline(true);
    return session;
}
function publication(action) { calls.length = 0; action(); return [...calls]; }
function near(loc) { return World.realPlayerSessionsNear(loc, 1); }
function originalAt(session, loc, label) { assert(near(loc).includes(session), `${label}: current original session at current XY`); }
function observed(name, data = {}) { observations.push({ name, ...data }); console.log(`PASS ${name}`); }
function target(label, action) {
    try { action(); }
    catch (error) {
        failures.push({ label, name: error.name, code: error.code || null, message: error.message,
            actual: error.actual, expected: error.expected });
        console.log(`TARGET RED ${label}: ${error.message}`);
    }
}
class TracingActor extends Actor {
    setLocX(value) { this.trace?.push('X'); return super.setLocX(value); }
    setLocY(value) { this.trace?.push('Y'); return super.setLocY(value); }
    setLocZ(value) { this.trace?.push('Z'); return super.setLocZ(value); }
    setHead(value) { this.trace?.push('H'); return super.setHead(value); }
}
class NestedActor extends TracingActor {
    setLocX(value) {
        const result = super.setLocX(value);
        if (this.runNested) {
            this.runNested = false;
            this.setLocXYZ({ locX: value + 1, locY: 22, locZ: 33 });
        }
        return result;
    }
}
class CaughtInnerActor extends TracingActor {
    setLocX(value) {
        const result = super.setLocX(value);
        if (this.innerFailure) {
            const failure = this.innerFailure;
            this.innerFailure = null;
            try {
                this.setLocXYZ({ locX: value + 1, get locY() { throw failure; }, locZ: 33 });
            } catch (error) {
                this.caughtError = error;
            }
        }
        return result;
    }
}
class ThrowingHeadActor extends TracingActor {
    setHead(value) {
        if (this.headFailure) {
            this.trace?.push('H');
            throw this.headFailure;
        }
        return super.setHead(value);
    }
}
class OtherActorWriter extends TracingActor {
    setLocX(value) {
        const result = super.setLocX(value);
        if (this.otherActor) {
            const other = this.otherActor;
            this.otherActor = null;
            other.setLocXYZ({ locX: 36000, locY: 12000, locZ: 0 });
        }
        return result;
    }
}

try {
    assert.equal(Database.isReady(), false);
    reset();
    const current = member(), actor = current.actor, record = World.registeredActorById(actor.fetchId());
    originalAt(current, { locX: 0, locY: 0, locZ: 0 }, 'actual registration positive');
    const firstPoint = { locX: 12000, locY: 0, locZ: 10 };
    const xyz = publication(() => assert.equal(actor.setLocXYZ(firstPoint), undefined));
    assert.equal(xyz.length, 1); assert.equal(xyz[0].actor, actor); assert.equal(xyz[0].session, current);
    assert.deepEqual(xyz[0].point, firstPoint);
    originalAt(current, firstPoint, 'native XYZ after cell crossing');
    assert.equal(World.registeredActorById(record.id), record);
    const secondPoint = { locX: 24000, locY: 12000, locZ: 20 };
    const xyzh = publication(() => assert.equal(actor.setLocXYZH({ ...secondPoint, head: 444 }), undefined));
    assert.equal(xyzh.length, 1); assert.deepEqual(xyzh[0].point, secondPoint);
    assert.equal(xyzh[0].head, 10, 'inherited XYZH publishes XYZ before its virtual head setter');
    assert.equal(actor.fetchHead(), 444);
    originalAt(current, secondPoint, 'native XYZH after cell crossing');
    assert.equal(World.registeredActorById(record.id), record);
    observed('actual registered XYZ/XYZH current query and original token; one publish per native batch', { xyz: xyz.length, xyzh: xyzh.length });

    const tracing = member({ Model: TracingActor });
    tracing.actor.trace = [];
    const virtual = publication(() => tracing.actor.setLocXYZ({ locX: 12000, locY: 0, locZ: 0 }));
    assert.equal(virtual.length, 1); assert.deepEqual(tracing.actor.trace, ['X', 'Y', 'Z', 'publish']);
    tracing.actor.trace = [];
    const virtualHead = publication(() => tracing.actor.setLocXYZH({ locX: 24000, locY: 0, locZ: 0, head: 99 }));
    assert.equal(virtualHead.length, 1); assert.deepEqual(tracing.actor.trace, ['X', 'Y', 'Z', 'publish', 'H']);
    originalAt(tracing, { locX: 24000, locY: 0, locZ: 0 }, 'virtual dispatch positive');
    observed('super XYZ preserves virtual X/Y/Z and inherited head order', { xyzTrace: ['X', 'Y', 'Z', 'publish'], xyzhTrace: [...tracing.actor.trace] });

    const thrown = new Error('location-Y-access-failed');
    calls.length = 0;
    assert.throws(() => tracing.actor.setLocXYZ({ locX: 36000, get locY() { throw thrown; }, locZ: 0 }), error => error === thrown);
    assert.equal(tracing.actor.fetchLocX(), 36000, 'failed batch retains native partial model mutation; no invented rollback');
    assert.equal(calls.length, 0, 'existing XYZ publishes only after successful super XYZ');
    const recovery = publication(() => tracing.actor.setLocXYZ({ locX: 12000, locY: 0, locZ: 0 }));
    assert.equal(recovery.length, 1); originalAt(tracing, { locX: 12000, locY: 0, locZ: 0 }, 'healthy recovery after exact thrown object');
    observed('batch throw identity/partial mutation/no publication and next native recovery', { partialX: 36000, failedPublishes: 0, recoveryPublishes: 1 });

    const nested = member({ Model: NestedActor }); nested.actor.trace = []; nested.actor.runNested = true;
    const nestedCalls = publication(() => nested.actor.setLocXYZ({ locX: 12000, locY: 4, locZ: 5 }));
    assert.equal(nestedCalls.length, 1, 'completed outer XYZ coalesces nested publication; immutable BEFORE observed two');
    assert.deepEqual(nested.actor.trace, ['X', 'X', 'Y', 'Z', 'Y', 'Z', 'publish']);
    assert.deepEqual([nested.actor.fetchLocX(), nested.actor.fetchLocY(), nested.actor.fetchLocZ()], [12001, 4, 5]);
    originalAt(nested, { locX: 12001, locY: 4, locZ: 5 }, 'nested virtual dispatch keeps actual final original model');
    observed('nested XYZ virtual dispatch/final model preserved; completed outer publishes once', { publishes: 1, finalXYZ: [12001, 4, 5] });

    const caught = member({ Model: CaughtInnerActor }), innerError = new Error('nested-Y-access-failed');
    caught.actor.trace = []; caught.actor.innerFailure = innerError;
    const caughtCalls = publication(() => caught.actor.setLocXYZ({ locX: 12000, locY: 4, locZ: 5 }));
    assert.equal(caught.actor.caughtError, innerError); assert.equal(caughtCalls.length, 1);
    assert.deepEqual(caught.actor.trace, ['X', 'X', 'Y', 'Z', 'publish']);
    assert.deepEqual([caught.actor.fetchLocX(), caught.actor.fetchLocY(), caught.actor.fetchLocZ()], [12001, 4, 5]);
    originalAt(caught, { locX: 12001, locY: 4, locZ: 5 }, 'caught inner error leaves successful outer current');
    observed('caught inner original throw restores outer depth; final completed model publishes once');

    const worldFailure = member(), observer = World.updateUserLocation;
    let nativeWorldError;
    World.updateUserLocation = function (...args) {
        try { return Reflect.apply(observer, this, args); }
        catch (error) { nativeWorldError = error; throw error; }
    };
    try {
        const attempted = publication(() => assert.throws(() => worldFailure.actor.setLocXYZ({ locX: 1e100, locY: 0, locZ: 0 }),
            error => error === nativeWorldError && error instanceof RangeError && error.message === 'invalid_character_cell'));
        assert.equal(attempted.length, 1); assert.equal(worldFailure.actor.fetchLocX(), 1e100);
        const recovered = publication(() => assert.equal(worldFailure.actor.setLocX(0), undefined));
        assert.equal(recovered.length, 1); originalAt(worldFailure, { locX: 0, locY: 0, locZ: 0 }, 'direct recovery after native World exception');
        observed('actual World strict-cell throw identity preserved; completed model not rolled back and depth restored',
            { error: nativeWorldError.message, failedAttempts: attempted.length, directRecovery: recovered.length });
    } finally { World.updateUserLocation = observer; }

    const head = member({ Model: ThrowingHeadActor }), headError = new Error('head-setter-failed');
    head.actor.trace = []; head.actor.headFailure = headError;
    const headCalls = publication(() => assert.throws(() => head.actor.setLocXYZH({ locX: 36000, locY: 0, locZ: 0, head: 777 }),
        error => error === headError));
    assert.equal(headCalls.length, 1); assert.equal(headCalls[0].head, 10); assert.equal(head.actor.fetchHead(), 10);
    assert.deepEqual(head.actor.trace, ['X', 'Y', 'Z', 'publish', 'H']);
    originalAt(head, { locX: 36000, locY: 0, locZ: 0 }, 'completed XYZ remains published before throwing head');
    head.actor.headFailure = null;
    assert.equal(publication(() => head.actor.setLocXYZH({ locX: 12000, locY: 0, locZ: 0, head: 22 })).length, 1);
    assert.equal(head.actor.fetchHead(), 22);
    observed('inherited XYZH publishes completed XYZ before exact head throw; next head update recovers');

    const other = member(), independent = member({ Model: OtherActorWriter });
    independent.actor.trace = []; independent.actor.otherActor = other.actor;
    const independentCalls = publication(() => independent.actor.setLocXYZ({ locX: 12000, locY: 12, locZ: 0 }));
    assert.equal(independentCalls.length, 2);
    assert.equal(independentCalls[0].actor, other.actor); assert.equal(independentCalls[1].actor, independent.actor);
    assert.deepEqual(independent.actor.trace, ['X', 'Y', 'Z', 'publish']);
    originalAt(other, { locX: 36000, locY: 12000, locZ: 0 }, 'other actor batch publishes during first actor depth');
    originalAt(independent, { locX: 12000, locY: 12, locZ: 0 }, 'first actor completed outer publication');
    observed('depth is per actor; other actor publishes independently inside virtual outer dispatch');

    const accepted = Life.acceptLifecycleRow({ characterId: record.id, phase: 'cold', activity: 'hunting', level: 10,
        hp: 37, mp: 31, locX: 72000, locY: 0, locZ: 0, updatedAt: 1 });
    const stateRecord = Runtime.index.getSource(record.id, 'state'), stateBefore = structuredClone(accepted);
    assert.equal(stateRecord.source, accepted); assert.equal(Life.cachedState(record.id), accepted);
    const stateConserved = () => {
        assert.equal(Runtime.index.getSource(record.id, 'state'), stateRecord);
        assert.equal(Life.cachedState(record.id), accepted); assert.deepEqual(accepted, stateBefore);
    };
    for (const [method, value, point] of [
        ['setLocX', 48000, { locX: 48000, locY: 0, locZ: 0 }],
        ['setLocY', 48000, { locX: 0, locY: 48000, locZ: 0 }]
    ]) {
        publication(() => actor.setLocXYZ({ locX: 0, locY: 0, locZ: 0 }));
        originalAt(current, { locX: 0, locY: 0, locZ: 0 }, `${method} healthy prepared origin`);
        const direct = publication(() => assert.equal(actor[method](value), undefined));
        assert.equal(actor[method === 'setLocX' ? 'fetchLocX' : 'fetchLocY'](), value);
        assert.equal(World.registeredActorById(record.id), record); stateConserved();
        const result = near(point);
        observations.push({ name: method, nativePublishes: direct.length, currentOriginalFound: result.includes(current),
            sameRecordAndStateConserved: true, targetXYZ: point });
        console.log(`OBS ${method} publishes=${direct.length} currentOriginalFound=${result.includes(current)}`);
        target(`${method} publishes once`, () => assert.equal(direct.length, 1));
        target(`${method} current index follows cell crossing`, () => assert(result.includes(current)));
    }
    const invalidZPoint = { locX: 0, locY: 0, locZ: NaN };
    assert.equal(publication(() => actor.setLocXYZ(invalidZPoint)).length, 1);
    assert(!near({ locX: 0, locY: 0, locZ: 0 }).includes(current), 'actual XYZ NaN clears first-reader player eligibility');
    const zCalls = publication(() => assert.equal(actor.setLocZ(0), undefined));
    assert.equal(actor.fetchLocZ(), 0); assert.equal(World.registeredActorById(record.id), record); stateConserved();
    const zResult = near({ locX: 0, locY: 0, locZ: 0 });
    observations.push({ name: 'setLocZ', nativePublishes: zCalls.length, currentOriginalFound: zResult.includes(current), sameRecordAndStateConserved: true });
    console.log(`OBS setLocZ publishes=${zCalls.length} currentOriginalFound=${zResult.includes(current)}`);
    target('setLocZ publishes once', () => assert.equal(zCalls.length, 1));
    target('setLocZ NaN→finite restores current first-reader membership', () => assert(zResult.includes(current)));
    assert.equal(publication(() => actor.setLocXYZ({ locX: 0, locY: 0, locZ: 0 })).length, 1);
    originalAt(current, { locX: 0, locY: 0, locZ: 0 }, 'batch restores public-setter missing memberships'); stateConserved();

    const companion = member({ account: `bot_location_companion_${++serial}`, partyCompanion: true, followPlayerSession: current });
    const companionRecord = World.registeredActorById(companion.actor.fetchId());
    assert.equal(publication(() => companion.actor.setLocXYZ({ locX: 12000, locY: 0, locZ: 0 })).length, 1);
    assert(Runtime.index.nearSources({ locX: 12000, locY: 0, locZ: 0 }, 1, { view: 'actor' }).includes(companionRecord));
    assert(!near({ locX: 12000, locY: 0, locZ: 0 }).includes(companion), 'companion bot account keeps existing first-reader classifier');
    assert.equal(companion.followPlayerSession, current); assert.equal(companion.partyCompanion, true); stateConserved();
    observed('companion original/current classification and independent accepted state unchanged');

    const displaced = member(), replacement = member({ id: displaced.actor.fetchId() });
    const replacementRecord = World.registeredActorById(replacement.actor.fetchId());
    displaced.actor.setLocX(60000); displaced.actor.setLocY(60000); displaced.actor.setLocZ(NaN);
    displaced.actor.setLocXYZ({ locX: 60000, locY: 60000, locZ: 0 });
    assert.equal(World.registeredActorById(replacementRecord.id), replacementRecord);
    originalAt(replacement, { locX: 0, locY: 0, locZ: 0 }, 'displaced late source does not alter current replacement');
    World.removeUser(replacement); replacement.actor.setLocX(60000); replacement.actor.setLocXYZ({ locX: 60000, locY: 0, locZ: 0 });
    assert.equal(World.registeredActorById(replacementRecord.id), null);
    const oldUser = World.user; reset();
    actor.setLocX(60000); actor.setLocY(60000); actor.setLocZ(NaN); actor.setLocXYZ({ locX: 60000, locY: 60000, locZ: 0 });
    assert.equal(World.registeredActorById(record.id), null); stateConserved();
    World.user = oldUser;
    assert.equal(World.registeredActorById(record.id), null); stateConserved();
    observed('late displaced/removed/reset setters do not resurrect actor sources or touch state');
    assert.equal(Database.isReady(), false); assert.deepEqual(fs.readdirSync(directory), []);
    console.log('OBSERVATIONS ' + JSON.stringify(observations));
    assert.equal(failures.length, 0, `public setter publication/index target failures: ${JSON.stringify(failures)}`);
} finally {
    World.updateUserLocation = originalUpdate;
    const cleanup = { databaseReady: Database.isReady(), filesCreated: fs.readdirSync(directory), generatedPaths: paths };
    World.user = previousUser;
    options.default.Database.path = previousPaths.world; options.default.Database.historyPath = previousPaths.history;
    fs.rmSync(directory, { recursive: true, force: true });
    Object.assign(cleanup, { directoryRemoved: !fs.existsSync(directory), previousWorldRestored: World.user === previousUser,
        publicationObserverRestored: World.updateUserLocation === originalUpdate,
        worldAndHistoryAbsent: !fs.existsSync(paths.world) && !fs.existsSync(paths.history), workerCreated: false });
    const loadedSources = Object.keys(require.cache).filter(filename => filename.startsWith(path.join(gameRoot, 'src') + path.sep))
        .map(filename => ({ path: filename, sha256: crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex') }));
    if (process.env.N62_SETTER_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.N62_SETTER_EVIDENCE_DIR, 'observations.json'),
        JSON.stringify({ observations, targetFailures: failures, cleanup, loadedSources }, null, 2) + '\n');
    console.log('CLEANUP ' + JSON.stringify(cleanup));
}
