'use strict';
// Where a measured hunt's time and deaths go, per cell of the hunt table: the
// same hunt the builder runs (generate-spot-table hunt, the lift on), watched
// through the module objects the cold resolver calls (BackgroundResolver.resolveSolo
// per step, BotEncounterReadiness at each fight's start, ColdClassPolicy.select
// per bot action, RestPolicy.needsRest), so the fight is the game's code,
// unchanged. Per hunt: the wall clock split into fight, walk, rest, death
// recovery and other (a round's combat lies in the interval before its
// timestamp, the one the resolver budgets it from); the rest reasons; HP and MP
// at each fight's start; the bot's actions and skills per kill; potions in
// fight and at rest; the start HP of each fatal fight. Next to it the fight
// matchup (rules/fight-matchup) from the rested line and from the measured
// start vitals names the term that carries the error. Offline only.
//   node scripts/economy-model/fight/decompose.js --rows <est rows json> --catalogue <catalogue json>
//        [--adm 40] [--close 20] [--hours 2] [--out <json>]
require('../../../src/Global');
const fs = require('fs');
const Generator = require('../../generate-spot-table');
const HuntTable = require('../hunt-table');
const Lift = require('../hunt-lift');
const Matchup = require('../rules/fight-matchup');

const BR = invoke('GameServer/Bot/Population/BackgroundResolver');
const ColdClock = invoke('GameServer/Bot/Population/ColdClock');
const ER = invoke('GameServer/Bot/AI/BotEncounterReadiness');
const RP = invoke('GameServer/Bot/AI/RestPolicy');
const CCPol = invoke('GameServer/Bot/Population/ColdClassPolicy');
const Diagnostics = require('../../../src/GameServer/Bot/Economy/EconomyDiagnostics');
const PopulationConfig = require('../../../src/GameServer/Bot/Population/PopulationConfig');

const START = 1_750_000_000_000;
// A potion or gap-heal term is named when the hunt uses this many per kill.
const COUNT_TERM = 0.1;

// The builder's species spot and creation kit (hunt-table.js, whose functions
// are not exported: that file is a stamped input of the table).
function speciesSpot(spot, selfId) {
    const entries = spot.npcEntries.filter(entry => Number(entry.selfId) === selfId);
    const total = spot.npcEntries.reduce((sum, entry) => sum + Math.max(1, Number(entry.count) || 1), 0);
    const count = entries.reduce((sum, entry) => sum + Math.max(1, Number(entry.count) || 1), 0);
    const levelCounts = {};
    for (const entry of entries) levelCounts[entry.level] = (levelCounts[entry.level] || 0) + Math.max(1, Number(entry.count) || 1);
    return { ...spot, npcEntries: entries, npcSelfIds: [selfId], npcNames: [entries[0].name],
        density: (Number(spot.density) || 1) * count / total, levelCounts,
        dominantLevels: Object.entries(levelCounts).map(([level, held]) => ({ level: Number(level), count: held })).sort((a, b) => b.count - a.count) };
}
function creationKit(classId) {
    const Data = invoke('GameServer/DataCache'), Starter = invoke('GameServer/Knowledge/StarterItemCatalog');
    const rows = Starter.starterRows(Data.newbieItems, classId, Data.items);
    return bot => {
        const inventory = {};
        for (const row of rows) inventory[String(row.selfId)] = row.equipped
            ? { selfId: Number(row.selfId), amount: 1, equipped: true, equippedCount: 1, equippedSlots: [row.slot], slot: row.slot }
            : { selfId: Number(row.selfId), amount: Number(row.amount) || 1 };
        bot.inventory = inventory;
    };
}

const hpOrMp = need => need.hp < RP.THRESHOLDS.solo.hp ? 'hp' : 'mp';

// One hunt (Generator.hunt's arguments) watched step by step. A round's combat
// is budgeted from the interval before its timestamp (its elapsedMs, the bot's
// clock to the round), so that interval splits into the round's fight, walk and
// other (the budget less the combat, below zero where the fight ran past it).
// A gap after a resting step is rest; after a death, or the revive that ends it,
// death recovery; a gap that ends at a step with no fight is other. The parts
// tile the clock from the first round's budget (before the hunt's start) to the
// last gap a round credited: their sum is the hunt's time + edgeMs.before -
// edgeMs.tail, the tail being the gap after the last step that the next round,
// past the hunt's end, would have taken as its budget.
function watchHunt({ spot, line, level, form, hours, classId, kit }) {
    const end = START + hours * 3600000;
    const real = { resolveSolo: BR.resolveSolo, atVitals: ER.atVitals, evaluate: ER.evaluate, needsRest: RP.needsRest, select: CCPol.select,
        diagnostics: PopulationConfig.developerDiagnostics };
    let rec = null, prev = null, mark = null, stepNeed = null;
    const fresh = () => ({ parts: { fight: 0, walk: 0, rest: 0, death: 0, other: 0 }, edgeMs: { before: 0, tail: 0 },
        reportedRest: 0, restReasons: {}, marks: [], seen: { profiles: null, view: null, fp: null } });
    // The gap after the previous step up to the next one (nextKind null: the hunt's end).
    const close = (next, nextKind) => {
        const d = Math.min(next, end) - prev.t, parts = rec.parts;
        if (prev.kind === 'dead' || prev.died) parts.death += d;
        else if (prev.resting) {
            parts.rest += d;
            if (prev.kind !== 'rest') {
                const why = rec.restReasons[prev.reason] ||= { n: 0, ms: 0, asked: 0 };
                why.n += 1; why.ms += d; why.asked += prev.kind === 'hunt' ? Math.max(0, prev.restUntil - prev.t) : d;
            }
        } else if (nextKind === 'hunt') return; // the next round's budget, split by that round
        else if (nextKind) parts.other += d;
        else rec.edgeMs.tail += d;
    };
    BR.resolveSolo = options => {
        if (options.timestamp === START) { rec = fresh(); prev = null; mark = null; Diagnostics.reset(); }
        const state = options.state, dead = state.activity === 'dead' || Number(state.vitals?.hp) <= 0;
        const kind0 = dead ? 'dead' : state.activity === 'resting' ? 'rest' : null;
        stepNeed = null;
        const marksBefore = rec.marks.length, fleesBefore = fleeCount();
        const result = real.resolveSolo(options);
        const debug = result.debug || {}, patch = result.patch || {};
        const kind = kind0 || (Number.isFinite(debug.combatMs) ? 'hunt' : 'other');
        const resting = patch.activity === 'resting';
        const restUntil = Number(patch.stats?.restUntil) || 0;
        const c = kind === 'hunt' ? Number(debug.combatMs) : 0, walk = Number(debug.walkedMs) || 0;
        // A round runs from its budget's start to its last action's end (doneAt); the seated
        // part of a rest inside it is rest.
        const from = ColdClock.doneAt(result) ?? options.timestamp, seated = Number(debug.seatedMs) || 0;
        if (prev) close(options.timestamp, kind);
        if (kind === 'hunt') {
            const parts = rec.parts;
            parts.walk += walk;
            parts.fight += c - walk;
            parts.rest += seated;
            parts.other += from - (options.timestamp - options.elapsedMs) - c - seated;
            if (!prev) rec.edgeMs.before += options.elapsedMs;
        }
        // The rest the builder's sums count: every step's but a dead bot's, sat or not.
        if (state.activity !== 'dead') rec.reportedRest += seated + Math.max(0, restUntil - from);
        if (debug.died && rec.marks.length) rec.marks[rec.marks.length - 1].died = true;
        let reason = debug.reason || 'other';
        if (kind === 'hunt' && resting) {
            const last = rec.marks.length > marksBefore ? rec.marks[rec.marks.length - 1] : null;
            if (fleeCount() > fleesBefore) reason = 'fled';
            else if (last && last.actions === 0 && last.ready === false) reason = 'before_not_ready';
            else if (last && last.actions === 0 && last.need) reason = `before_${hpOrMp(last)}`;
            else if (stepNeed) reason = `after_${hpOrMp(stepNeed)}`;
            else reason = patch.stats?.lastReason || 'other';
        }
        prev = { t: from, kind, died: debug.died === true, resting, restUntil, reason };
        return result;
    };
    ER.atVitals = (profiles, hp, mp, pet) => {
        const owner = profiles.find(profile => profile.servitor !== true);
        rec.seen.profiles ||= profiles;
        mark = { hp, mp, maxHp: owner.maxHp, maxMp: owner.maxMp, actions: 0, casts: 0, skills: {}, ready: null, need: null, died: false };
        rec.marks.push(mark);
        return real.atVitals(profiles, hp, mp, pet);
    };
    ER.evaluate = (remaining, target, attacksOf) => {
        const verdict = real.evaluate(remaining, target, attacksOf);
        // A fight's own readiness read (the builder also reads the matchup before the hunt's first step).
        if (mark && mark.ready === null) { mark.ready = verdict.ready; rec.seen.view ||= target; }
        return verdict;
    };
    RP.needsRest = (subject, hpRatio, mpRatio, options) => {
        const out = real.needsRest(subject, hpRatio, mpRatio, options);
        if (mark && mark.actions === 0 && mark.need === null) mark.need = out;
        else if (mark && mark.actions > 0) stepNeed = out ? { hp: hpRatio, mp: mpRatio } : null;
        return out;
    };
    CCPol.select = (profile, context) => {
        const selected = real.select(profile, context);
        if (!context?.prepare && mark) {
            rec.seen.fp ||= profile;
            const skill = selected?.skill || null, key = skill ? String(skill.selfId) : 'weapon';
            mark.actions += 1;
            if (skill) mark.casts += 1;
            mark.skills[key] = (mark.skills[key] || 0) + 1;
        }
        return selected;
    };
    PopulationConfig.developerDiagnostics = true;
    try {
        const sum = Generator.hunt(spot, line, level, form, hours, undefined, kit, classId);
        if (prev) close(end, null);
        const counts = Diagnostics.metrics().counts || {};
        rec.restPotions = Number(counts['cold_fight:potion:rest'] || 0);
        return { sum, rec };
    } finally {
        Object.assign(BR, { resolveSolo: real.resolveSolo });
        Object.assign(ER, { atVitals: real.atVitals, evaluate: real.evaluate });
        RP.needsRest = real.needsRest;
        CCPol.select = real.select;
        PopulationConfig.developerDiagnostics = real.diagnostics;
        Diagnostics.reset();
    }
}

function fleeCount() {
    const counts = Diagnostics.metrics().counts || {};
    return Object.entries(counts).filter(([key]) => key.startsWith('cold_fight:flee:')).reduce((sum, [, n]) => sum + n, 0);
}

const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const pct = (values, p) => { if (!values.length) return null; const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

// A watched hunt per kill: the cell the builder writes, the wall parts (s per
// kill; their sum in ms is the hunt's time + edgeMs.before - edgeMs.tail), rest reasons, start vitals, rotation, potions and fatal fights.
function summarize({ sum, rec }, hours) {
    const mobs = sum.mobs, perKill = ms => mobs > 0 ? ms / 1000 / mobs : null;
    const fights = rec.marks.filter(m => m.actions > 0);
    const skills = {};
    for (const m of fights) for (const [key, n] of Object.entries(m.skills)) skills[key] = (skills[key] || 0) + n;
    const actions = fights.reduce((a, m) => a + m.actions, 0), casts = fights.reduce((a, m) => a + m.casts, 0);
    return {
        cell: HuntTable.cellOf(sum), mobs, deaths: sum.deaths,
        wall: Object.fromEntries(Object.entries(rec.parts).map(([k, ms]) => [k, perKill(ms)])),
        wallMs: { ...rec.parts }, edgeMs: { ...rec.edgeMs }, reportedRestMs: rec.reportedRest,
        restReasons: Object.fromEntries(Object.entries(rec.restReasons).map(([k, r]) => [k, { n: r.n, sat: perKill(r.ms), asked: perKill(r.asked) }])),
        startHp: mean(fights.map(m => m.hp / m.maxHp)), startMp: mean(fights.map(m => m.mp / Math.max(1, m.maxMp))),
        fights: fights.length, actionsPerKill: mobs > 0 ? actions / mobs : null, castsPerKill: mobs > 0 ? casts / mobs : null,
        skills: Object.fromEntries(Object.entries(skills).sort((a, b) => b[1] - a[1]).slice(0, 4)),
        potions: mobs > 0 ? sum.potions / mobs : null, restPotions: mobs > 0 ? rec.restPotions / mobs : null,
        fightPotions: mobs > 0 ? (sum.potions - rec.restPotions) / mobs : null, gapHeals: mobs > 0 ? sum.gapHeals / mobs : null,
        fatal: rec.marks.filter(m => m.died).map(m => ({ hp: m.hp / m.maxHp, mp: m.mp / Math.max(1, m.maxMp) })),
        seen: rec.seen
    };
}

// The matchup's engagement on the readiness's usual view (its pull, the area
// share at hp and mp), cooldowns fresh, per kill.
function matchupFight(p, seen, hp, mp) {
    const k = Math.max(1, Number(seen.view.pull) || 1);
    const m = Matchup.engagement({ profile: p, fp: seen.fp, mob: seen.view, k, start: { hp, mp, at: START },
        areaShare: Matchup.areaShareAt(seen.profiles, hp, mp, seen.view) });
    return { fight: m.cut ? null : m.ms / 1000 / k, actionsPerKill: m.botActions / k,
        castsPerKill: Object.values(m.casts).reduce((a, n) => a + n, 0) / k };
}

// The terms per cell (s per kill unless named a count): what the matchup
// misses from the rested line and from the measured start vitals; the largest
// seconds term is named, counts are flagged.
function terms(asIs) {
    const seen = asIs.seen, p = seen.profiles?.find(q => q.servitor !== true);
    const out = { simFight: asIs.cell[2], restAsRead: asIs.cell[3], restSat: asIs.wall.rest,
        deaths: asIs.mobs > 0 ? asIs.deaths / asIs.mobs : null };
    if (p && seen.view && seen.fp && asIs.mobs > 0) {
        const line = RP.restedLine(null);
        out.matchupRested = matchupFight(p, seen, p.maxHp * line.hp, p.maxMp * line.mp);
        out.matchupAtStart = matchupFight(p, seen, p.maxHp * asIs.startHp, p.maxMp * asIs.startMp);
    }
    const seconds = {};
    if (out.matchupRested?.fight != null && out.matchupAtStart?.fight != null) {
        seconds.mpAtStart = Math.abs(out.matchupAtStart.fight - out.matchupRested.fight);
        seconds.rotation = Math.abs(out.simFight - out.matchupAtStart.fight);
    }
    out.seconds = seconds;
    const named = Object.entries(seconds).sort((a, b) => b[1] - a[1])[0];
    out.named = [named ? named[0] : 'none'];
    if (asIs.fightPotions > COUNT_TERM) out.named.push('potions');
    if (asIs.gapHeals > COUNT_TERM) out.named.push('gapHeals');
    return out;
}

// One cell: the watched hunt and its terms.
function decompose({ spot, selfId, line, level, form, hours = 2, classId = Generator.classFor(line, level) }) {
    const hunted = selfId ? speciesSpot(spot, Number(selfId)) : spot, kit = creationKit(classId);
    const asIs = summarize(watchHunt({ spot: hunted, line, level, form, hours, classId, kit }), hours);
    const out = { asIs, terms: terms(asIs) };
    delete asIs.seen;
    return out;
}

function sample(rows, n) {
    const out = [], step = rows.length / Math.max(1, n);
    for (let i = 0; i < n && rows.length; i++) out.push(rows[Math.floor(i * step + step / 2)]);
    return out;
}

function main(argv) {
    const arg = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };
    const hours = Number(arg('hours') || 2), nAdm = Number(arg('adm') || 40), nClose = Number(arg('close') || 20);
    const catalogue = arg('catalogue'), rowsFile = arg('rows');
    if (!catalogue || !rowsFile) throw new Error('decompose: --rows <est rows json> and --catalogue <catalogue json> are required');
    Generator.loadSimulation(catalogue);
    const profiles = new Map(JSON.parse(fs.readFileSync(catalogue, 'utf8')).profiles.map(spot => [String(spot.id), spot]));
    const rows = JSON.parse(fs.readFileSync(rowsFile, 'utf8')).rows.filter(r => r.cell[0] > 0);
    const adm = rows.filter(r => r.cell[0] >= 10 && r.cell[1] <= 0.05), close = rows.filter(r => r.cell[1] > 0.005 && r.cell[1] < 1);
    const cells = [...sample(adm, nAdm).map(r => ({ r, kind: 'admitted' })), ...sample(close, nClose).map(r => ({ r, kind: 'close' }))];
    Lift.lift(true);
    const out = [];
    try {
        for (const { r, kind } of cells) {
            const [, level, spotId, selfId, form] = r.k.split('|');
            const one = decompose({ spot: profiles.get(spotId), selfId, line: String(r.line), level: Number(level), form: Number(form), hours });
            out.push({ k: r.k, line: r.line, kind, build: r.cell, estimate: r.est?.fight ?? null, ...one });
        }
    } finally { Lift.lift(false); }
    if (arg('out')) fs.writeFileSync(arg('out'), JSON.stringify(out));
    report(out);
    return out;
}

function report(out) {
    const f = v => v == null ? '-' : Number(v).toFixed(3);
    // A matchup path cut at its action cap has no fight: counted apart, not read as an error.
    const rel = (a, b) => a != null && b > 0 ? Math.abs(a - b) / b : null;
    for (const kind of ['admitted', 'close']) {
        const g = out.filter(o => o.kind === kind && o.asIs.mobs > 0);
        if (!g.length) continue;
        const named = {};
        for (const o of g) named[o.terms.named[0]] = (named[o.terms.named[0]] || 0) + 1;
        const flag = name => g.filter(o => o.terms.named.includes(name)).length;
        const q = (values, p) => f(pct(values.filter(v => v != null), p));
        const same = g.filter(o => o.build && o.asIs.cell.every((v, i) => v === o.build[i])).length;
        console.log(`${kind} cells ${g.length} (as-is cell equal to the build's: ${same}); largest term: ${JSON.stringify(named)}; potions ${flag('potions')}, gap heals ${flag('gapHeals')}`);
        for (const name of ['mpAtStart', 'rotation']) {
            const v = g.map(o => o.terms.seconds[name]);
            console.log(`  ${name} s/kill p50 ${q(v, 0.5)} p90 ${q(v, 0.9)}`);
        }
        console.log(`  fight |err| matchup rested p50 ${q(g.map(o => rel(o.terms.matchupRested?.fight, o.terms.simFight)), 0.5)} at start ${q(g.map(o => rel(o.terms.matchupAtStart?.fight, o.terms.simFight)), 0.5)} estimate ${q(g.map(o => rel(o.estimate, o.terms.simFight)), 0.5)}; matchup cut without a kill: rested ${g.filter(o => o.terms.matchupRested && o.terms.matchupRested.fight == null).length}, at start ${g.filter(o => o.terms.matchupAtStart && o.terms.matchupAtStart.fight == null).length}`);
        console.log(`  start MP p50 ${q(g.map(o => o.asIs.startMp), 0.5)}, casts/kill sim p50 ${q(g.map(o => o.asIs.castsPerKill), 0.5)} matchup ${q(g.map(o => o.terms.matchupAtStart?.castsPerKill), 0.5)}`);
        console.log(`  rest s/kill as read p50 ${q(g.map(o => o.terms.restAsRead), 0.5)}, sat ${q(g.map(o => o.terms.restSat), 0.5)}`);
        console.log(`  deaths/kill p90 ${q(g.map(o => o.terms.deaths), 0.9)}; fatal fight start HP mean ${f(mean(g.flatMap(o => o.asIs.fatal.map(d => d.hp))))}`);
        const reasons = {};
        for (const o of g) for (const [k, r] of Object.entries(o.asIs.restReasons)) reasons[k] = (reasons[k] || 0) + r.n;
        console.log(`  rest reasons (rounds): ${JSON.stringify(reasons)}`);
    }
}

module.exports = { decompose, watchHunt, summarize, terms, main, speciesSpot, creationKit };
if (require.main === module) main(process.argv.slice(2));
