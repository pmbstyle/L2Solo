'use strict';
// The expected fight of one solo engagement: a bot and one rolled pull of a
// mob species, from the state the fight starts in (HP, MP, cooldowns still
// running, a bottle still running), through the game's own rules: the pull as
// one mob packed by the bot's area share (BotPullEstimate.pullView), the bot's
// turn as the cold fight takes it (a bottle first, then the solo self-heal,
// then the game's pick, BackgroundResolver.combat.chooseSkill), action delays,
// the mob's mean action and pace on the fighter it strikes
// (ColdMobAction.actionMix). The turns follow the expected state (the policy
// decides from the expected HP, MP and mob HP left), but the kill is the
// game's: the pull dies at the first action whose rolled damage reaches its HP,
// so the pull's HP left is carried as a distribution, each bot attack
// convolved with that attack's hit distribution drawn from the game's own roll
// (BackgroundResolver.combat.attackDamage, a seeded stream per pick). Every
// event counts with the chance the pull is still alive at it; the time, the
// mob's actions and the damage's mean and second moment follow from the kill
// action's distribution. It answers the engagement's time, the bot's actions
// and casts, MP and bottles spent, the damage taken with its second moment and
// the cooldowns left. The bot's death does not stop the fight (the tail of the
// damage over HP is the caller's).
// Pure: plain profiles and numbers in, numbers out; no World or DB; seeded rolls.
// Callers: the economy model's fight tools (offline).
require('../../../src/Global');

const BR = invoke('GameServer/Bot/Population/BackgroundResolver');
const CCPol = invoke('GameServer/Bot/Population/ColdClassPolicy');
const CCP = invoke('GameServer/Bot/Population/ColdCombatProfile');
const CMA = invoke('GameServer/Bot/Population/ColdMobAction');
const ER = invoke('GameServer/Bot/AI/BotEncounterReadiness');
const Pull = invoke('GameServer/Bot/AI/BotPullEstimate');
const SoloSelfHeal = invoke('GameServer/Bot/AI/SoloSelfHeal');
const Potions = invoke('GameServer/Bot/AI/HealingPotionStock');
const TendencyRoll = invoke('GameServer/Bot/AI/TendencyRoll');
const Rules = invoke('GameServer/Skills/C4SkillRules');

// A fight that has not killed the pull after this many bot actions is cut: the
// bot cannot hurt it in any time a hunt allows.
const MAX_ACTIONS = 400;
// A drunk bottle holds the bot's next action this long (the cold fight's potion turn).
const POTION_MS = 250;
// The pull's HP left in this many equal bins; one pick's hit as this many
// equal-mass atoms of this many seeded draws of the game's roll, the draws
// stratified (STRATA). Measured on the 120 admitted cells of the 1-19 hunt
// table against the replayed game fight: from 1024 stratified draws (64
// atoms) down to 128 the time per kill and the damage per engagement move by
// at most 0.001 at the median; at 32 atoms the time moves by 0.003. About
// 1.8 ms per engagement at 128 draws, 5.7 ms at 1024.
const HP_BINS = 256;
const HIT_ATOMS = 64;
const HIT_DRAWS = 128;
// The first uniforms of one hit (hit or land, crit, spread) are stratified:
// draw i's k-th uniform is the i-th of a shuffled column of one value per
// equal stratum of [0, 1), so the draws cover each outcome in proportion. A
// hit takes up to five (a lethal strike's rolls); the ones past STRATA come
// straight from the stream (stratifying five measured the same on the 120
// cells).
const STRATA = 3;
// The fight ends when the chance the pull still lives falls below DEAD; one
// still alive above CUT at MAX_ACTIONS is cut.
const DEAD = 1e-5;
const CUT = 0.01;

// One mob of a pull view (the inverse of BotPullEstimate.pullView).
function oneMob(view) {
    if (!(Number(view?.pull) > 1)) return view;
    const one = { ...view, maxHp: view.maxHp / view.pull, pAtk: view.unitPAtk, pull: 1 };
    delete one.pack;
    delete one.unitPAtk;
    return one;
}

// The share of the bot's damage by area skills that packs a pull: the solo
// readiness read at the bot's vitals on the species' usual pull, as the cold
// fight reads it before it rolls the pull.
function areaShareAt(profiles, hp, mp, mob) {
    const one = oneMob(mob);
    const usual = Pull.pullView({ ...one, pull: 1 }, Number(one.usualPull) || 1);
    return Number(ER.evaluate(ER.atVitals(profiles, hp, mp, null), usual).survival.areaShare) || 0;
}

// One pick's hit on one mob as HIT_ATOMS equal-mass atoms (ascending) of the
// game's own roll, drawn from a stream seeded by the pick and stratified per
// uniform (STRATA). Cached per pick within one engagement: its other inputs
// (the fighter's profile and state, the mob, the engagement's start time, the
// shot) are fixed there.
function hitAtoms(cache, fighter, selected, one, at, shot) {
    const key = selected?.skill ? `${selected.skill.selfId}|${selected.magic}|${selected.power}` : 'w';
    let atoms = cache.get(key);
    if (atoms) return atoms;
    const rng = TendencyRoll.seeded(key), loaded = CCP.actionShot(shot, selected?.skill || null) || null;
    const columns = Array.from({ length: STRATA }, () => {
        const column = new Float64Array(HIT_DRAWS);
        for (let i = 0; i < HIT_DRAWS; i++) column[i] = (i + rng()) / HIT_DRAWS;
        for (let i = HIT_DRAWS - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1)), v = column[i];
            column[i] = column[j];
            column[j] = v;
        }
        return column;
    });
    let i = 0, k = 0;
    const stream = () => (k < STRATA ? columns[k++][i] : rng());
    const draws = new Float64Array(HIT_DRAWS);
    for (i = 0; i < HIT_DRAWS; i++) {
        k = 0;
        draws[i] = Math.max(0, BR.combat.attackDamage(fighter, selected, one, stream, { vsMob: true, at, shot: loaded }));
    }
    draws.sort();
    atoms = new Float64Array(HIT_ATOMS);
    const per = HIT_DRAWS / HIT_ATOMS;
    for (let a = 0; a < HIT_ATOMS; a++) {
        let sum = 0;
        for (let i = a * per; i < (a + 1) * per; i++) sum += draws[i];
        atoms[a] = sum / per;
    }
    cache.set(key, atoms);
    return atoms;
}

// One engagement. profile: the bot's matchup profile (its shots); fp: its
// fight profile (class policy, hits, delays; the defender the mob strikes),
// one built for this engagement at its start as the game builds one per fight
// (ColdCombatProfile keeps its stat views per profile object);
// mob: the species (one mob or a view of it); k: the pull rolled; areaShare:
// areaShareAt at the start; start: { hp, mp, at (the fight's timestamp),
// cooldowns: { selfId: ms left }, potionLeft: ms a bottle still runs }; bag:
// the inventory the bottles come from (read only); holder: the bot's state
// (what the potion rule reads its role from, the roll's and the mob's target).
function engagement({ profile: p, fp, mob, k = 1, areaShare = 0, start, bag = null, holder = null }) {
    const view = Pull.pullView(oneMob(mob), k, areaShare), one = oneMob(view);
    const at0 = Number(start.at) || 0, maxHp = Number(fp.maxHp) || Number(p.maxHp) || 1;
    const shot = p.shot || null, mix = CMA.actionMix(view, { profile: fp, state: holder }, at0);
    const fighter = { vitals: { hp: Number(start.hp), mp: Number(start.mp), maxHp },
        cooldowns: Object.fromEntries(Object.entries(start.cooldowns || {}).map(([id, left]) => [id, at0 + Number(left)])) };
    const roller = { profile: fp, state: holder, charges: 0, cooldowns: {}, vitals: fighter.vitals };
    const vitals = fighter.vitals, atomsOf = new Map();
    // pool[b]: the chance the pull lives with b bins of HP left (bin width bw).
    const bw = view.maxHp / HP_BINS;
    let pool = new Float64Array(HP_BINS + 1), next = new Float64Array(HP_BINS + 1), alive = 1;
    pool[HP_BINS] = 1;
    let t = 0, botAt = 0, mobAt = CCP.openingMs(fp, view), turns = 0, mobAction = 0;
    let killedMs = 0, botActions = 0, mobActions = 0, mobActionsSquare = 0, potions = 0, mpSpent = 0;
    let used = 0, potionHot = null, potionUntil = at0 + Math.max(0, Number(start.potionLeft) || 0), inventory = null, pace = null;
    const casts = {};
    // A running bottle's ticks up to now (the cold fight's potion HoT; its tick
    // applier is private to the resolver).
    const ticks = now => {
        while (potionHot && potionHot.remaining > 0 && potionHot.nextAt <= now) {
            vitals.hp = Math.min(maxHp, vitals.hp + potionHot.heal);
            potionHot.remaining -= 1;
            potionHot.nextAt += potionHot.intervalMs;
        }
        if (potionHot && potionHot.remaining <= 0) potionHot = null;
    };
    const spend = (record, at) => {
        const before = vitals.mp;
        BR.combat.spendSkill(fighter, record, at);
        mpSpent += alive * (before - vitals.mp);
        casts[record.selfId] = (casts[record.selfId] || 0) + alive;
    };
    while (alive >= DEAD && turns < MAX_ACTIONS) {
        if (botAt > mobAt) {
            t = mobAt;
            ticks(t);
            // D = the sum of N iid mob actions: E[N] = sum_j P(alive at j),
            // E[N^2] = sum_j (2j - 1) P(alive at j).
            mobAction += 1;
            mobActions += alive;
            mobActionsSquare += (2 * mobAction - 1) * alive;
            vitals.hp -= mix.perAction;
            mobAt += mix.actionMs;
            continue;
        }
        t = botAt;
        ticks(t);
        const at = at0 + t;
        // One bottle per fight, none while one runs (the resolver's coldBottleFree,
        // private to it: this is its copy).
        if (!(used > 0) && !potionHot && potionUntil <= at) {
            inventory ||= { ...(bag || {}) };
            const potion = Potions.consumeColdPotion(inventory, vitals.hp, maxHp, holder);
            if (potion) {
                const effect = Potions.coldEffectFor(potion, t);
                vitals.hp = Math.min(maxHp, vitals.hp + Number(effect.immediateHeal || 0));
                potionHot = effect.hot ? { ...effect.hot } : null;
                if (effect.hot) potionUntil = at + Potions.HOT_MS;
                used += 1;
                potions += alive;
                botAt += POTION_MS;
                continue;
            }
        }
        let left = 0;
        for (let b = 1; b <= HP_BINS; b++) left += pool[b] * b;
        const mobHp = left * bw / alive;
        // The solo self-heal (SoloSelfHeal.inFight) on the fight's pace from the
        // bot's first turn; that turn only sets the pace.
        if (!pace) pace = { at: t, hp: vitals.hp, mobHp, healed: 0 };
        else {
            const actor = CCPol.actorFor(fp, { hp: vitals.hp, mp: vitals.mp, cooldowns: fighter.cooldowns, time: at, charges: 0 });
            const heal = SoloSelfHeal.inFight(actor, { mobHp, ...SoloSelfHeal.pace(pace, { at: t, hp: vitals.hp, mobHp }) });
            if (heal) {
                const before = vitals.hp, record = heal.coldRecord;
                vitals.hp = Math.min(maxHp, before + Math.max(0, SoloSelfHeal.healAmount(actor, heal, heal.fetchSemantic?.() || {}, false)));
                pace.healed += vitals.hp - before;
                spend(record, at);
                botAt += CCP.actionDelayMs(fp, record, CCP.actionShot(shot, record)?.spiritshot === true);
                continue;
            }
        }
        turns += 1;
        botActions += alive;
        const selected = BR.combat.chooseSkill(fp, vitals.hp, vitals.mp, fighter.cooldowns, at, 0, null, { mob: view, mobHp, party: false });
        const skill = selected?.skill || null;
        const atoms = hitAtoms(atomsOf, roller, selected, one, at0, shot);
        // An area skill strikes every mob of the pull, each for the full hit.
        const struck = skill && Number(view.pull) > 1 && Rules.hitsArea(Rules.resolveCached(skill)) ? Number(view.pull) : 1;
        if (skill) spend(skill, at);
        botAt += CCP.actionDelayMs(fp, skill, CCP.actionShot(shot, skill)?.spiritshot === true);
        // The pull's HP left after the hit; HP split linearly between the two
        // nearest bins, a remainder under one bin kept at one bin.
        next.fill(0);
        const w = 1 / HIT_ATOMS, scale = struck / bw;
        let lives = 0;
        for (let b = 1; b <= HP_BINS; b++) {
            const m = pool[b] * w;
            if (!m) continue;
            for (let a = 0; a < HIT_ATOMS; a++) {
                const r = b - atoms[a] * scale;
                if (r <= 0) break;
                lives += m;
                if (r < 1) { next[1] += m; continue; }
                const lo = Math.floor(r), f = r - lo;
                next[lo] += m * (1 - f);
                next[Math.min(HP_BINS, lo + 1)] += m * f;
            }
        }
        killedMs += (alive - lives) * botAt;
        [pool, next] = [next, pool];
        alive = lives;
    }
    const ms = killedMs + alive * botAt, perAction = mix.perAction;
    return { ms, botActions, casts, mpSpent, mobActions, potions, cut: alive > CUT,
        taken: { mean: perAction * mobActions, square: mobActions * Math.max(0, mix.squarePerAction - perAction ** 2) + mobActionsSquare * perAction ** 2 },
        cooldowns: Object.fromEntries(Object.entries(fighter.cooldowns).map(([id, until]) => [id, until - at0 - ms]).filter(([, left]) => left > 0)) };
}

module.exports = { engagement, areaShareAt, oneMob, MAX_ACTIONS };
