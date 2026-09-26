const assert = require('assert');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
const Matchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
const Scorer = invoke('GameServer/Bot/AI/BotTargetScorer');
const Utility = invoke('GameServer/Bot/AI/BotCombatUtility');
const Cold = invoke('GameServer/Bot/Population/ColdCombatProfile');
const ColdPolicy = invoke('GameServer/Bot/Population/ColdClassPolicy');
const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const Routes = invoke('GameServer/Bot/AI/LevelingRoutes');
const Npc = invoke('GameServer/Npc/Npc');
const Rules = invoke('GameServer/Skills/C4SkillRules');
Data.init();

const archer = { classId: 9, role: 'archer', level: 40, pAtk: 500, mAtk: 100, maxMp: 300,
    atkSpd: 300, castSpd: 333, weaponMask: 32, equipment: { weaponKind: 'Weapon.Bow' }, skills: [] };
const sword = { ...archer, classId: 0, role: 'dps', weaponMask: 4, equipment: { weaponKind: 'Weapon.Sword' } };
const normal = { maxHp: 1000, pDef: 100, mDef: 100, basePDef: 100, baseMDef: 100, vulnerabilities: {} };
const resistant = { ...normal, vulnerabilities: { bowWpnVuln: 0.1 } };
assert.strictEqual(Matchup.evaluate([archer], resistant).eligible, false);
assert.strictEqual(Matchup.evaluate([sword], resistant).efficiency, 1);
assert(Matchup.evaluate([archer, sword], resistant).eligible, 'the party can use its sword damage');
assert.strictEqual(Matchup.evaluate([archer], { ...normal, vulnerabilities: { bowWpnVuln: 0 } }).eligible, false);
const moderate = Matchup.evaluate([archer], { ...normal, vulnerabilities: { bowWpnVuln: 0.5 } });
assert(moderate.eligible && moderate.penalty > 0, 'moderate resistance lowers priority');
const context = { attackable: true, botLevel: 40, npcLevel: 40, distance: 100 };
assert(Scorer.score({ ...context, targetMatchup: moderate }).score < Scorer.score(context).score);
assert(Scorer.score({ ...context, incomingThreat: true, targetMatchup: Matchup.evaluate([archer], resistant) }).eligible,
    'resistance cannot disable self-defense');
assert(Scorer.powerRatio({ solo: true, botRole: 'mage', botPAtk: 10000, botMAtk: 100,
    botPDef: 100, botMaxHp: 1000, npcPAtk: 100, npcPDef: 100, npcMDef: 1000, npcMaxHp: 1000 }) < 1,
    'physical stats must not hide a bad magic matchup');

const spell = (selfId, power) => ({ selfId, level: 1, spell: true, passive: false,
    power, mp: 10, hitTime: 3000, distance: 900 });
const fire = spell(1230, 90), water = spell(1235, 80);
const mage = { ...archer, classId: 12, role: 'mage', weaponMask: 8,
    equipment: { weaponKind: 'Weapon.Blunt' }, skills: [fire, water] };
const fireResist = { ...normal, vulnerabilities: { fireVuln: 0.1 } };
assert(Matchup.evaluate([mage], fireResist).eligible, 'a learned water spell is an alternative');
assert(!Matchup.evaluate([{ ...mage, skills: [fire] }], fireResist).eligible);
assert(!Matchup.evaluate([mage], { ...normal, mDef: 1000 }).eligible, 'M.Def applies to all magic elements');
assert.strictEqual(Matchup.evaluate([mage], { ...normal, vulnerabilities: { mentalResist: 50, sleepVuln: 0 } }).efficiency, 1);
const unavailableWater = { ...water, semantic: { ...Rules.resolve(water), undeadOnly: true } };
assert(!Matchup.evaluate([{ ...mage, skills: [fire, unavailableWater] }], fireResist).eligible,
    'undead-only damage cannot rescue a living target matchup');
const owned = record => ({ fetchSelfId: () => record.selfId, fetchLevel: () => 1,
    fetchPassive: () => false, fetchSpell: () => true, fetchSemantic: () => Rules.resolve(record),
    fetchPower: () => record.power, fetchConsumedMp: () => record.mp,
    fetchSkillType: () => Rules.DAMAGE, fetchTargetKind: () => 'enemy', fetchDistance: () => 900 });
const actor = { fetchClassId: () => 12, fetchHp: () => 1000, fetchMaxHp: () => 1000,
    fetchMp: () => 300, fetchMaxMp: () => 300, skillset: { skills: [owned(fire), owned(water)] },
    backpack: { fetchTotalWeaponKind: () => 'Weapon.Blunt' } };
assert.strictEqual(Utility.select(actor, { fetchHp: () => 1000, matchupTarget: normal }, 'mage').skill.fetchSelfId(), 1230);
assert.strictEqual(Utility.select(actor, { fetchHp: () => 1000, matchupTarget: fireResist }, 'mage').skill.fetchSelfId(), 1235);
assert.strictEqual(ColdPolicy.select(mage, { hp: 1000, mp: 300, cooldowns: {}, time: 0, mob: fireResist }).skill.selfId, 1235,
    'cold and hot spell choices agree');

// Real datapack passives must flow through native NPCs and cold projections.
const template = Data.npcs.find(n => Cold.npcCombatStats(n).vulnerabilities.bowWpnVuln === 0.1);
assert(template, 'datapack contains a strong archery-resistant NPC');
const hot = new Npc(9876543, { ...utils.crushOb(template), locX: 0, locY: 0, locZ: 0, head: 0 });
assert.strictEqual(Matchup.targetView(hot).vulnerabilities.bowWpnVuln, 0.1);
assert(!Matchup.evaluate([archer], Matchup.targetView(hot)).eligible);
assert(!Matchup.evaluate([archer], Cold.npcCombatStats(template)).eligible);
const magicTemplate = Data.npcs.find(n => Cold.npcCombatStats(n).mDef >= n.stats.mDef * 3);
assert(magicTemplate, 'datapack contains a strong magic-defense passive');
const magicNpc = new Npc(9876545, { ...utils.crushOb(magicTemplate), locX: 0, locY: 0, locZ: 0, head: 0 });
assert(Matchup.evaluate([mage], Matchup.targetView(magicNpc)).efficiency < 0.34);
assert(Matchup.evaluate([mage], Cold.npcCombatStats(magicTemplate)).efficiency < 0.34);
const Hunting = invoke('GameServer/Bot/AI/States/HuntingState');
const World = invoke('GameServer/World/World');
const Geo = invoke('GameServer/Geodata/GeodataEngine');
const neutralNpc = new Npc(9876544, { ...utils.crushOb(template), locX: 200, locY: 0, locZ: 0, head: 0 });
neutralNpc.fetchPassiveSkills = () => [];
const hunter = { ...actor, fetchClassId: () => 9, fetchLevel: () => template.template.level,
    fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0,
    fetchCollectivePAtk: () => 10000, fetchCollectiveMAtk: () => 100,
    fetchCollectivePDef: () => 10000, fetchMaxHp: () => 100000,
    backpack: { fetchTotalWeaponKind: () => 'Weapon.Bow' }, skillset: { skills: [] } };
const savedScan = World.fetchNpcsInRadius, savedSight = Geo.hasLineOfSight;
try {
    World.fetchNpcsInRadius = () => [hot, neutralNpc];
    Geo.hasLineOfSight = () => true;
    const session = { actor: hunter, plan: 'hunting' };
    assert.strictEqual(Hunting.findPreferredMonster(session, hunter, 2500), neutralNpc,
        'the native hunt scan must skip the closer arrow-resistant mob');

    const candidate = (id, x, level = hunter.fetchLevel()) => Object.assign(Object.create(neutralNpc), {
        fetchId: () => id, fetchLocX: () => x, fetchLevel: () => level
    });
    const local = candidate(910001, 100, hunter.fetchLevel() - 7);
    const hidden = candidate(910002, 500);
    World.fetchNpcsInRadius = () => [local, hidden];
    Geo.hasLineOfSight = (_x, _y, _z, x) => x === 100;
    assert.strictEqual(Hunting.findPreferredMonster(session, hunter, 2500), local,
        'a preferred level behind a wall must not beat a visible weaker monster');

    const crowded = [1, 2, 3, 4, 5].map(n => candidate(920000 + n, n * 100));
    World.fetchNpcsInRadius = () => crowded;
    const checked = [];
    Geo.hasLineOfSight = (_x, _y, _z, x) => { checked.push(x); return x === 500; };
    assert.strictEqual(Hunting.findPreferredMonster(session, hunter, 2500), null,
        'the unchecked fifth candidate cannot win after the first four fail visibility');
    assert.deepStrictEqual(checked, [100, 200, 300, 400], 'visibility work stays bounded');
    assert.strictEqual(session.huntTargetScanPending, true);
    assert.strictEqual(Hunting.findPreferredMonster(session, hunter, 2500), crowded[4],
        'the next scan must reach a visible candidate beyond the blocked prefix');
    assert.deepStrictEqual(checked, [100, 200, 300, 400, 500]);
    assert.strictEqual(session.huntTargetScanPending, false);
    Geo.hasLineOfSight = () => false;
    assert.strictEqual(Hunting.findPreferredMonster(session, hunter, 2500), null);
    assert.strictEqual(Hunting.findPreferredMonster(session, hunter, 2500), null);
    assert.strictEqual(session.huntTargetScanPending, false, 'an exhausted hidden-only scan must finish');

    // Changes between batches must not leave a dead cursor or skip the new
    // room after movement. A replacement list is searched from its start.
    Hunting.findPreferredMonster(session, hunter, 2500);
    World.fetchNpcsInRadius = () => [local];
    Geo.hasLineOfSight = () => true;
    assert.strictEqual(Hunting.findPreferredMonster(session, hunter, 2500), local);
} finally {
    World.fetchNpcsInRadius = savedScan;
    Geo.hasLineOfSight = savedSight;
}
const immuneSpot = { id: 'resist-test', minLevel: 35, maxLevel: 45, avgLevel: 40,
    density: 10, npcEntries: [{ selfId: template.selfId, count: 10 }], mob: { hp: 1, damage: 1 },
    rewards: { exp: 100, sp: 10, adenaMin: 10, adenaMax: 10 } };
assert(Cold.npcForSpot(immuneSpot, () => 0, { matchupProfiles: [archer] }).avoided);
assert.strictEqual(Routes.bestSpot([immuneSpot], { level: 40 }, { matchupProfiles: [archer] }), null);
assert(Routes.bestSpot([immuneSpot], { level: 40 }, { matchupProfiles: [archer, sword] }));
const neutralTemplate = { ...template, selfId: 9876546 };
Data.npcs.push(neutralTemplate);
try {
    const moderateTemplate = Data.npcs.find(n => Cold.npcCombatStats(n).vulnerabilities.bowWpnVuln === 0.5);
    const mixedSpot = { ...immuneSpot, npcEntries: [
        { selfId: moderateTemplate.selfId, count: 1 }, { selfId: neutralTemplate.selfId, count: 1 }
    ] };
    let neutralPicks = 0;
    for (let i = 0; i < 100; i++) {
        if (Cold.npcForSpot(mixedSpot, () => (i + 0.5) / 100, { matchupProfiles: [archer] }).selfId === neutralTemplate.selfId) neutralPicks++;
    }
    assert(neutralPicks >= 75, 'cold hunting prefers unresisted mobs at equal spawn density');
    assert(Routes.scoreSpot(mixedSpot, { level: 40 }, { matchupProfiles: [archer] }).targetMatchup.penalty > 0);
    const oldHostile = template.template.hostile;
    try {
        template.template.hostile = true;
        const interrupted = Cold.npcForSpot({ ...mixedSpot, npcEntries: [
            { selfId: neutralTemplate.selfId, count: 1 }, { selfId: template.selfId, count: 1 }
        ] }, () => 0, { matchupProfiles: [archer], preferredNpcId: neutralTemplate.selfId, aggressiveInterruptionChance: 1 });
        assert.strictEqual(interrupted.selfId, template.selfId, 'an aggressive add is not erased by voluntary target filtering');
    } finally { template.template.hostile = oldHostile; }
} finally { Data.npcs.pop(); }

const state = { characterId: 98765, level: 40, activity: 'hunting', vitals: { hp: 1000, mp: 300 },
    stats: { classId: 9, coldCombat: { ...archer, version: 1, base: { str: 40, dex: 30, con: 43, int: 21, wit: 11, men: 25 },
        equipment: { ...archer.equipment, pAtk: 500, mAtk: 100, pDef: 200, mDef: 100, atkSpd: 300 } } } };
const skipped = Resolver.resolveSolo({ state, spot: immuneSpot, elapsedMs: 60000, timestamp: Date.now(), rng: () => 0.5 });
assert.strictEqual(skipped.materialize.exp, 0, 'no synthetic fallback reward after rejecting real targets');
assert.strictEqual(skipped.debug.combatActions, 0);
assert.strictEqual(skipped.patch.stats.lastReason, 'target_resistance');
assert(Resolver.resolvePartyFight({ members: [state, { ...state, characterId: 98766 }], spot: immuneSpot, rng: () => 0.5 }).avoided);

const summoned = Matchup.coldProfiles(mage, { stats: { coldCombat: { summon: {
    active: true, hp: 1000, maxHp: 1000, expiresAt: 2000, pAtk: 500, atkSpd: 300
} } } }, 1000);
assert(Matchup.evaluate(summoned, { ...normal, mDef: 1000 }).eligible, 'physical summon damage rescues a magic-resistant target');
assert.strictEqual(Matchup.coldProfiles(mage, { stats: { coldCombat: { summon: {
    active: true, hp: 0, expiresAt: 2000
} } } }, 1000).length, 1, 'a dead summon provides no damage');
const summonerState = { level: 40, stats: { classId: 14 } };
const summoner = Cold.profileFor(summonerState);
assert(Cold.summonSkills(summoner).length);
assert.strictEqual(Matchup.coldProfiles(summoner, summonerState).length, 2,
    'a summoner can plan around an affordable available servitor before summoning');
assert.strictEqual(Matchup.coldProfiles(summoner, { vitals: { mp: 0 } }).length, 1,
    'an unaffordable summon is not an alternative damage source');
console.log('Bot resistance-aware targets, spells, spots, parties and cold reward checks passed');
