'use strict';

// Pure stream contract; generic providers do not establish native delivery.
const assert = require('node:assert/strict');
const path = require('node:path');
const sourceRoot = path.resolve(process.env.N53_GAME_ROOT || path.join(__dirname, '..'));
const { ColdTableChannel } = require(path.join(sourceRoot, 'src/GameServer/Bot/Population/ColdTableChannel'));
const Pages = require(path.join(sourceRoot, 'src/GameServer/Bot/Population/ColdMessagePages'));
const Protocol = require(path.join(sourceRoot, 'src/GameServer/Bot/Population/ColdSimulationProtocol'));
const TableMirror = require(path.join(sourceRoot, 'src/GameServer/Bot/Population/TableMirror'));
const Sources = require(path.join(sourceRoot, 'src/GameServer/World/CharacterActorSources'));
const UNKNOWN = 'CHARACTER_ACTOR_VIEW_UNKNOWN';
const publicSize = mirror => {
    try { return mirror.rows('actors').size; } catch (error) { return error.code; }
};
const originalImmediate = global.setImmediate;
const immediateDescriptor = Object.getOwnPropertyDescriptor(global, 'setImmediate');
const outcomes = [], fixtures = [], turnMetrics = [];
let currentTurn = null;
const tag = value => value === null ? { tag: 'null' } : { tag: typeof value, value };

function provider(count = 0, axis = id => id) {
    const rows = new Map(), issued = new WeakSet(), listeners = new Set();
    let publication = 0, worldGeneration = 1;
    let occurrence = Object.freeze({ generic: true, worldGeneration });
    const stats = { captures: 0, next: 0, resolves: 0, receipts: 0 };
    const add = (id, x = axis(id), notify = true) => {
        const ref = Object.freeze({ id, marker: Symbol('generic-source-ref') });
        const stamp = ++publication;
        const row = Object.freeze({ id, worldGeneration, sourceGeneration: stamp, publication: stamp,
            order: id, axes: Object.freeze({ x: Object.freeze(tag(x)), y: Object.freeze(tag(0)), z: Object.freeze(tag(0)) }) });
        issued.add(ref); rows.set(id, { ref, row });
        if (notify) for (const listener of listeners) listener.onDirty({ kind: 'dirty', ref });
        return ref;
    };
    for (let id = 1; id <= count; id++) add(id, axis(id), false);
    return {
        stats, rows, add,
        remove(id) {
            const old = rows.get(id); assert(old);
            rows.delete(id); publication++;
            for (const listener of listeners) listener.onDirty({ kind: 'dirty', ref: old.ref });
            return old.ref;
        },
        reset() {
            rows.clear(); publication++; worldGeneration++;
            occurrence = Object.freeze({ generic: true, worldGeneration });
            for (const listener of listeners) listener.onDirty({ kind: 'reset', occurrence });
        },
        subscribe(onDirty, onError) {
            assert.equal(typeof onDirty, 'function'); assert.equal(typeof onError, 'function');
            const listener = { onDirty, onError }; listeners.add(listener);
            return () => listeners.delete(listener);
        },
        currentOccurrence() { return occurrence; },
        capture() {
            stats.captures++;
            const captured = occurrence, iterator = rows.values(), countAtCapture = rows.size;
            const entries = { next() {
                stats.next++;
                if (captured !== occurrence) throw new Error('generic_occurrence_changed');
                const next = iterator.next();
                return next.done ? next : { done: false, value: next.value.ref };
            }, [Symbol.iterator]() { return this; } };
            return { count: countAtCapture, entries, bindingOccurrence: captured, worldGeneration };
        },
        resolve(ref, captured) {
            stats.resolves++;
            if (!issued.has(ref) || captured !== occurrence) return { kind: 'refused', error: new Error('generic_refusal') };
            const found = rows.get(ref.id);
            if (found) return { kind: 'put', occurrence, row: found.row,
                current() { stats.receipts++; return captured === occurrence && rows.get(ref.id) === found; } };
            const cutoff = publication;
            return { kind: 'remove', occurrence, row: { id: ref.id, worldGeneration, throughPublication: cutoff },
                current() { stats.receipts++; return captured === occurrence && publication === cutoff && !rows.has(ref.id); } };
        }
    };
}

function mirror() {
    const standalone = Sources.standalone(), value = new TableMirror();
    let backing;
    const owner = value.attachStore('actors', (owner, descriptor) => {
        backing = standalone.createStore(owner, descriptor);
        return backing;
    });
    const originalState = { characterId: 1, packet: 'independent pure source' };
    const stateRecord = { id: 1, source: originalState, phase: 'cold' };
    standalone.index.setSource(1, 'state', stateRecord, { indexed: false });
    return { value, backing, owner, index: standalone.index, conserve() {
        assert.equal(standalone.index.getSource(1, 'state'), stateRecord);
        assert.equal(stateRecord.source, originalState);
        assert.deepEqual(originalState, { characterId: 1, packet: 'independent pure source' });
    } };
}

function fixture(count, axis) {
    const source = provider(count, axis), channel = new ColdTableChannel(), receiver = mirror();
    const cold = Object.freeze({ genericColdTarget: true }), frames = [];
    const state = { source, channel, receiver, cold, frames, postErrors: [], postHook: null, accept: true, epoch: 'pure-1' };
    const post = (payload, bytes) => {
        try {
        if (payload.tables.some(piece => piece.name === 'actors')) {
            if (currentTurn) currentTurn.actorPosts++;
            const piece = payload.tables.find(piece => piece.name === 'actors');
            frames.push({ piece, bytes, accepted: state.accept, readyBefore: receiver.value.ready('actors') });
            if (!state.accept) return false;
            assert.equal(bytes, Protocol.byteLength(payload));
            assert(bytes <= Pages.PAGE_BYTES - 1024);
            assert(piece.rows.length + piece.removed.length <= 64);
        }
        assert.deepEqual(receiver.value.apply(payload.tables), []);
        state.postHook?.(payload);
        return true;
        } catch (error) {
            state.postErrors.push(error);
            throw error;
        }
    };
    state.post = post;
    channel.register('actors', { key: ref => ref.id, eventDriven: true, streamed: { recipient: 'cold', source } });
    fixtures.push(state);
    return state;
}

function attach(state, post = state.post, epoch = state.epoch) {
    state.channel.attach(state.cold, epoch, post, { streamedTables: ['actors'] });
}
async function turns(count) {
    for (let at = 0; at < count; at++) await new Promise(resolve => originalImmediate(resolve));
}
async function settle(state) {
    for (let at = 0; at < 1000; at++) {
        await turns(1);
        if (!state.channel.actorRecipient?.job && !state.channel.actorRecipient?.table.pending.size) return;
    }
    assert.fail('bounded future fixture did not settle');
}
function cleanCopy(receiver) {
    for (let at = 0; at < 20 && !receiver.value.ready('actors'); at++) {
        const report = receiver.value.cleanupStore('actors', 64);
        assert(report.inspected <= 64);
        if (report.done) break;
    }
    assert.equal(receiver.value.ready('actors'), true);
}
function matches(state) {
    cleanCopy(state.receiver); state.receiver.conserve();
    assert.deepEqual(Array.from(state.receiver.backing.keys()).sort((a, b) => a - b),
        Array.from(state.source.rows.keys()).sort((a, b) => a - b));
    for (const [id, original] of state.source.rows) assert.equal(state.receiver.backing.get(id), original.row);
}
async function check(name, action) {
    await action();
    for (const state of fixtures) {
        state.receiver.conserve();
        assert.deepEqual(state.postErrors, [], 'callback errors cannot be swallowed into a fixture PASS');
    }
    outcomes.push(name);
}

async function main() {
    // Scheduling observer DELEGATES the original primitive. It stores scalar
    // work evidence, never runs a fake scheduler or supplies Native authority.
    global.setImmediate = function(callback, ...args) {
        return Reflect.apply(originalImmediate, this, [function(...invokeArgs) {
            const before = fixtures.map(state => ({ inspections: state.channel.actorStats.inspections,
                receipts: state.channel.actorStats.receiptChecks, resolves: state.source.stats.resolves }));
            const saved = currentTurn, metric = { actorPosts: 0, work: [] }; currentTurn = metric;
            try { return Reflect.apply(callback, this, invokeArgs); }
            finally {
                for (let at = 0; at < before.length; at++) metric.work.push({
                    inspections: fixtures[at].channel.actorStats.inspections - before[at].inspections,
                    receipts: fixtures[at].channel.actorStats.receiptChecks - before[at].receipts,
                    resolves: fixtures[at].source.stats.resolves - before[at].resolves });
                turnMetrics.push(metric); currentTurn = saved;
            }
        }, ...args]);
    };
    await check('default_ordinary_and_clan_do_not_capture_optional_actors', async () => {
        const state = fixture(4), ordinary = new TableMirror(), original = { id: 7, value: 'ordinary original' };
        state.channel.register('ordinary', { key: row => row.id, allRows: () => [original] });
        state.channel.attach('pure-clan', 'clan-1', payload => {
            assert(payload.tables.every(piece => piece.name !== 'actors'));
            assert.deepEqual(ordinary.apply(payload.tables), []); return true;
        });
        assert.equal(state.source.stats.captures, 0);
        assert.equal(ordinary.rows('ordinary').get(7), original);
        assert.equal(ordinary.version('ordinary'), 0);
        const changed = { id: 7, value: 'ordinary delta' };
        state.channel.changed('ordinary', changed); state.channel.flush();
        assert.equal(ordinary.rows('ordinary').get(7), changed); assert.equal(ordinary.version('ordinary'), 1);
        state.channel.detach('pure-clan'); attach(state); await settle(state); matches(state);
    });
    await check('bounded_257_live_refs_original_store_and_no_ready_prefix', async () => {
        const state = fixture(257); attach(state); await settle(state); matches(state);
        const frames = state.frames.map(frame => frame.piece);
        assert.equal(frames[0].full, true); assert.equal(frames[0].last, 0); assert.equal(frames[0].rows.length, 0);
        assert.equal(frames.at(-1).last, 1);
        assert.equal(frames.at(-1).rows.length + frames.at(-1).removed.length, 0);
        assert(state.frames.every(frame => frame.readyBefore === false));
        assert.equal(state.source.stats.captures, 1); assert.equal(state.source.stats.next, 257);
        assert.equal(state.channel.actorStats.inspections, 257);
        const publicRows = state.receiver.value.rows('actors');
        assert.equal(state.receiver.value.tables.get('actors').rows, publicRows);
        assert.notEqual(publicRows, state.receiver.backing);
        assert.equal(Sources.actorStoreMatches(state.receiver.owner, state.receiver.backing), true);
    });
    await check('live_capture_churn_cutoff_and_post_cut_new_ids', async () => {
        const state = fixture(130); let baseline = false, cut = false;
        state.postHook = payload => {
            const piece = payload.tables.find(value => value.name === 'actors');
            if (!piece || piece.full || piece.last) return;
            if (!baseline && piece.rows.length) {
                baseline = true; state.source.add(1, 101); state.source.remove(1);
                state.source.remove(2); state.source.add(131, 131);
            } else if (baseline && !cut && piece.removed.length) {
                cut = true; state.source.add(1, 202); state.source.add(132, 132);
            }
        };
        attach(state); await settle(state); matches(state);
        assert.equal(baseline, true); assert.equal(cut, true);
        assert.equal(state.receiver.backing.has(2), false);
        assert.equal(state.receiver.backing.get(1), state.source.rows.get(1).row);
        assert(state.frames.some(frame => frame.piece.from !== null && frame.piece.to > frame.piece.from));
    });
    await check('byte_split_retains_original_refs_and_rederives_bounded_carry', async () => {
        const state = fixture(64, () => '8'.repeat(6000)); attach(state); await settle(state); matches(state);
        assert(state.frames.filter(frame => frame.piece.rows.length).length > 1);
        assert(state.source.stats.resolves > 64, 'byte carry re-derives original refs on another turn');
        assert(state.frames.every(frame => frame.bytes <= Pages.PAGE_BYTES - 1024));
    });
    await check('same_epoch_current_post_refresh_continues_exact_loading_job', async () => {
        const state = fixture(130); let oldCalls = 0, newCalls = 0;
        const replacementPost = (...args) => { newCalls++; return state.post(...args); };
        const oldPost = (...args) => {
            oldCalls++; const accepted = state.post(...args);
            if (oldCalls === 1) attach(state, replacementPost);
            return accepted;
        };
        attach(state, oldPost); await settle(state); matches(state);
        assert.equal(oldCalls, 1); assert(newCalls > 1);
        assert.equal(state.source.stats.captures, 1);
    });
    await check('failed_posts_one_real_flush_retry_not_ordinary_success_or_loop', async () => {
        const state = fixture(4); state.accept = false; attach(state); await turns(4);
        assert.equal(state.source.stats.captures, 1); assert.equal(state.frames.length, 1);
        assert.equal(state.channel.targets.get(state.cold).suspended, true);
        state.channel.flush();
        assert.equal(state.channel.targets.get(state.cold).retried, true);
        state.channel.register('ordinary', { key: row => row.id, allRows: () => [{ id: 8 }] });
        state.channel.flush();
        assert.equal(state.channel.targets.get(state.cold).retried, true, 'ordinary success does not release actor retry');
        await turns(4); assert.equal(state.source.stats.captures, 2); assert.equal(state.frames.length, 2);
        state.channel.flush(); await turns(3); assert.equal(state.source.stats.captures, 2);
        state.accept = true; state.channel.resync(state.cold, state.epoch, ['actors']);
        await settle(state); matches(state); assert.equal(state.source.stats.captures, 3);
    });
    await check('reset_cancels_old_copy_and_finite_old_store_cleanup', async () => {
        const state = fixture(130); attach(state); await settle(state); matches(state);
        const oldCount = state.receiver.backing.size;
        state.source.reset(); state.source.add(201, 201);
        await settle(state);
        assert.equal(state.receiver.value.ready('actors'), false);
        const first = state.receiver.value.cleanupStore('actors', 64);
        assert.equal(first.inspected, 64); assert.equal(first.done, false);
        matches(state); assert.equal(state.receiver.backing.size, 1); assert.equal(oldCount, 130);
    });
    await check('stop_same_epoch_resync_detach_and_new_epoch_fence_continuations', async () => {
        const state = fixture(130); let stopped = false;
        state.postHook = payload => {
            if (!stopped && payload.tables.some(piece => piece.name === 'actors' && piece.full)) {
                stopped = true; state.channel.stopActorRecipient(state.cold, state.epoch);
            }
        };
        attach(state); await turns(4); assert.equal(stopped, true); assert.equal(state.frames.length, 1);
        attach(state); state.channel.resync(state.cold, state.epoch, ['actors']); await turns(3);
        assert.equal(state.frames.length, 1); assert.equal(state.channel.actorRecipient.stopped, true);
        state.channel.detach(state.cold); state.postHook = null; state.epoch = 'pure-2';
        attach(state); await settle(state); matches(state);
        assert.equal(state.frames.filter(frame => frame.piece.last === 1).length, 1);
    });
    await check('single_oversize_is_unknown_not_skipped_terminal_ready', async () => {
        const state = fixture(1, () => 'é'.repeat(130000)); attach(state); await turns(4);
        assert.equal(state.channel.targets.get(state.cold).suspended, true);
        assert.equal(state.frames.length, 1); assert.equal(state.frames[0].piece.last, 0);
        assert.equal(state.receiver.value.ready('actors'), false);
        assert.equal(state.receiver.backing.size, 0);
    });
    await check('actual_Mirror_owner_gap_and_whole_apply_prefix_barrier', async () => {
        const state = fixture(4); attach(state); await settle(state); matches(state);
        const observed = [];
        state.receiver.value.watch('ordinary', { reset() {}, put() { observed.push([state.receiver.value.ready('actors'),
            publicSize(state.receiver.value)]); }, remove() {} });
        const descriptor = state.receiver.value.tables.get('actors'), oldChain = descriptor.chain;
        const lastVersion = state.receiver.value.version('actors');
        assert.deepEqual(state.receiver.value.apply([{ name: 'ordinary', from: null, to: 1, full: true, last: 1,
            rows: [[1, { first: true }]], removed: [] }, { name: 'actors', from: lastVersion + 2, to: lastVersion + 3,
            full: false, last: 1, attachmentId: oldChain.attachmentId, copyId: oldChain.copyId,
            transferId: oldChain.transferId + 1, pageIndex: 0, worldGeneration: oldChain.worldGeneration,
            rows: [], removed: [] }]), ['actors']);
        assert.deepEqual(observed, [[false, UNKNOWN]]);
        assert.equal(state.receiver.value.ready('actors'), false);
        assert.throws(() => state.receiver.value.rows('actors').size, { code: UNKNOWN });
        assert.equal(state.receiver.backing.size, 4);
        state.channel.resync(state.cold, state.epoch, ['actors']); await settle(state); matches(state);
    });
    await check('whole_actor_apply_prefix_errors_quarantine_and_preserve_thrown_identity', async () => {
        const state = fixture(4); attach(state); await settle(state); matches(state);
        for (const originalError of [new Error('ordinary prefix failure'), undefined, null, 0]) {
            const backingRows = Array.from(state.receiver.backing.entries());
            state.receiver.value.watch('ordinary', { reset() {}, put() { throw originalError; }, remove() {} });
            const table = state.receiver.value.tables.get('actors'), chain = table.chain, version = table.version;
            let threw = false, caught;
            try {
                state.receiver.value.apply([{ name: 'ordinary', from: null, to: 1, full: true, last: 1,
                    rows: [[1, { ordinaryPrefix: true }]], removed: [] }, { name: 'actors', from: version, to: version + 1,
                    full: false, last: 1, attachmentId: chain.attachmentId, copyId: chain.copyId,
                    transferId: chain.transferId + 1, pageIndex: 0, worldGeneration: chain.worldGeneration,
                    rows: [], removed: [] }]);
            } catch (error) { threw = true; caught = error; }
            assert.equal(threw, true); assert.equal(caught, originalError);
            assert.equal(state.receiver.value.ready('actors'), false);
            assert.throws(() => state.receiver.value.rows('actors').size, { code: UNKNOWN });
            assert.equal(table.applyInProgress, false); assert.equal(table.waiting, true);
            assert.equal(table.chain, chain); assert.equal(table.version, version);
            assert.deepEqual(Array.from(state.receiver.backing.entries()), backingRows);
            state.receiver.conserve();
            state.receiver.value.watch('ordinary', { reset() {}, put() {}, remove() {} });
            state.channel.resync(state.cold, state.epoch, ['actors']); await settle(state); matches(state);
        }
    });
    for (const metric of turnMetrics) {
        assert(metric.actorPosts <= 1, 'one actor dispatch per observed real immediate');
        for (const work of metric.work) {
            assert(work.inspections <= 64); assert(work.receipts <= 64); assert(work.resolves <= 64);
        }
    }
    assert.equal(outcomes.length, 11);
    console.log(JSON.stringify({ scope: 'FUTURE PURE generic source/channel/pages + actual standalone store only',
        outcomes, groups: outcomes.length, observedTurns: turnMetrics.length,
        nativeIssuer: false, Worker: false, RuntimeAuthorization: false, advertisedReadGO: false }));
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    Object.defineProperty(global, 'setImmediate', immediateDescriptor);
    for (const state of fixtures) {
        state.channel.detach(state.cold); state.receiver.conserve();
        state.receiver.value.detachStore('actors'); state.receiver.index.clear();
        assert.equal(state.receiver.index.sourceSize('actor'), 0);
        assert.equal(state.receiver.index.sourceSize('state'), 0);
    }
    console.log(JSON.stringify({ cleanup: 'isolated pure backing only', restoredImmediate: global.setImmediate === originalImmediate,
        filesWritten: 0, gameModules: 0, SQL: 0, Worker: 0, nativeActorAttachment: false }));
});
