'use strict';
const assert = require('node:assert/strict');
const path = require('path');

// The cold simulation's conservation laws on a fixed sample: ten cells of the
// spot table (a spot's species, a class line, a level, shots), each one
// fighting and one dying several times, hunted through the generator's own
// hunt for two hours at three seeds. A dead bot restarts 90 s after its death,
// never later, and no bot sits down at a whole HP and MP bar (the tenth cell
// hunts with the model's lifted admission, which fights only at a whole bar
// when the gate refuses). Every hunt tiles its
// clock, credits each regen interval its rate, closes its HP and MP (every
// change a probed call or a clock interval), keeps its stamps
// inside their intervals and its loot inside the bag, and its row fits in its
// hour per kill. The same laws fail on each defect the cold round had
// (time counted twice, regen as one capped lump, a round framed from its
// moment, loot past the bag), re-introduced here by a wrapper around the
// game's own functions. The fixture holds the ten spots' catalogue rows (the
// server's spot catalogue, SpotService + SpotProfiles), so no world spawns.
// It is written from the generator's catalogue by
//   node tests/test_cold_sim_invariants.js --cells=line/level/spotId/selfId/form,...
process.env.TZ = 'UTC';
const Module = require('module');

// Every function of the cold resolver that changes a bot's HP or MP outside
// the clock (ColdClock's regen), probed by the vitals it was handed and the
// vitals it left. The resolver calls them by name, so they are wrapped where
// they are declared: its source gets one line at the end that rebinds each
// name to its wrapper (a missing name throws at load). Calls inside a probed
// call are part of it (depth). kind: the change's name in the balance.
const vitalsOf = (vitals) => ({ hp: Number(vitals.hp), mp: Number(vitals.mp), maxHp: Number(vitals.maxHp), maxMp: Number(vitals.maxMp) });
const PROBED = {
    // A fight returns the HP and MP it left (a scan or a fight not taken returns none).
    resolveFight: { kind: 'fight', before: (options) => vitalsOf(options.state.vitals),
        after: (result) => (result && !result.avoided && Number.isFinite(result.hp) ? { hp: result.hp, mp: result.mp } : null) },
    // The bottles and the gap heals change the vitals they are handed in place.
    coldRestPotions: { kind: 'potion', before: (profile, vitals) => vitalsOf(vitals), after: (result, profile, vitals) => vitalsOf(vitals) },
    coldHealBetweenFights: { kind: 'heal', before: (profile, vitals) => vitalsOf(vitals), after: (result, profile, vitals) => vitalsOf(vitals) },
    // The buffs' and the readiness' casts spend the round's MP in place.
    applySoloBuffs: { kind: 'buff', before: (patch) => vitalsOf(patch.vitals), after: (result, patch) => vitalsOf(patch.vitals) },
    getReady: { kind: 'ready', before: (state, patch) => vitalsOf(patch.vitals), after: (result, state, patch) => vitalsOf(patch.vitals) },
    // The town restart returns the vitals it revives with.
    resolveDeathRecovery: { kind: 'respawn', before: (state) => vitalsOf(state.vitals),
        after: (result, state) => (result?.patch?.vitals ? vitalsOf({ ...state.vitals, ...result.patch.vitals }) : null) }
};
const probe = { depth: 0, step: null };
const RESOLVER = path.resolve(__dirname, '..', 'src', 'GameServer', 'Bot', 'Population', 'BackgroundResolver.js');
global.__coldSimProbe = (name, fn) => {
    const read = PROBED[name];
    return function probed(...args) {
        const top = probe.depth === 0 && probe.step;
        const before = top ? read.before(...args) : null;
        probe.depth += 1;
        let result;
        try {
            result = fn.apply(this, args);
        } finally {
            probe.depth -= 1;
        }
        const after = top ? read.after(result, ...args) : null;
        if (after) top.changes.push({ kind: read.kind, before, after });
        return result;
    };
};
const compile = Module.prototype._compile;
Module.prototype._compile = function (content, filename) {
    if (path.resolve(filename) !== RESOLVER) return compile.call(this, content, filename);
    const rebind = Object.keys(PROBED).map((name) => `${name} = global.__coldSimProbe('${name}', ${name});`).join(' ');
    return compile.call(this, `${content}\n${rebind}\n`, filename);
};

const Generator = require('../scripts/generate-spot-table');
const Decompose = require('../scripts/economy-model/fight/decompose');
const Invariants = require('../scripts/economy-model/fight/invariants');
const HuntLift = require('../scripts/economy-model/hunt-lift');

const FIXTURE = path.join(__dirname, 'fixtures', 'cold_sim_invariants.json');
const HOURS = 2;
const SEEDS = 3;
// The cell hunted with the lifted admission: a class 18 bot at level 4, whose
// bar is fractional (164.45 HP), at 4_3 on its species 3.
const LIFTED = { line: '20', level: 4, spotId: '4_3', selfId: 3 };
const lifted = (cell) => Object.keys(LIFTED).every((key) => cell[key] === LIFTED[key]);
// The restart's wait after a death (EconomicValuation prices a death at it).
const RESPAWN_MS = 90000;
const wholeBar = (vitals) => vitals.hp >= vitals.maxHp && vitals.mp >= vitals.maxMp;
// --cells: the fixture written anew, the catalogue (the world spawned) kept to the named cells' spots.
const written = process.argv.find((arg) => arg.startsWith('--cells='));
if (written) {
    const cells = written.slice('--cells='.length).split(',').map((text) => {
        const [line, level, spotId, selfId, form] = text.split('/');
        return { line, level: Number(level), spotId, selfId: Number(selfId), form: Number(form) };
    });
    const ids = new Set(cells.map((cell) => cell.spotId));
    const catalogue = Generator.buildCatalogue();
    const fixture = { cells, spots: catalogue.spots.filter((spot) => ids.has(String(spot.id))),
        profiles: catalogue.profiles.filter((profile) => ids.has(String(profile.id))) };
    assert.strictEqual(fixture.profiles.length, ids.size, 'every named spot is in the catalogue');
    require('fs').writeFileSync(FIXTURE, `${JSON.stringify(fixture)}\n`);
    console.log(`wrote ${path.relative(process.cwd(), FIXTURE)}: ${cells.length} cells, ${ids.size} spots`);
    process.exit(0);
}
Generator.loadSimulation(FIXTURE);
const fixture = require(FIXTURE);
const BR = invoke('GameServer/Bot/Population/BackgroundResolver');
const ColdClock = invoke('GameServer/Bot/Population/ColdClock');
const ColdRest = invoke('GameServer/Bot/Population/ColdRest');
const SurvivalFloor = invoke('GameServer/Bot/Population/SurvivalFloor');
const InventoryLimits = invoke('GameServer/Inventory/InventoryLimits');
const Formulas = invoke('GameServer/Formulas');
const items = invoke('GameServer/DataCache').items;
const profiles = new Map(fixture.profiles.map((profile) => [String(profile.id), profile]));

// One hunt recorded step by step at the generator's seam (BackgroundResolver.resolveSolo)
// and the clock's (ColdClock: every span a step credits regen over). Only the row's
// pass is recorded: the hunt first measures the shots and potions used on an endless
// supply, and the row is its second pass on what that use buys. defect: wrappers
// that re-introduce a defect ({ open, advance, result }).
function recordHunt(cell, seed, defect = {}) {
    const real = { resolveSolo: BR.resolveSolo, open: ColdClock.open, advance: ColdClock.advance, sit: ColdClock.sit, seated: ColdClock.seated };
    const steps = [];
    let step = null, pass = null;
    // A regen interval is rate-checked at any depth; it is a change of the
    // step's vitals only outside a probed call (inside one it is that call's).
    const credit = (on, interval, kind) => {
        on.intervals.push(interval);
        if (probe.depth === 0) on.changes.push({ kind, before: interval.before, after: interval.after });
    };
    ColdClock.open = (from) => {
        const clock = defect.open ? defect.open(real.open, from, step) : real.open(from);
        if (step) step.opens.push(clock.at);
        return clock;
    };
    ColdClock.advance = (clock, body, ms, posture, rates) => {
        const at = clock.at, before = vitalsOf(body.vitals);
        const after = defect.advance ? defect.advance(real.advance, clock, body, ms, posture, rates, step) : real.advance(clock, body, ms, posture, rates);
        if (step) credit(step, { at, ms, rate: posture === 'moving' ? rates.moving : rates.standing, before, after: vitalsOf(after.vitals) }, posture);
        return after;
    };
    ColdClock.sit = (clock, body, needMs, bound, state, rates, options = {}) => {
        const at = clock.at, sat0 = clock.seatedMs, before = vitalsOf(body.vitals);
        const rate = ColdRest.restRegenPerTick({ ...state, vitals: body.vitals, stats: body.stats }, before.maxHp - before.hp, before.maxMp - before.mp,
            { profile: rates.profile, timestamp: at, ...options });
        const result = real.sit(clock, body, needMs, bound, state, rates, options);
        // A round's sit that begins at a whole bar (the rest step's span is a sit already begun).
        if (step && clock.seatedMs > sat0 && wholeBar(before)) step.wholeBarSits = (step.wholeBarSits || 0) + 1;
        if (step) credit(step, { at, ms: clock.seatedMs - sat0, rate, before, after: vitalsOf(result.body.vitals) }, 'seated');
        return result;
    };
    // The rest step passes its moment: it sits the span before it.
    ColdClock.seated = (state, body, ms, at, profile, options) => {
        const result = real.seated(state, body, ms, at, profile, options);
        if (step) credit(step, { at: at - ms, ms, rate: result.regen, before: vitalsOf(body.vitals), after: vitalsOf(result.vitals) }, 'seated');
        return result;
    };
    BR.resolveSolo = (options) => {
        const state = options.state;
        step = { t: options.timestamp, elapsedMs: options.elapsedMs, intervals: [], changes: [], opens: [],
            before: { activity: state.activity, ...vitalsOf(state.vitals) } };
        probe.step = step;
        let result;
        try {
            result = real.resolveSolo(options);
            if (defect.result) result = defect.result(result, options);
        } finally {
            const done = step;
            step = null;
            probe.step = null;
            if (result && pass === 'row') {
                const debug = result.debug || {}, patch = result.patch || {};
                const after = { ...state, ...patch, vitals: { ...state.vitals, ...(patch.vitals || {}) }, inventory: patch.inventory || state.inventory };
                const gained = (result.materialize?.items || []).length;
                Object.assign(done, {
                    round: Number.isFinite(debug.combatMs), combatMs: Number(debug.combatMs) || 0, walkedMs: Number(debug.walkedMs) || 0,
                    seatedMs: Number(debug.seatedMs) || 0, doneAt: Number(result.doneAt) || 0, restUntil: Number(patch.stats?.restUntil) || 0,
                    nextResolveAt: Number(result.nextResolveAt) || 0,
                    after: { activity: after.activity, ...vitalsOf(after.vitals) }, gained,
                    bag: gained ? { slots: SurvivalFloor.stateInventory(after, items).slots, slotLimit: InventoryLimits.forState(after) } : null
                });
                steps.push(done);
            }
        }
        return result;
    };
    const base = Decompose.speciesSpot(profiles.get(cell.spotId), cell.selfId);
    const spot = seed ? { ...base, id: `${base.id}#${seed}` } : base;
    const classId = Generator.classFor(cell.line, cell.level);
    let sum;
    try {
        sum = Generator.hunt(spot, cell.line, cell.level, cell.form, HOURS, undefined, Decompose.creationKit(classId), classId, (name) => { pass = name; });
    } finally {
        Object.assign(BR, { resolveSolo: real.resolveSolo });
        Object.assign(ColdClock, { open: real.open, advance: real.advance, sit: real.sit, seated: real.seated });
    }
    return { steps, sum };
}

// Every cell at every seed under one defect: the violations by kind and a sample of each.
function sweep(defect) {
    const kinds = {}, sample = {}, balance = { hp: {}, mp: {}, startMinusEnd: { hp: 0, mp: 0 } };
    let hunts = 0, kills = 0, deaths = 0;
    const cells = {};
    for (const cell of fixture.cells) {
        const name = `${cell.spotId}/${cell.selfId} L${cell.level} line ${cell.line}`;
        cells[name] = { kills: 0, deaths: 0, respawnWaits: [], wholeBarSits: 0 };
        for (let seed = 0; seed < SEEDS; seed++) {
            HuntLift.lift(lifted(cell));
            let hunt;
            try {
                hunt = recordHunt(cell, seed, defect);
            } finally {
                HuntLift.lift(false);
            }
            // The respawn step's restart ends RESPAWN_MS after the dying round's end (the death).
            hunt.steps.forEach((step, i) => {
                if (step.before.activity === 'dead' && i > 0) cells[name].respawnWaits.push(step.restUntil - hunt.steps[i - 1].doneAt);
                cells[name].wholeBarSits += step.wholeBarSits || 0;
            });
            const row = Generator.perKill(hunt.sum);
            const checked = Invariants.checkHunt(hunt, { row, tickMs: Formulas.REGEN_TICK_MS, rounding: Generator.ROUNDING });
            const violations = checked.violations;
            for (const bar of ['hp', 'mp']) {
                for (const [kind, sum] of Object.entries(checked.balance[bar])) balance[bar][kind] = (balance[bar][kind] || 0) + sum;
                if (checked.balance.start) balance.startMinusEnd[bar] += checked.balance.start[bar] - checked.balance.end[bar];
            }
            hunts += 1;
            kills += hunt.sum.mobs;
            deaths += hunt.sum.deaths;
            cells[name].kills += hunt.sum.mobs;
            cells[name].deaths += hunt.sum.deaths;
            for (const violation of violations) {
                kinds[violation.kind] = (kinds[violation.kind] || 0) + 1;
                sample[violation.kind] ||= `${name} seed ${seed} step ${violation.step}: ${violation.detail}`;
            }
        }
    }
    return { kinds, sample, hunts, kills, deaths, balance, cells };
}

const started = Date.now();
const head = sweep();
console.log(`head: ${head.hunts} hunts, ${head.kills} kills, ${head.deaths} deaths, violations ${JSON.stringify(head.kinds)}`);
for (const line of Object.values(head.sample)) console.log(`  ${line}`);
for (const bar of ['hp', 'mp']) {
    console.log(`  ${bar} balance: ${Object.entries(head.balance[bar]).map(([kind, sum]) => `${kind} ${sum.toFixed(0)}`).join(', ')}, start - end ${head.balance.startMinusEnd[bar].toFixed(0)}`);
}
assert.deepStrictEqual(head.kinds, {}, 'the cold hunt keeps every law');
// The laws are checked on hunts that fight and die: every cell kills, one dies five times or more.
for (const [name, cell] of Object.entries(head.cells)) assert.ok(cell.kills > 0, `${name} kills (${cell.deaths} deaths)`);
const dying = Math.max(...Object.values(head.cells).map((cell) => cell.deaths));
assert.ok(dying >= 5, `a cell dies five times or more a sweep (most: ${dying})`);
for (const [name, cell] of Object.entries(head.cells)) {
    const late = cell.respawnWaits.filter((ms) => Math.abs(ms - RESPAWN_MS) > 1);
    assert.deepStrictEqual(late.map((ms) => Math.round(ms / 1000)), [], `${name}: a dead bot restarts ${RESPAWN_MS / 1000} s after its death (waits in s)`);
    assert.strictEqual(cell.wholeBarSits, 0, `${name}: no bot sits down at a whole HP and MP bar`);
}
const respawns = Object.values(head.cells).reduce((n, cell) => n + cell.respawnWaits.length, 0);
assert.ok(respawns >= 5, `the restart is checked on five deaths or more (${respawns})`);

// A party's death: two reference bots of line 2 at level 10 hunt 23_-29 on its
// species 330 together through the party round for two hours, each member
// committed as the lifecycle commits it (its clock at its result's doneAt), the
// party stepped at its due. A dead member restarts 90 s after its death too,
// never 90 s after the party's next ordinary step.
function partyRespawnWaits() {
    const BPR = invoke('GameServer/Bot/Population/BackgroundPartyResolver');
    const HuntCycle = invoke('GameServer/Bot/AI/HuntCycle');
    const BotGear = invoke('GameServer/Bot/AI/BotGear');
    const CCP = invoke('GameServer/Bot/Population/ColdCombatProfile');
    const START = 1_750_000_000_000;
    const spot = Decompose.speciesSpot(profiles.get('23_-29'), 330);
    const classId = Generator.classFor('2', 10);
    const member = (characterId) => {
        const state = HuntCycle.referenceState(classId, 10, { gear: BotGear, profile: CCP, line: Generator.lineClassFor('2') });
        const { maxHp, maxMp } = CCP.profileFor(state, START);
        return { ...state, characterId, partyId: 'invariants', phase: 'cold', activity: 'grouped', spotId: spot.id, loc: { ...spot.center },
            vitals: { hp: maxHp, maxHp, mp: maxMp, maxMp } };
    };
    let members = [member(1), member(2)];
    let party = { partyId: 'invariants', leaderId: 1, spotId: spot.id, cohesion: 1, risk: 0, roleCoverage: {}, stats: {} };
    // One seeded draw for the round and the rules it calls (Math.random), as the generator's hunt.
    let seed = 7;
    const rng = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const random = Math.random;
    Math.random = rng;
    const diedAt = new Map(), waits = [];
    try {
        for (let due = START; due < START + HOURS * 3600000;) {
            const { timestamp, elapsedMs } = ColdClock.step(members[0], due);
            const step = BPR.resolve({ party, members, spot, elapsedMs, timestamp, rng, spotHunters: 2 });
            const results = new Map(step.memberResults.map(({ state, result }) => [state.characterId, result]));
            members = members.map((state) => {
                const result = results.get(state.characterId), patch = result.patch || {};
                const hp = Number(patch.vitals?.hp ?? state.vitals.hp);
                if (state.vitals.hp > 0 && hp <= 0) diedAt.set(state.characterId, ColdClock.doneAt(result) ?? timestamp);
                if (state.vitals.hp <= 0 && hp > 0) waits.push(patch.stats.restUntil - diedAt.get(state.characterId));
                return { ...state, ...patch, vitals: { ...state.vitals, ...(patch.vitals || {}) }, stats: patch.stats || state.stats,
                    inventory: patch.inventory || state.inventory, timing: { ...state.timing, lastResolvedAt: ColdClock.doneAt(result) ?? timestamp } };
            });
            party = { ...party, ...step.partyPatch, stats: { ...party.stats, ...(step.partyPatch?.stats || {}) } };
            assert.notStrictEqual(party.status, 'dissolved', `the party hunts on (${party.stats.partyBreakReason})`);
            due = Math.max(timestamp + 1, Number(step.nextResolveAt) || timestamp + 30000);
        }
    } finally {
        Math.random = random;
    }
    return waits;
}
const partyWaits = partyRespawnWaits();
assert.ok(partyWaits.length >= 5, `the party restart is checked on five deaths or more (${partyWaits.length})`);
assert.deepStrictEqual(partyWaits.filter((ms) => Math.abs(ms - RESPAWN_MS) > 1).map((ms) => Math.round(ms / 1000)), [],
    `a dead party member restarts ${RESPAWN_MS / 1000} s after its death (waits in s)`);
console.log(`party: ${partyWaits.length} restarts, each ${RESPAWN_MS / 1000} s after the death`);

// Each defect the cold round had, re-introduced, breaks its law.
const lumped = new WeakSet();
const defects = {
    // The generator counted a round's combat again as its rest.
    'time counted twice': [{ result: (result) => ({ ...result, debug: { ...result.debug, seatedMs: (Number(result.debug?.seatedMs) || 0) + (Number(result.debug?.combatMs) || 0) } }) }, 'time.twice'],
    // A round's standing regen applied as one lump at its opening, capped by the bar,
    // and none over the round's own spans.
    'regen as a capped lump': [{ advance: (advance, clock, body, ms, posture, rates, step) => {
        if (step && !lumped.has(step)) {
            lumped.add(step);
            const lump = advance({ ...clock }, body, step.elapsedMs, posture, rates);
            clock.at += ms;
            clock.activeMs += ms;
            return lump;
        }
        clock.at += ms;
        clock.activeMs += ms;
        return body;
    } }, 'vitals.rate'],
    // A round's standing regen given at its end outside the clock (the base gave it
    // at the round's opening, outside any interval): HP no change accounts for.
    'regen outside the clock': [{ result: (result) => {
        const vitals = result.patch?.vitals;
        if (!Number.isFinite(result.debug?.combatMs) || !vitals || !(vitals.hp < vitals.maxHp)) return result;
        return { ...result, patch: { ...result.patch, vitals: { ...vitals, hp: Math.min(vitals.maxHp, vitals.hp + 10) } } };
    } }, 'vitals.unaccounted'],
    // A round framed from its moment instead of the clock it credits.
    'round stamped from its moment': [{ open: (open, from, step) => open(step ? step.t : from) }, 'time.uncovered'],
    // Loot merged past the bag: a hundred more non-stackable pieces.
    'loot past the cap': [{ result: (result) => {
        if (!(result.materialize?.items || []).length || !result.patch?.inventory) return result;
        const piece = items.find((item) => item?.etc?.stackable === false || item?.template?.stackable === false);
        const inventory = { ...result.patch.inventory, [piece.selfId]: { selfId: Number(piece.selfId), amount: 100, stackable: false } };
        return { ...result, patch: { ...result.patch, inventory } };
    } }, 'loot.slots']
};
for (const [name, [defect, kind]] of Object.entries(defects)) {
    const broken = sweep(defect);
    console.log(`${name}: violations ${JSON.stringify(broken.kinds)}`);
    assert.ok(broken.kinds[kind] > 0, `${name} breaks ${kind}`);
}
const seconds = (Date.now() - started) / 1000;
console.log(`cold simulation invariants passed in ${seconds.toFixed(1)} s`);
assert.ok(seconds < 60, `the check stays under a minute (${seconds.toFixed(1)} s)`);
