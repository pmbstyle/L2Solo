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

    const easier = candidate(910003, 100, hunter.fetchLevel() - 10);
    const tooLow = candidate(910004, 100, hunter.fetchLevel() - 16);
    const recovery = { allowEasierTargets: true };
    Geo.hasLineOfSight = () => true;
    World.fetchNpcsInRadius = () => [easier];
    assert.strictEqual(Hunting.findPreferredMonster(session, hunter, 2500), null,
        'ordinary target scans retain their level band');
    assert.strictEqual(Hunting.findPreferredMonster(session, hunter, 2500, recovery), easier,
        'a stranded solo hunter can fight safe easier mobs instead of wandering forever');
    assert(session.lastTargetEvaluation.reasons.includes('easier_ground'));

    const blue = candidate(910005, 1600, hunter.fetchLevel() - 15);
    const fartherBlue = candidate(910006, 2200, hunter.fetchLevel() - 15);
    World.fetchNpcsInRadius = () => [fartherBlue, blue];
    assert.strictEqual(Hunting.findPreferredMonster(session, hunter, 2500, recovery), blue,
        'safe easier targets with negative scores must still beat an empty search walk');
    assert(session.lastTargetEvaluation.score < 0, 'the fallback must retain the relative target score');
    const incomeSession = { ...session, coldLifeState: { characterId: 2000999,
        stats: { wishFocus: ['power:2402:11'] } } };
    assert(invoke('GameServer/Bot/Economy/EquipmentIncomeRoute').economicHunt(incomeSession.coldLifeState));
    assert.strictEqual(Hunting.findPreferredMonster(incomeSession, hunter, 2500), null,
        'ordinary economic scans retain the positive-utility requirement');
    assert.strictEqual(Hunting.findPreferredMonster(incomeSession, hunter, 2500, recovery), blue,
        'recovery also handles easier targets already admitted by the economic level band');
    const graveTemplate = Data.npcs.find(npc => Number(npc.selfId) === 998);
    assert(graveTemplate, 'the real cemetery undead fixture must exist');
    const grave = new Npc(9876600, { ...utils.crushOb(graveTemplate), locX: 200, locY: 0, locZ: 0, head: 0 });
    const elder = { ...hunter, fetchClassId: () => 30, fetchLevel: () => 70,
        fetchCollectivePAtk: () => 208.7, fetchCollectiveMAtk: () => 426.4,
        fetchCollectivePDef: () => 447.6, fetchMaxHp: () => 1463.65,
        fetchMaxMp: () => 2821, fetchMp: () => 2821,
        fetchCollectiveAtkSpd: () => 394, fetchCollectiveCastSpd: () => 447,
        skillset: { skills: [owned({ selfId: 1028, level: 17, power: 82, mp: 65 })] },
        backpack: { fetchTotalWeaponKind: () => 'Weapon.Etc' } };
    const elderSession = { actor: elder, plan: 'hunting', deferredOccupation: 'power:148:7',
        coldLifeState: { stats: { wishFocus: ['power:148:7'] } } };
    World.fetchNpcsInRadius = () => [grave];
    assert.equal(Hunting.findPreferredMonster({ ...elderSession, deferredOccupation: null }, elder, 2500, recovery), null,
        'an ordinary route retains its level floor');
    assert.equal(Hunting.findPreferredMonster(elderSession, elder, 2500, recovery), grave,
        'an elder using Might of Heaven must be able to earn on safe cemetery undead while his purchase waits');
    elder.skillset.skills.push(owned({ selfId: 1031, level: 8, power: 36, mp: 30 }));
    const mirrorTemplate = Data.npcs.find(npc => Number(npc.selfId) === 636);
    const mirrorGhost = new Npc(9876601, { ...utils.crushOb(mirrorTemplate), locX: 200, locY: 0, locZ: 0, head: 0 });
    World.fetchNpcsInRadius = () => [mirrorGhost];
    assert.equal(Hunting.findPreferredMonster(elderSession, elder, 2500, recovery), mirrorGhost,
        'the elder with his cheaper Disrupt Undead rotation still needs a safe earning target below the ordinary band');

    World.fetchNpcsInRadius = () => [blue, hidden];
    assert.strictEqual(Hunting.findPreferredMonster(session, hunter, 2500, recovery), hidden,
        'an ordinary target still outranks negative-score easier recovery');
    Geo.hasLineOfSight = () => false;
    World.fetchNpcsInRadius = () => [blue];
    assert.strictEqual(Hunting.findPreferredMonster(session, hunter, 2500, recovery), null,
        'a negative-score fallback cannot chase a mob through a wall');
    Geo.hasLineOfSight = () => true;
    const tiredHunter = { ...hunter, fetchHp: () => 1 };
    const tiredSession = { actor: tiredHunter, plan: 'hunting' };
    assert.strictEqual(Hunting.findPreferredMonster(tiredSession, tiredHunter, 2500,
        { ...recovery, readyOnly: true }), null, 'easier recovery must wait for HP before the next fight');
    assert.strictEqual(tiredSession.lastEncounterReadiness.ready, false);
    World.fetchNpcsInRadius = () => [easier, hidden];
    assert.strictEqual(Hunting.findPreferredMonster(session, hunter, 2500, recovery), hidden,
        'an ordinary eligible target wins before easier-ground recovery');
    World.fetchNpcsInRadius = () => [tooLow];
    assert.strictEqual(Hunting.findPreferredMonster(session, hunter, 2500, recovery), null,
        'recovery does not exceed the existing fifteen-level earning band');
    World.fetchNpcsInRadius = () => [easier];
    assert.strictEqual(Hunting.findPreferredMonster({ ...session, partyCompanion: true }, hunter, 2500, recovery), null,
        'solo recovery cannot change a companion party target policy');
    assert.strictEqual(Hunting.findPreferredMonster({ ...session, hotBackgroundPartyId: 'hunting-party' }, hunter, 2500, recovery), null,
        'solo recovery cannot change an autonomous party target policy');
    const weak = { ...hunter, fetchCollectivePAtk: () => 1, fetchCollectivePDef: () => 1,
        fetchMaxHp: () => 10 };
    assert.strictEqual(Hunting.findPreferredMonster({ actor: weak, plan: 'hunting' }, weak, 2500, recovery), null,
        'lower-level recovery still requires a survivable encounter');
    Geo.hasLineOfSight = () => false;
    assert.strictEqual(Hunting.findPreferredMonster(session, hunter, 2500, recovery), null,
        'easier targets still require line of sight');

    // One pull rule (T140): a hot hunter judges the mob and the pack it stands
    // before, not a spot's mean. The same species alone is a fight it takes.
    const full = Matchup.soloSurvival(Matchup.actorProfiles([hunter]), Matchup.targetView(neutralNpc)).survivalRatio;
    const scale = 1.5 / full;
    const lean = { ...hunter, fetchMaxHp: () => hunter.fetchMaxHp() * scale };
    const packMate = (id, x) => Object.assign(candidate(id, x), { fetchHostile: () => false, fetchClanName: () => 'pack', fetchClanHelpRadius: () => 600 });
    const pack = [1, 2, 3, 4, 5, 6].map(n => packMate(930000 + n, 300 + n));
    const stray = Object.assign(candidate(930010, 1400), { fetchHostile: () => false, fetchClanName: () => '' });
    Geo.hasLineOfSight = () => true;
    World.fetchNpcsInRadius = () => [...pack, stray];
    assert.strictEqual(Hunting.findPreferredMonster({ actor: lean, plan: 'hunting' }, lean, 2500), stray,
        'the pack is refused, the lone mob of its species taken');
    World.fetchNpcsInRadius = () => [pack[0]];
    assert.strictEqual(Hunting.findPreferredMonster({ actor: lean, plan: 'hunting' }, lean, 2500), pack[0],
        'the same mob with its pack gone is a fight');
    const engagedMate = Object.assign(packMate(930011, 301), { fetchDestId: () => 77 });
    World.fetchNpcsInRadius = () => [pack[0], engagedMate];
    assert.strictEqual(Hunting.findPreferredMonster({ actor: lean, plan: 'hunting' }, lean, 2500), pack[0],
        'a mob on another target does not join the pull');

    const crowded = [1, 2, 3, 4, 5].map(n => Object.assign(candidate(920000 + n, n * 100), { fetchHostile: () => false, fetchClanName: () => '' }));
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
{
    const resistantTarget = Cold.npcCombatStats(template);
    let safeArcher = { ...archer, maxHp: 10000, pDef: 100 };
    // The ratio is affine in HP (the bow's opening shots come on top): a few
    // rescales settle it at 1.6.
    for (let pass = 0; pass < 6; pass++) {
        const ratio = Matchup.soloSurvival([safeArcher], resistantTarget).survivalRatio;
        safeArcher = { ...safeArcher, maxHp: safeArcher.maxHp * 1.6 / ratio };
    }
    assert(Matchup.spotMatchup(immuneSpot, [safeArcher], { soloSafety: true }).eligible);
    assert(!Matchup.spotMatchup(immuneSpot, [safeArcher], { soloSafety: false }).eligible,
        'party hunts retain the resistance gate');
    assert.strictEqual(Cold.npcForSpot(immuneSpot, () => 0, { matchupProfiles: [safeArcher], soloSafety: true }).selfId,
        template.selfId, 'cold solo picks the resisted mob it survives');
    const packSpot = { ...immuneSpot, npcEntries: [{ selfId: template.selfId, count: 10, pull: 5 }] };
    assert.strictEqual(Matchup.spotMatchup(packSpot, [safeArcher], { soloSafety: true }).eligible, false,
        'a route cannot admit a lethal pack using the survival verdict for a single mob');
    assert(Cold.npcForSpot(packSpot, () => 0, { matchupProfiles: [safeArcher], soloSafety: true }).avoided,
        'cold target selection must honor the same pack pressure as hot hunting');
    assert(Matchup.spotMatchup(immuneSpot, [safeArcher], { soloSafety: true }).eligible,
        'a pack verdict cannot poison a later single-mob spot');
    assert(Cold.npcForSpot(immuneSpot, () => 0, { matchupProfiles: [safeArcher] }).avoided);
    const originalScan = World.fetchNpcsInRadius, originalSight = Geo.hasLineOfSight, originalScore = Scorer.score;
    const checked = [];
    try {
        World.fetchNpcsInRadius = () => [hot];
        Geo.hasLineOfSight = () => true;
        Scorer.score = context => { checked.push(context.targetMatchup); return originalScore(context); };
        Hunting.findPreferredMonster({ actor: hunter, plan: 'hunting' }, hunter, 2500);
        assert(checked.length > 0 && checked.every(match => match.eligible),
            'hot solo candidates use the same survival gate for resistant mobs');
    } finally {
        World.fetchNpcsInRadius = originalScan; Geo.hasLineOfSight = originalSight; Scorer.score = originalScore;
    }
}
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
assert.strictEqual(skipped.patch.stats.lastReason, 'no_safe_solo_target');
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
// The hot solo gate reads the cold fight's monster (ColdCombatProfile.npcCombatStats
// of its template under its live numbers) and the bot's live hit numbers: a
// caster mob's view carries its spells, and the gate's ratio is the cold
// one for the same mob and stats.
{
    const NpcSkills = invoke('GameServer/Npc/NpcSkills'), NpcCombatChoice = invoke('GameServer/Npc/NpcCombatChoice');
    const ColdMobAction = invoke('GameServer/Bot/Population/ColdMobAction');
    const HuntCycle = invoke('GameServer/Bot/AI/HuntCycle');
    const casterTemplate = Data.npcs.find(n => n.template?.level >= 25 && n.template.level <= 35
        && NpcSkills.combatSkillsFor({ fetchSelfId: () => n.selfId })
            .some(s => s.fetchSpell?.() === true && NpcCombatChoice.category(s) === 'damage'));
    const casterNpc = new Npc(9876546, { ...utils.crushOb(casterTemplate), locX: 0, locY: 0, locZ: 0, head: 0 });
    const view = Matchup.targetView(casterNpc), cold = Cold.npcCombatStats(casterTemplate);
    assert.strictEqual(view.selfId, casterTemplate.selfId, 'the view names its species (its skills)');
    const p = { ...Cold.fightProfile(HuntCycle.referenceState(2, 30), 0), skills: [] };
    const actor = { fetchClassId: () => p.classId, fetchLevel: () => p.level, fetchCollectivePAtk: () => p.pAtk,
        fetchCollectiveMAtk: () => p.mAtk, fetchCollectiveAtkSpd: () => p.atkSpd, fetchCollectiveCastSpd: () => p.castSpd,
        fetchMaxMp: () => p.maxMp, fetchMp: () => p.maxMp, fetchMaxHp: () => p.maxHp, fetchHp: () => p.maxHp,
        fetchCollectivePDef: () => p.pDef, fetchCollectiveMDef: () => p.mDef, fetchCollectiveAccur: () => p.accur,
        fetchCollectiveEvasion: () => p.evasion, fetchCollectiveCritical: () => p.critical, fetchStr: () => p.str, fetchDex: () => p.dex,
        skillset: { skills: [] }, backpack: { fetchTotalWeaponKind: () => p.equipment.weaponKind,
            fetchTotalWeaponPAtkRnd: () => p.equipment.pAtkRnd, fetchTotalShieldPDef: () => p.equipment.shieldPDef,
            fetchTotalShieldRate: () => p.equipment.shieldRate,
            fetchEquippedWeapon: () => ({ fetchAttackReuseDelay: () => p.equipment.attackReuseDelay }) } };
    const hotProfiles = Matchup.actorProfiles([actor]);
    assert(ColdMobAction.actionMix(view, { profile: hotProfiles[0] }).spellShare > 0, 'its spells are in the hits the gate expects');
    const hotRatio = Matchup.soloSurvival(hotProfiles, view).survivalRatio;
    assert(hotRatio > 0);
    assert.strictEqual(hotRatio, Matchup.soloSurvival(Matchup.coldProfiles(p, {}, 0), cold).survivalRatio, 'hot and cold gates agree');

    // A bot that sits for MP (RestPolicy.sitsForMana: a Paladin heals itself
    // with it) fights with its weapon: its gate reads the normal attack
    // however strong its skills; a Gladiator's reads its skills.
    const boosted = q => ({ ...q, skills: q.skills.map(s => s.passive ? s : { ...s, power: Number(s.power || 0) * 100 }) });
    const bare = q => ({ ...q, skills: q.skills.filter(s => s.passive) });
    const ratio = q => Matchup.soloSurvival(Matchup.coldProfiles(q, {}, 0), cold).survivalRatio;
    const paladin = Cold.fightProfile(HuntCycle.referenceState(5, 40), 0), gladiator = Cold.fightProfile(HuntCycle.referenceState(2, 40), 0);
    assert.strictEqual(ratio(boosted(paladin)), ratio(bare(paladin)), 'a Paladin\'s gate is its weapon fight');
    assert(ratio(boosted(gladiator)) > 2 * ratio(bare(gladiator)), 'a Gladiator\'s counts its skills');
}
console.log('Bot resistance-aware targets, spells, spots, parties and cold reward checks passed');
