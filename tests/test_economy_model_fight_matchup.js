'use strict';
// The fight matchup expects the game's own fight: on held-out cells of the
// built hunt table, from the start states the table's hunt fought from and the
// pulls it rolled, its time per kill and damage per engagement are those of
// the game's fight replayed from the same starts (admitted cells within 3 % at
// the median and 8 % at p90), and the second moment of the damage within the
// range the death tail reads. Close cells carry no bound here: the matchup
// fights on to the kill while the game's fight stops at the bot's death. The sample is
// frozen with the tree stamp it was replayed on: a change of the combat code
// asks for it to be replayed (scripts/economy-model/fight/engagements.js --fixture).
// A skill's reuse carries into the next engagement, a pull of two hits as the
// game's pack, and a mob that cannot hurt the bot deals nothing.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('../src/Global');
const Generator = require('../scripts/generate-spot-table');
const HuntTable = require('../scripts/economy-model/hunt-table');
const Lift = require('../scripts/economy-model/hunt-lift');
const Decompose = require('../scripts/economy-model/fight/decompose');
const Engagements = require('../scripts/economy-model/fight/engagements');
const Matchup = require('../scripts/economy-model/rules/fight-matchup');
const Pull = invoke('GameServer/Bot/AI/BotPullEstimate');
const CMA = invoke('GameServer/Bot/Population/ColdMobAction');

const sample = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/economy-model/fight-matchup-sample.json'), 'utf8'));
assert.equal(sample.stamp, HuntTable.stamp(), 'the frozen sample was replayed on this combat code (replay it with engagements.js --fixture)');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fight-matchup-test-'));
try {
    const catalogue = path.join(dir, 'catalogue.json');
    const built = Generator.buildCatalogue();
    fs.writeFileSync(catalogue, JSON.stringify({ spots: built.spots, profiles: built.profiles }));
    Generator.loadSimulation(catalogue);
    const cells = [];
    let fighter = null;
    Lift.lift(true);
    try {
        for (const c of sample.cells) {
            const spot = built.profiles.find(one => String(one.id) === String(c.spotId));
            assert(spot, `the catalogue has the spot ${c.spotId}`);
            const { watched, starts } = Engagements.huntStarts(c, spot);
            // The states the sample was replayed from, each with its own bot state.
            const seen = Decompose.summarize(watched, 2).seen, picked = Engagements.spread(starts, c.states.length);
            assert(picked.length === c.states.length && seen.view, `${c.k}: the table's hunt fights from the sample's starts`);
            const perReplay = [];
            for (const [si, k, n] of c.ran) {
                assert.equal(picked[si].timestamp, c.states[si].at, `${c.k}: start ${si} is the sample's`);
                const m = Engagements.matchupAt(seen, { ...c.states[si], holder: picked[si].state }, k);
                for (let i = 0; i < n; i++) perReplay.push(m);
            }
            cells.push({ k: c.k, kind: c.kind, maxHp: c.maxHp, R: c.R, fm: Engagements.alongside(perReplay) });
            if (!fighter && c.kind === 'admitted' && c.form === 0) fighter = { c, seen };
        }
    } finally {
        Lift.lift(false);
    }
    const b = Engagements.bounds(cells, 'fm');
    const show = JSON.stringify(b);
    assert(b.admitted.cells >= 12, `the sample holds admitted cells (${show})`);
    for (const [kind, p50, p90] of [['admitted', 0.03, 0.08]]) {
        const s = b[kind];
        assert(s.b1.p50 <= p50 && s.b1.p90 <= p90, `${kind}: time per kill within ${p50} / ${p90} of the game's fight (${JSON.stringify(s.b1)})`);
        assert(s.b2.cells === 0 || (s.b2.p50 <= p50 && s.b2.p90 <= p90), `${kind}: damage per engagement within ${p50} / ${p90} (${JSON.stringify(s.b2)})`);
        assert.equal(s.b2.smallWithin, s.b2.small, `${kind}: a small damage within 0.01 of max HP (${JSON.stringify(s.b2)})`);
        assert(s.b3.p50 >= 0.85 && s.b3.p50 <= 1.18, `${kind}: the damage's second moment at the median within [0.85, 1.18] (${JSON.stringify(s.b3)})`);
    }

    // Cases on one admitted cell's bot, from its rested start.
    const { c, seen } = fighter;
    const p = seen.profiles.find(q => q.servitor !== true), at = 1_750_000_000_000;
    const run = (start, k = 1, mob = seen.view) => Matchup.engagement({ profile: p, fp: seen.fp, mob, k, start: { at, ...start },
        areaShare: Matchup.areaShareAt(seen.profiles, start.hp, start.mp, seen.view) });
    const rested = { hp: p.maxHp, mp: p.maxMp };
    const first = run(rested);
    const held = Object.entries(first.cooldowns).filter(([, left]) => left > 0);
    if (held.length) {
        const second = run({ ...rested, cooldowns: first.cooldowns });
        for (const [id, left] of held) {
            if (left > second.ms) assert(!second.casts[id], `${c.k}: skill ${id}, still in reuse, is not cast in the next engagement`);
        }
    }
    const one = run(rested, 1), two = run(rested, 2);
    const pack = Pull.pullView(Matchup.oneMob(seen.view), 2, 0).pack;
    const perAction = view => CMA.actionMix(view, { profile: seen.fp, state: null }, at).perAction;
    assert(Math.abs(two.taken.mean / two.mobActions - pack * perAction(Matchup.oneMob(seen.view))) <= 1e-6 * two.taken.mean,
        `${c.k}: a pull of two hits as the game's pack of ${pack} mobs per action`);
    assert(two.ms > one.ms * 1.5, `${c.k}: two mobs take longer to kill than one (${two.ms} vs ${one.ms})`);
    const harmless = run(rested, 1, { ...Matchup.oneMob(seen.view), pAtk: 0, mAtk: 0 });
    assert.equal(harmless.taken.mean, 0, 'a mob that cannot hurt the bot deals nothing');
    assert.equal(harmless.taken.square, 0, 'and its damage has no spread');
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}
console.log('test_economy_model_fight_matchup: ok');
