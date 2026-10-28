const assert = require('assert');

require('../src/Global');

// E72/F20: how many mobs one pull brings, for hot target choice and cold fights.
const Pull = invoke('GameServer/Bot/AI/BotPullEstimate');
const rules = { assistZ: 600, aggroRadius: 500, aggroZ: 400 };
const mob = (x, extra = {}) => ({ x, y: 0, z: 0, clan: '', helpRadius: 0, hostile: false, ...extra });

// A lone mob comes alone; passive strangers nearby stay out.
assert.strictEqual(Pull.pullSize(mob(0), [mob(100), mob(200)], rules), 1);

// Same-clan helpers inside the target's help radius join; outside it, or of another clan, they do not.
const ant = mob(0, { clan: 'ant', helpRadius: 300 });
assert.strictEqual(Pull.pullSize(ant, [ant, mob(100, { clan: 'ant' }), mob(200, { clan: 'ant' }),
    mob(290, { clan: 'ant' }), mob(400, { clan: 'ant' }), mob(150, { clan: 'wolf' })], rules), 4);
assert.strictEqual(Pull.pullSize(ant, [mob(100, { clan: 'ant', z: 700 })], rules), 1, 'help stops at the assist height');

// Aggressive mobs within the aggro radius join; a clan helper that is also aggressive counts once.
assert.strictEqual(Pull.pullSize(mob(0), [mob(450, { hostile: true }), mob(600, { hostile: true })], rules), 2);
assert.strictEqual(Pull.pullSize(ant, [mob(100, { clan: 'ant', hostile: true })], rules), 2);
assert.strictEqual(Pull.pullSize(mob(0), [mob(100, { hostile: true, z: 450 })], rules), 1, 'aggro stops at its height');

// A leader brings its minions; minion actors are counted through their group, not again as neighbours.
assert.strictEqual(Pull.pullSize(mob(0), [mob(100, { hostile: true, minion: true })], rules, 3), 4);

// Minion groups from the Lisvus rows: a leader brings the mean of each group, a minion its leader and siblings.
const groups = new Map([[520, [{ minionId: 445, min: 3, max: 5 }, { minionId: 446, min: 1, max: 1 }]]]);
const joiners = Pull.minionJoiners(groups);
assert.strictEqual(joiners.get(520), 5);
assert.strictEqual(joiners.get(445), 5, 'a hit minion alerts the leader and the rest of the group');
assert.strictEqual(joiners.get(1), undefined);

// The start-time table: one mean pull per spawn group (spot entry), set only where it is above one.
const spot = {
    npcEntries: [{ selfId: 10, count: 2 }, { selfId: 20, count: 1 }, { selfId: 30, count: 1 }],
    records: [
        mob(0, { selfId: 10, clan: 'ant', helpRadius: 300 }),
        mob(5000, { selfId: 10, clan: 'ant', helpRadius: 300 }),
        mob(100, { selfId: 20, clan: 'ant' }),
        mob(3000, { selfId: 30 })
    ]
};
const size = Pull.annotate([spot], rules, new Map([[30, 2]]));
assert.strictEqual(spot.npcEntries[0].pull, 1.5, 'one of two ants has a clanmate in its help radius');
assert.strictEqual(spot.npcEntries[1].pull, undefined, 'a mob without help radius pulls alone');
assert.strictEqual(spot.npcEntries[2].pull, 3, 'a leader brings its minions');
assert.strictEqual(spot.records, undefined, 'the spawn records are dropped once the table is built');
assert.deepStrictEqual(size, { entries: 3, pulls: 2 });
assert.strictEqual(Pull.entryPull(spot, 30), 3);
assert.strictEqual(Pull.entryPull(spot, 20), 1);
assert.strictEqual(Pull.entryPull(null, 30), 1);

// A pull of k is one mob with k times the HP and the mean attack of the mobs still standing.
assert.deepStrictEqual(Pull.pullView({ maxHp: 100, pAtk: 10, pDef: 5 }, 3), { maxHp: 300, pAtk: 20, pDef: 5, pull: 3 });
const single = { maxHp: 100, pAtk: 10 };
assert.strictEqual(Pull.pullView(single, 1), single);

// The cold fight rolls a whole number of mobs from the mean once per new fight.
assert.strictEqual(Pull.rollPull(1, () => assert.fail('a pull of one draws nothing')), 1);
assert.strictEqual(Pull.rollPull(3, () => assert.fail('a whole pull draws nothing')), 3);
assert.strictEqual(Pull.rollPull(2.4, () => 0.39), 3);
assert.strictEqual(Pull.rollPull(2.4, () => 0.4), 2);

// Cold: the solo fight rolls its pull; the mob stays one mob for the readiness margin.
const Data = invoke('GameServer/DataCache');
Data.init();
const Cold = invoke('GameServer/Bot/Population/ColdCombatProfile');
const template = Data.npcs.find(n => n.template?.kind === 'Monster' && Number(n.template.level) === 20 && !n.template.hostile);
assert(template, 'datapack has a passive level-20 monster');
const base = Cold.npcCombatStats(template);
const coldSpot = { npcEntries: [{ selfId: template.selfId, count: 3, pull: 3 }] };
const pulled = Cold.npcForSpot(coldSpot, () => 0.5, { pull: true });
assert.strictEqual(pulled.pull, 3);
assert.strictEqual(pulled.maxHp, base.maxHp);
const alone = Cold.npcForSpot(coldSpot, () => 0.5);
assert.strictEqual(alone.pull, undefined, 'party and other callers keep one mob');
assert.strictEqual(alone.maxHp, base.maxHp);

// A won pull gives every mob's kill; the cycle reports the pull for the mobs-per-pull counter.
const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const gremlins = pull => ({ id: 'starter_gremlin', name: 'Gremlin field', avgLevel: 1, density: 1, npcSelfIds: [1],
    npcEntries: [{ selfId: 1, count: 3, ...(pull ? { pull } : {}) }],
    rewards: { exp: 10, sp: 2, adenaMin: 7, adenaMax: 10 }, mob: { hp: 8, damage: 1 } });
const hunter = () => ({ characterId: 71, name: 'ColdHunter', level: 10, levelBand: '10-12', activity: 'hunting',
    vitals: { hp: 99999, maxHp: 99999, mp: 99999, maxMp: 99999 }, stats: {}, party: { role: 'dps' } });
const hunt = pull => Resolver.resolveSolo({ state: hunter(), spot: gremlins(pull), elapsedMs: 60000, rng: () => 0 });
const one = hunt(0), two = hunt(2), three = hunt(3);
assert.strictEqual(one.debug.wins, 1);
assert.strictEqual(two.debug.wins, 1);
assert.deepStrictEqual([one.debug.pulls, one.debug.pullMobs], [1, 1]);
assert.deepStrictEqual([two.debug.pulls, two.debug.pullMobs], [1, 2]);
assert.strictEqual(two.materialize.exp, one.materialize.exp * 2, 'each mob of the pull gives its exp');
assert.strictEqual(two.materialize.items.length, one.materialize.items.length * 2, 'each mob rolls its drops');
assert(two.debug.combatMs > one.debug.combatMs, 'two mobs take longer to kill');
// Helpers come with the target, so a voluntary pull above the hunter's
// full-health margin must be refused before it starts.
assert.deepStrictEqual([three.debug.pulls, three.debug.pullMobs], [0, 0]);
assert.strictEqual(three.patch.stats.lastReason, 'no_safe_solo_target');
assert.notStrictEqual(three.patch.stats.lastReason, 'solo_recovery_needed');

// Area and aura skills hit every mob of the pull (F20, plan 3.3(в)): a nuker whose
// only spell strikes an area kills a pull of three about as fast as one mob, while
// a single-target nuker of the same damage needs three times as long.
const fieldMob = Data.npcs.find(n => n.template?.kind === 'Monster' && Number(n.template.level) === 20 && !n.template.hostile);
const nuker = selfId => ({ characterId: 72, name: 'ColdNuker', level: 20, levelBand: '20-22', activity: 'hunting',
    vitals: { hp: 99999, maxHp: 99999, mp: 99999, maxMp: 99999 }, inventory: {}, party: { role: 'dps' },
    stats: { classId: 11, coldCombat: { version: 1, classId: 11,
        base: { str: 22, dex: 21, con: 27, int: 41, wit: 20, men: 39 },
        equipment: { weaponKind: 'Weapon.Staff', pAtk: 20, pAtkRnd: 0, mAtk: 300, atkSpd: 300, critical: 0, accur: 0,
            pDef: 99999, mDef: 99999, evasion: 0, bonusMp: 20000, shieldPDef: 0 },
        // Same record for both: Flame Strike (area) and Wind Strike (one target).
        effects: [], skills: [{ selfId, level: 1, passive: false, spell: true, power: 4, mp: 20, hitTime: 2000, reuse: 1 }] } } });
const field = pull => ({ id: 'f20_field', name: 'F20 field', avgLevel: 20, density: 1, npcSelfIds: [fieldMob.selfId],
    npcEntries: [{ selfId: fieldMob.selfId, count: 3, ...(pull > 1 ? { pull } : {}) }],
    rewards: { exp: 10, sp: 2, adenaMin: 7, adenaMax: 10 }, mob: { hp: 8, damage: 1 } });
const nukeFight = (selfId, pull) => {
    const result = Resolver.resolveSolo({ state: nuker(selfId), spot: field(pull), elapsedMs: 60000, rng: () => 0.5 });
    assert.strictEqual(result.debug.wins, 1, `skill ${selfId} wins its pull of ${pull}`);
    assert(result.debug.skillUses > 1, 'the nuker casts its spell');
    return result.debug;
};
const areaOne = nukeFight(1181, 1), areaThree = nukeFight(1181, 3);
const singleOne = nukeFight(1177, 1), singleThree = nukeFight(1177, 3);
assert.strictEqual(areaOne.combatMs, singleOne.combatMs, 'equal damage against one mob');
assert(singleThree.combatMs > 2.5 * singleOne.combatMs, 'a single-target nuker kills the three one by one');
assert(areaThree.combatMs < 1.5 * areaOne.combatMs, 'an area nuker kills the three together');
assert(areaThree.areaPullHits > 0, 'the cycle reports area hits on a pull');
assert.strictEqual(singleThree.areaPullHits, 0);
assert.strictEqual(areaOne.areaPullHits, 0, 'a lone mob takes no area hits');

// The same rule in the matchup estimate a pull is judged by (hot target choice).
const Matchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
const Rules = invoke('GameServer/Skills/C4SkillRules');
const caster = sourceTarget => [{ role: 'mage', maxHp: 1000, pDef: 100, mAtk: 400, castSpd: 333, maxMp: 1000,
    skills: [{ selfId: 9001, spell: true, power: 50, mp: 10, hitTime: 2000, reuse: 1,
        semantic: { skillType: Rules.DAMAGE, target: 'enemy', sourceTarget } }] }];
const packMob = { maxHp: 1000, pAtk: 50, atkSpd: 253, pDef: 100, mDef: 100, basePDef: 100, baseMDef: 100 };
const margin = (sourceTarget, k) => Matchup.soloSurvival(caster(sourceTarget), Pull.pullView(packMob, k)).survivalRatio;
assert.strictEqual(margin('area', 1), margin(null, 1), 'one mob: area and single-target are equal');
assert(Math.abs(margin('aura', 3) / margin(null, 3) - 3) < 1e-9, 'a pull of three: the area spell counts three times');

console.log('Bot pull estimate checks passed');
