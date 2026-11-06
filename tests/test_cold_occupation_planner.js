'use strict';
const assert = require('node:assert/strict');
// The card's echo check reads the economy's sections (invoke-loaded modules).
require('../src/Global');
require('../src/GameServer/Bot/Population/PopulationConfig').developerDiagnostics = true;
const { ColdOccupationPlanner } = require('../src/GameServer/Bot/Population/ColdOccupationPlanner');
const { compact, capture, ColdEconomyDecisions, stateEcho } = require('../src/GameServer/Bot/Population/ColdEconomyDecision');

const posted = [], tokens = new Map(), callbacks = [], working = [];
const planner = new ColdOccupationPlanner({ schedule: callback => callbacks.push(callback), now: () => 0,
    onWorking: count => working.push(count),
    sourceToken: id => tokens.get(id) || 0, capture: (id, input, read) => { read(id); return { id, input }; },
    create: captured => ({ captured, stage: 1, units: 0 }), step: cursor => ++cursor.units === 100,
    result: cursor => ({ known: true, recipeId: cursor.captured.id, productId: 100 + cursor.captured.id,
        incomePerHour: 10, cycleHours: 1 }), publish: (...args) => posted.push(args) });
for (let id = 1; id <= 65; id++) planner.request(id, { id }, { awaitResult: false });
for (let portion = 0; portion < 8; portion++) {
    callbacks.shift()();
    assert(planner.stats.maxPortionUnits <= 32);
    assert(planner.slots.size <= 64);
}
assert.equal(planner.slots.size, 64);
assert.equal(planner.workingContexts, 64, 'all unfinished graphs reserve the shared review allowance');
assert.equal(planner.waiting.size, 1, 'incomplete contexts remain pinned');
const first = planner.entry(1).work;
callbacks.shift()();
assert.strictEqual(planner.entry(1).work, first, 'capacity pressure cannot evict incomplete scratch');
assert(planner.stats.capacityDeferrals > 0);
tokens.set(999, 1); planner.sourceChanged(999);
assert.equal(planner.stats.invalidations, 0, 'an unrelated item is not a dependency');
tokens.set(1, 1); planner.sourceChanged(1); planner.sourceChanged(1);
assert.equal(planner.stats.invalidations, 1);
tokens.set(1, 2); planner.sourceChanged(1);
assert.equal(planner.stats.invalidations, 2, 'each distinct newer used revision restarts scratch');
let guard = 0;
while (planner.entry(1).work === first && guard++ < 64) callbacks.shift()();
assert.notStrictEqual(planner.entry(1).work, first);
assert.equal(planner.entry(1).cursor.byteLength, 128);
while ((planner.ready.size || planner.waiting.size) && guard++ < 2000) callbacks.shift()();
assert.equal(planner.ready.size, 0); assert.equal(planner.waiting.size, 0);
assert.equal(posted.filter(row => row[0] === 65).length, 1, 'FIFO waiter eventually progresses');
assert.equal(planner.slots.size, 0, 'finished answers leave the working pool');
assert.equal(planner.cards.size, 65, 'each owner keeps its finished answer as a card');
assert.equal(planner.workingContexts, 0, 'completed scalar cards do not disable the economic review cache');
assert.equal(working.at(-1), 0);
assert(working.every(count => count >= 0 && count <= 64), 'the graph reservation remains bounded through eviction and restarts');
// A replaced source table rechecks the done slots: only a slot whose read token moved restarts.
const before = planner.stats.invalidations, doneSlots = [...planner.cards.values()].filter(entry => entry.reads?.size && !entry.dirty);
planner.recheckSources();
assert.equal(planner.stats.invalidations, before, 'a replaced table with the same tokens restarts nothing');
const movedId = doneSlots[0].id;
tokens.set(movedId, (tokens.get(movedId) || 0) + 7);
planner.recheckSources();
assert.equal(planner.stats.invalidations, before + 1, 'only the slot that read the moved item restarts');
assert(planner.entry(movedId).dirty && doneSlots.slice(1).every(entry => !entry.dirty));
planner.stop(); assert.equal(planner.slots.size + planner.cards.size, 0); assert.equal(planner.dependencies.size, 0);

// One job per bot per mode, kept as a card on its input key: an ask of
// another mode keeps it, the same key gets it back with no build, another
// key builds; finished cards hold no working context.
let modeBuilds = 0;
const modal = new ColdOccupationPlanner({ schedule: () => {}, now: () => 0, sourceToken: () => 0,
    inputKey: input => `${input.value}`, capture: (id, input) => input, create: input => ({ input, build: ++modeBuilds }),
    step: () => true, result: work => ({ known: true, mode: work.input.mode, value: work.input.value, build: work.build }) });
const settle = () => { while (modal.waiting.size || modal.ready.size) modal.portion(); };
modal.request(5, { mode: 'occupation', value: 1 }, { awaitResult: false }); settle();
const occupationAnswer = modal.entry(5, 'occupation').value;
modal.request(5, { mode: 'action', value: 1 }, { awaitResult: false }); settle();
assert.equal(modeBuilds, 2);
assert.strictEqual(modal.entry(5, 'occupation').value, occupationAnswer, 'an action ask keeps the occupation answer');
modal.request(5, { mode: 'occupation', value: 1 }, { awaitResult: false }); settle();
assert.equal(modeBuilds, 2, 'the same input key gets the kept answer back');
modal.request(5, { mode: 'occupation', value: 2 }, { awaitResult: false }); settle();
assert.equal(modeBuilds, 3, 'another input key builds');
assert.equal(modal.entry(5, 'occupation').value.value, 2);
assert.equal(modal.entry(5, 'action').value.value, 1, 'and keeps the other mode\'s answer');
for (let id = 100; id < 200; id++) modal.request(id, { value: 1 }, { awaitResult: false });
settle();
const deferrals = modal.stats.capacityDeferrals;
modal.request(300, { value: 1 }, { awaitResult: false }); modal.portion();
assert.equal(modal.stats.capacityDeferrals, deferrals, '100 finished cards leave the working pool free');
assert(modal.entry(300).done);
modal.cancel(5);
assert(!modal.entry(5, 'occupation') && !modal.entry(5, 'action'), 'a bot\'s cancel drops every mode');
modal.stop();

// A job in flight follows a new owner state that reads the same (rebase) and
// publishes on it (main drops an answer stamped with an older state); without
// it the newer owner retires it.
let owner = 'a';
const ownedPosted = [];
const owned = new ColdOccupationPlanner({ schedule: () => {}, now: () => 0, sourceToken: () => 0,
    ownCurrent: (id, input) => input.sourceState === owner, inputKey: input => input.value,
    capture: (id, input) => input, create: () => ({ units: 0 }), step: work => ++work.units === 3, result: () => ({ known: true }),
    publish: (id, input) => ownedPosted.push(input.state) });
owned.request(1, { value: 1, state: 'a', sourceState: 'a' }, { awaitResult: false }); owned.portion();
assert(!owned.entry(1).done);
owner = 'b'; owned.rebase(owned.entry(1), { value: 1, state: 'b', sourceState: 'b' });
while (owned.ready.size || owned.waiting.size) owned.portion();
assert(owned.entry(1)?.done && owned.stats.staleOwners === 0, 'a rebased job finishes');
assert.deepEqual(ownedPosted, ['b'], 'and publishes on the state it follows');
owned.request(2, { value: 1, sourceState: 'b' }, { awaitResult: false }); owned.portion();
owner = 'c';
while (owned.ready.size || owned.waiting.size) owned.portion();
assert(!owned.entry(2) && owned.stats.staleOwners === 1, 'a job whose owner moved on is retired');
owned.stop();

// A finished answer serves an ask of its key until its window (servesUntil,
// from the ask that built it): a later ask of the same key builds again.
let windowBuilds = 0;
const windowed = new ColdOccupationPlanner({ schedule: () => {}, now: () => 0, sourceToken: () => 0,
    inputKey: input => input.value, servesUntil: input => input.timestamp + 100,
    capture: (id, input) => input, create: () => ({ build: ++windowBuilds }), step: () => true, result: work => ({ known: true, build: work.build }) });
const windowAsk = timestamp => { windowed.request(1, { value: 1, timestamp }, { awaitResult: false });
    while (windowed.ready.size || windowed.waiting.size) windowed.portion(); return windowed.entry(1).value.build; };
assert.deepEqual([windowAsk(0), windowAsk(50), windowAsk(99)], [1, 1, 1], 'inside the window the answer serves');
assert.deepEqual([windowAsk(100), windowAsk(150)], [2, 2], 'past it the same key builds once and serves again');
windowed.stop();

// Query snapshots are temporary owners, unlike the kernel's native state.
// Cleanup must remove both completed and pending inputs without touching a
// replacement installed for the same actor while the query was awaiting work.
const transient = new ColdOccupationPlanner({ schedule: () => {}, now: () => 0,
    sourceToken: () => 0, capture: (id, input, read) => { read(99); return input; },
    create: input => ({ input }), step: () => true, result: () => ({ known: true }) });
const privateState = { inventory: [{ itemId: 1 }] }, canonicalState = { inventory: [] };
transient.request(1, { state: privateState }, { awaitResult: false });
assert.equal(transient.cancelState(1, canonicalState), false);
assert.equal(transient.cancelState(1, privateState), true);
assert.equal(transient.waiting.size, 0, 'pending private input is released');
transient.request(1, { state: privateState }, { awaitResult: false });
while (transient.waiting.size || transient.ready.size) transient.portion();
assert.equal(transient.entry(1).input.state, privateState);
assert.equal(transient.cancelState(1, privateState), true);
assert.equal(transient.cards.size, 0, 'completed private input is released');
assert.equal(transient.dependencies.size, 0, 'private dependency owners are released');
transient.request(1, { state: canonicalState }, { awaitResult: false });
assert.equal(transient.cancelState(1, privateState), false);
assert.equal(transient.entry(1).input.state, canonicalState, 'newer canonical input survives cleanup');
transient.stop();

const scopeCallbacks = [], scopeTokens = new Map(), scopePosted = [];
let builds = 0;
const scoped = new ColdOccupationPlanner({ schedule: callback => scopeCallbacks.push(callback), now: () => 0,
    sourceToken: () => 0, sourceScopeToken: scope => scopeTokens.get(scope) || 0,
    capture: (id, input, read, readScope) => { readScope(input.scope); return input; },
    create: input => ({ input, units: 0, build: ++builds }), step: cursor => ++cursor.units === 3,
    result: cursor => ({ known: true, recipeId: cursor.build }), publish: (...args) => scopePosted.push(args) });
scoped.request(1, { scope: 'recipe-production:2' }, { awaitResult: false });
scoped.request(2, { scope: 'recipe-production:5' }, { awaitResult: false });
scoped.portion();
assert.equal(scoped.entry(1).done, false, 'completion waits for cooperative scope validation');
const oldBuild = scoped.entry(1).work.build;
scopeTokens.set('recipe-production:2', 1); scoped.scopeChanged('recipe-production:2');
scoped.scopeChanged('recipe-production:2');
assert.equal(scoped.stats.invalidations, 1, 'same scope event coalesces');
assert.equal(scoped.entry(2).dirty, false, 'a different skill scope remains valid');
for (let at = 0; at < 10 && scoped.ready.size; at++) scoped.portion();
assert(scoped.entry(1).value.recipeId > oldBuild, 'pending result recomputes after admission changed');
scopeTokens.set('recipe-production:2', 2); scoped.scopeChanged('recipe-production:2');
scopeTokens.set('recipe-production:2', 3); scoped.scopeChanged('recipe-production:2');
assert.equal(scopePosted.filter(row => row[3]?.stale).length, 1, 'completed owner publishes stale only once until rebuilt');
scoped.release(1); assert.equal(scoped.scopeDependencies.has('recipe-production:2'), false);
scoped.stop(); assert.equal(scoped.scopeDependencies.size, 0);

// Revision validation catches a source update even without a delivered
// invalidation callback during preparation.
let scopeVersion = 0;
const validating = new ColdOccupationPlanner({ schedule: () => {}, now: () => 0,
    sourceToken: () => 0, sourceScopeToken: () => scopeVersion,
    capture: (id, input, read, readScope) => { readScope('recipe-production:3'); return input; },
    create: () => ({ units: 0 }), step: cursor => ++cursor.units === 3, result: () => ({ known: true }) });
validating.request(1, {}, { awaitResult: false }); validating.portion();
scopeVersion++; validating.unit(validating.entry(1));
assert.equal(validating.entry(1).dirty, true, 'scope token is checked before publishing');
validating.stop(); assert.equal(validating.scopeDependencies.size, 0);

// A board row change on item A rechecks A's readers and the category's
// meeting representative, not every item read in the category.
const itemTokens = new Map([[11, 0], [12, 0]]), groupTokens = new Map([['c1', 0]]);
let tokenReads = 0;
const grouped = new ColdOccupationPlanner({ schedule: () => {}, now: () => 0,
    sourceScope: id => id === 11 || id === 12 ? 'c1' : null,
    sourceToken: (id, mode) => { tokenReads++; return mode === 'meeting' ? groupTokens.get('c1') : itemTokens.get(id); },
    capture: (id, input, read) => { for (const item of input.items) read(item); return input; },
    create: () => ({ units: 0 }), step: cursor => ++cursor.units === 100, result: () => ({ known: true }) });
grouped.request(1, { mode: 'occupation', items: [12] }, { awaitResult: false });
grouped.request(2, { mode: 'meeting', items: [12, 11] }, { awaitResult: false });
grouped.portion();
assert.deepEqual([...grouped.entry(2, 'meeting').reads.keys()], [12], 'meeting reads collapse to one category representative');
itemTokens.set(11, 1); groupTokens.set('c1', 1); tokenReads = 0;
grouped.sourceChanged(11); grouped.groupChanged('c1');
assert.equal(grouped.entry(1, 'occupation').dirty, false, 'a board change on item A keeps a reader of item B valid');
assert.equal(grouped.entry(2, 'meeting').dirty, true, 'the category (meeting) reader is invalidated');
assert.equal(tokenReads, 2, 'only the representative owners are rechecked');
grouped.stop(); assert.equal(grouped.representatives.size, 0);

// Owners of one item in the same mode share one token per change: each is
// kept when it did not move and invalidated by a move, a meeting reader of
// the category only by its own token.
const shared = new Map([[21, 0]]);
const sharing = new ColdOccupationPlanner({ schedule: () => {}, now: () => 0,
    sourceToken: (id, mode) => mode === 'meeting' ? -1 : shared.get(id),
    capture: (id, input, read) => { for (const item of input.items) read(item); return input; },
    create: () => ({ units: 0 }), step: cursor => ++cursor.units === 100, result: () => ({ known: true }) });
for (const id of [1, 2, 3]) sharing.request(id, { mode: 'occupation', items: [21] }, { awaitResult: false });
sharing.request(4, { mode: 'meeting', items: [21] }, { awaitResult: false });
sharing.portion();
const sharedDirty = () => [1, 2, 3].map(id => sharing.entry(id, 'occupation').dirty).concat(sharing.entry(4, 'meeting').dirty);
sharing.sourceChanged(21);
assert.deepEqual(sharedDirty(), [false, false, false, false], 'no move: every owner kept');
shared.set(21, 1); sharing.sourceChanged(21);
assert.deepEqual(sharedDirty(), [true, true, true, false], 'a move invalidates every reader of that mode only');
sharing.stop();

const state = { characterId: 7, updatedAt: 1000, level: 30, activity: 'hunting',
    adena: 100, vitals: { mp: 50 }, inventory: {}, stats: { classId: 1 } };
for (const workshop of [{ known: false }, { known: true, recipeId: 0, productId: 0, incomePerHour: 0, cycleHours: 0 },
    { known: true, recipeId: 25, productId: 1864, incomePerHour: 150.125, cycleHours: .25 }]) {
    const decision = compact(structuredClone(capture({ workshop }, state)));
    if (workshop.known === false) assert(Number.isNaN(decision.workshop.incomePerHour));
    else { assert.equal(decision.workshop.incomePerHour, workshop.incomePerHour); assert.equal(decision.workshop.cycleHours, workshop.cycleHours); }
    const decisions = new ColdEconomyDecisions(); decisions.accept(7, decision);
    assert.equal(decisions.workshopFor(state).known, workshop.known);
    // The card belongs to its decision: a later publication, a woken build
    // (a situation raised for it) or another decision drops it.
    assert.equal(decisions.workshopFor({ ...state, updatedAt: state.updatedAt + 1 }).known, false, 'a later publication invalidates captured occupation');
    assert.equal(decisions.workshopFor({ ...state, adena: 0, stats: { ...state.stats, woken: 2 } }).known, false,
        'a woken build invalidates captured occupation');
    assert.equal(decisions.workshopFor({ ...state, stats: { ...state.stats, decisionSeq: 1 } }).known, false, 'another decision invalidates captured occupation');
    decisions.staleWorkshop(7, { echo: stateEcho(state), updatedAt: state.updatedAt });
    assert.equal(decisions.workshopFor(state).known, false, 'used-source retirement preserves explicit unknown');
}
console.log('PASS pinned FIFO contexts, exact resumable progress, used-source restarts, 32-unit portions and binary workshop NaN');
