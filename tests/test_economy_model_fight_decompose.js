'use strict';
// The fight decomposition watches the hunt table's own hunt without changing
// it: its cell is the builder's cell, its wall-clock parts (fight, walk, rest,
// death recovery, other; a round's combat in the interval before its
// timestamp, the one the resolver budgets it from) tile the hunt's hours from
// the first round's budget to the hunt-end tail, its fatal fights are the
// hunt's deaths, the rest the builder reads is the rest the rounds set, and
// every cell names the term that carries the matchup's error.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('../src/Global');
const Generator = require('../scripts/generate-spot-table');
const HuntTable = require('../scripts/economy-model/hunt-table');
const Lift = require('../scripts/economy-model/hunt-lift');
const Decompose = require('../scripts/economy-model/fight/decompose');

const GREMLIN_SPOT = '-12_43';
// A cell where the lifted L5 mystic dies: its death recovery is on the clock.
const DYING_SPOT = '-2_1';
const BR = invoke('GameServer/Bot/Population/BackgroundResolver');

// The parts tile the clock from the first round's budget to the hunt-end tail.
function assertTiles(name, asIs, hours) {
    const w = asIs.wallMs, { before, tail } = asIs.edgeMs;
    assert.deepEqual(Object.keys(w).sort(), ['death', 'fight', 'other', 'rest', 'walk'], `${name}: no overlap part: fight and rest do not share a second`);
    const total = w.fight + w.walk + w.rest + w.death + w.other;
    assert.equal(before, 60000, `${name}: the first round is credited the builder's first interval before the hunt's start`);
    assert(tail >= 0 && tail <= 120000, `${name}: the hunt-end tail is at most one hunt cycle (${tail})`);
    assert(Math.abs(total - (hours * 3600000 + before - tail)) < 1e-3, `${name}: the parts tile the clock from the first budget to the hunt-end tail (${total})`);
    assert.equal(asIs.fatal.length, asIs.deaths, `${name}: each death is one fatal fight`);
}

// Decompose a cell while noting each step of its last hunt: its time and whether the bot died in it or was dead at it.
function watchedDecompose(args) {
    const real = BR.resolveSolo, steps = [];
    BR.resolveSolo = options => {
        // A step never resolves before the bot's clock (where the last round ended): one that does starts the next hunt.
        if (steps.length && options.timestamp < steps[steps.length - 1].end) steps.length = 0;
        const result = real(options), state = options.state;
        // A round ends at its last action (doneAt): a dying round at the death, a revive at the death it restarts from.
        const end = Number(result.doneAt) > 0 ? Math.ceil(Number(result.doneAt)) : options.timestamp;
        steps.push({ t: options.timestamp, end, death: state.activity === 'dead' || Number(state.vitals?.hp) <= 0 || result.debug?.died === true });
        return result;
    };
    try { return { out: Decompose.decompose(args), steps }; } finally { BR.resolveSolo = real; }
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fight-decompose-test-'));
try {
    const catalogue = path.join(dir, 'catalogue.json');
    const built = Generator.buildCatalogue();
    fs.writeFileSync(catalogue, JSON.stringify({ spots: built.spots, profiles: built.profiles }));
    Generator.loadSimulation(catalogue);
    const spot = built.profiles.find(one => String(one.id) === GREMLIN_SPOT);
    assert(spot, `the catalogue has the gremlin spot ${GREMLIN_SPOT}`);
    const selfId = Number(spot.npcEntries[0].selfId), line = '51', level = 1, form = 0, hours = 1;
    const classId = Generator.classFor(line, level);
    Lift.lift(true);
    try {
        const plain = HuntTable.cellOf(Generator.hunt(Decompose.speciesSpot(spot, selfId), line, level, form, hours, undefined,
            Decompose.creationKit(classId), classId));
        const out = Decompose.decompose({ spot, selfId, line, level, form, hours });
        const { asIs, terms } = out;
        assert.deepEqual(asIs.cell, plain, 'watching the hunt does not change its cell');
        assert(asIs.mobs > 0, 'the lifted mystic kills gremlins');
        assert.deepEqual(Object.keys(out).sort(), ['asIs', 'terms'], 'one hunt, no variant with the rest moved');
        assert(asIs.wallMs.rest > 0 && asIs.wallMs.fight > 0, `the hunt fights and rests (${JSON.stringify(asIs.wallMs)})`);
        assertTiles('gremlins', asIs, hours);
        const read = asIs.reportedRestMs / 1000 / asIs.mobs;
        assert(Math.abs(asIs.cell[3] - read) <= 1e-3 * Math.max(1, read), `the cell's rest is the rest the rounds set (${asIs.cell[3]} vs ${read})`);
        assert(terms.named.length >= 1 && ['mpAtStart', 'rotation'].includes(terms.named[0]), `a term is named (${terms.named})`);
        assert(terms.matchupRested?.fight > 0 && terms.matchupAtStart?.fight > 0, 'the matchup fights from the rested line and from the measured start');

        const dying = built.profiles.find(one => String(one.id) === DYING_SPOT);
        assert(dying, `the catalogue has the spot ${DYING_SPOT}`);
        const dyingHours = 0.25;
        const { out: died, steps } = watchedDecompose({ spot: dying, selfId: Number(dying.npcEntries[0].selfId), line, level: 5, form, hours: dyingHours });
        assert(died.asIs.deaths > 0, `the L5 mystic dies at ${DYING_SPOT} (${died.asIs.deaths})`);
        assertTiles('dying', died.asIs, dyingHours);
        const end = steps[0].t + dyingHours * 3600000;
        const recovery = steps.reduce((ms, step, i) => ms + (step.death ? Math.min(steps[i + 1]?.t ?? end, end) - step.end : 0), 0);
        assert(Math.abs(died.asIs.wallMs.death - recovery) < 1e-3, `death is the gaps after the dying rounds and the revives (${died.asIs.wallMs.death} vs ${recovery})`);
    } finally {
        Lift.lift(false);
    }
    // Without the lift the builder reads the matchup before the hunt's first step: the cell still decomposes.
    const unlifted = Decompose.decompose({ spot, selfId, line, level, form, hours: 0.25 });
    assertTiles('no lift', unlifted.asIs, 0.25);
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}
console.log('test_economy_model_fight_decompose: ok');
