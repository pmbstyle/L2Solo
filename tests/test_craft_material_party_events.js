'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
const { PartyAssemblyEvents } = require('../src/GameServer/Bot/Population/PartyAssemblyEvents');
const cache = new Map(), deadlines = new Map();
let publish, reads = 0, observed;
const life = { cachedState: id => { reads++; return cache.get(id); }, subscribePublications: fn => { publish = fn; return () => {}; } };
const registry = { armDeadline: (key, at, fn) => deadlines.set(key, { at, fn }),
    cancelDeadline: key => deadlines.delete(key), subscribeTicks: () => () => {} };
const parties = { subscribeChanges: () => () => {} };
const classify = state => state.activity === 'hunting' ? {
    key: `spot:${state.stats?.partyRequest?.spotId || state.spotId}`, seeks: state.stats?.partyRequest?.status === 'open',
    supportKey: state.stats?.role === 'healer' ? `${state.level}:healer` : null,
    stamp: [state.level, state.stats?.role, state.spotId, state.stats?.partyRequest?.status] } : null;
const service = new PartyAssemblyEvents({ registry, life, parties, classify, now: () => 1000,
    run: candidates => { observed = candidates; return {}; } });
function add(state) { cache.set(state.characterId, state); publish({ characterId: state.characterId, state }); }
const core = { characterId: 1, level: 65, activity: 'hunting', spotId: 'safe-camp',
    stats: { role: 'dps', partyRequest: { materialParty: true, spotId: 'material-camp', status: 'open' } } };
(async () => {
    service.start();
    add(core);
    // A large support population does not expand work on an addressed page.
    for (let i = 0; i < 2000; i++) add({ characterId: i + 2, level: 65 + i % 5,
        activity: 'hunting', spotId: `helper-camp:${i}`, stats: { role: 'healer' } });
    service.dirty.clear(); service.enqueue(service.groups.get('spot:material-camp'));
    const before = reads;
    service.pulse(1000);
    await new Promise(resolve => setImmediate(resolve));
    assert(observed.includes(core));
    assert(observed.some(state => state.stats.role === 'healer' && state.spotId !== 'material-camp'));
    assert(observed.length <= 13, 'one core and at most twelve indexed supports');
    assert(reads - before <= 25, 'the support population is never swept during selection');
    const helper = observed.find(state => state.stats.role === 'healer');
    const moved = { ...helper, level: 70 };
    add(moved);
    assert(!service.supports.get('65:healer')?.has(helper.characterId));
    assert(service.supports.get('70:healer').has(helper.characterId), 'level transitions update the same support index');
    add({ ...moved, activity: 'traveling' });
    assert(!service.supports.get('70:healer')?.has(helper.characterId), 'busy supports leave the index');
    const current = cache.get(core.characterId);
    cache.set(core.characterId, { ...current, adena: 10 });
    publish({ characterId: core.characterId, state: current });
    assert.equal(service.records.get(core.characterId).state, current, 'a stale reentrant publication is ignored');
    service.stop();
    assert.equal(service.supports.size, 0);
    assert.equal(deadlines.size, 0);
    console.log('PASS material assembly events: remote supports, fixed inspections with 2000 helpers, stale/level/busy updates and release');
})().catch(error => { service.stop(); console.error(error); process.exitCode = 1; });
