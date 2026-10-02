const assert = require('assert');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
const Matchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
const Cold = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Hunting = invoke('GameServer/Bot/AI/BotHuntingTargetPolicy');
Data.init();

// Uncached reference: the per-species verdict and the spot aggregation of
// BotTargetMatchup.spotMatchup, computed from scratch for every call.
function referenceMatchup(spot, profiles, options = {}) {
    if (!profiles?.length) return Matchup.evaluate([], {});
    let total = 0, effective = 0, eligible = false, safe = 0;
    for (const entry of spot.npcEntries || []) {
        const npc = Data.npcs.find((candidate) => Number(candidate.selfId) === Number(entry.selfId));
        if (!npc || !Hunting.canHunt(npc)) continue;
        const target = Cold.npcCombatStats(npc);
        const match = Matchup.evaluate(profiles, target);
        const survival = options.soloSafety ? Matchup.soloSurvival(profiles, target) : { eligible: true };
        const canHunt = match.eligible && survival.eligible
            && (!options.maxTargetLevel || Number(npc.template?.level || 0) <= options.maxTargetLevel);
        const weight = Math.max(1, Number.isFinite(Number(entry.count)) ? Number(entry.count) : 1);
        total += weight;
        effective += weight * Math.min(1, match.efficiency);
        eligible ||= canHunt;
        if (canHunt) safe += weight;
    }
    const efficiency = total ? effective / total : 1;
    const safeFraction = total ? safe / total : 1;
    return { efficiency, safeFraction,
        eligible: !total || (eligible && (!options.soloSafety || safeFraction >= 0.6)),
        penalty: Math.round((1 - efficiency) * 250 + (options.soloSafety ? (1 - safeFraction) * 250 : 0)) };
}

const monsters = Data.npcs.filter((npc) => npc.template?.kind === 'Monster' && Hunting.canHunt(npc));
const byLevel = (level) => monsters.filter((npc) => Number(npc.template.level) === level);
const species = [...byLevel(10).slice(0, 3), ...byLevel(20).slice(0, 3), ...byLevel(40).slice(0, 3)];
assert(species.length === 9, 'the datapack must contain level 10, 20 and 40 monsters');
const spot = { id: 'shared_verdict_test', npcEntries: species.map((npc, i) => ({ selfId: npc.selfId, count: 1 + i % 3 })) };
const optionSets = [{ soloSafety: true }, { soloSafety: false }, { soloSafety: true, maxTargetLevel: 20 }, {}];

const strike = { selfId: 3, level: 5, passive: false, spell: false, power: 150, mp: 20, hitTime: 1080, reuse: 13000,
    distance: 40, semantic: { skillType: 'damage', target: 'enemy', trait: 'physical' } };
const fighter = (overrides = {}) => ({ classId: 0, role: 'dps', level: 20, pAtk: 120, mAtk: 10, maxMp: 100,
    atkSpd: 300, castSpd: 333, weaponMask: 4, maxHp: 900, pDef: 150, equipment: { weaponKind: 'Weapon.Sword' },
    skills: [{ ...strike }], ...overrides });
const skillWith = (fields) => fighter({ skills: [{ ...strike, ...fields }] });

// Every field channels() and soloSurvival() read, changed one at a time.
const variants = {
    base: fighter(),
    pAtk: fighter({ pAtk: 900 }),
    mAtk: fighter({ role: 'mage', mAtk: 400 }),
    role: fighter({ role: 'mage' }),
    noRole: fighter({ role: undefined, classId: 10 }),
    atkSpd: fighter({ atkSpd: 900 }),
    castSpd: fighter({ role: 'mage', castSpd: 1200 }),
    maxMp: fighter({ maxMp: 10 }),
    weaponMask: fighter({ weaponMask: 0 }),
    weaponKind: fighter({ equipment: { weaponKind: 'Weapon.Bow' } }),
    maxHp: fighter({ maxHp: 9000 }),
    pDef: fighter({ pDef: 2000 }),
    survivalUnknown: fighter({ survivalKnown: false }),
    nullHp: fighter({ maxHp: null }),
    stringPAtk: fighter({ pAtk: '120' }),
    skillPower: skillWith({ power: 5000, reuse: 0, mp: 0 }),
    skillMp: skillWith({ mp: 500 }),
    skillHitTime: skillWith({ hitTime: 200 }),
    skillReuse: skillWith({ reuse: 0 }),
    skillPassive: skillWith({ passive: true }),
    skillSpell: skillWith({ spell: true }),
    skillTrait: skillWith({ spell: true, semantic: { ...strike.semantic, trait: 'fire' } }),
    skillTarget: skillWith({ semantic: { ...strike.semantic, target: 'self' } }),
    skillUndead: skillWith({ semantic: { ...strike.semantic, undeadOnly: true } }),
    skillWeapons: skillWith({ semantic: { ...strike.semantic, requires: { weaponsAllowed: 8 } } }),
    noSkills: fighter({ skills: [] })
};

// Warm the shared cache with the base profile, then evaluate each variant:
// a variant must never receive the base profile's verdicts.
for (let pass = 0; pass < 2; pass++) {
    for (const [name, profile] of Object.entries(variants)) {
        for (const options of optionSets) {
            const profiles = [{ ...profile }];
            assert.deepStrictEqual(Matchup.spotMatchup(spot, profiles, options),
                referenceMatchup(spot, [{ ...profile }], options), `${name} ${JSON.stringify(options)}`);
        }
    }
}
const differing = Object.keys(variants).filter((name) => name !== 'base'
    && JSON.stringify(referenceMatchup(spot, [variants[name]], { soloSafety: true }))
        !== JSON.stringify(referenceMatchup(spot, [variants.base], { soloSafety: true })));
for (const name of ['pAtk', 'maxHp', 'pDef', 'role', 'survivalUnknown', 'skillPower', 'skillTrait']) {
    assert(differing.includes(name), `${name} must change the verdict of this spot, or the check above proves nothing`);
}

// A summon or second member is part of the fingerprint, in order.
const pair = [fighter(), fighter({ pAtk: 900 })];
assert.deepStrictEqual(Matchup.spotMatchup(spot, pair, { soloSafety: true }), referenceMatchup(spot, pair, { soloSafety: true }));
const swapped = [fighter({ pAtk: 900 }), fighter()];
assert.deepStrictEqual(Matchup.spotMatchup(spot, swapped, { soloSafety: true }),
    referenceMatchup(spot, swapped, { soloSafety: true }));

// The shared cache is bounded: thousands of distinct profiles evict the oldest.
for (let i = 0; i < Matchup.VERDICT_PROFILE_LIMIT + 50; i++) {
    Matchup.spotMatchup(spot, [fighter({ pAtk: 1000 + i })], { soloSafety: true });
}
assert(Matchup.sharedVerdictProfiles() <= Matchup.VERDICT_PROFILE_LIMIT, 'the shared verdict cache stays bounded');
assert.deepStrictEqual(Matchup.spotMatchup(spot, [fighter()], { soloSafety: true }),
    referenceMatchup(spot, [fighter()], { soloSafety: true }), 'an evicted profile is recomputed');

// The spot result is shared too: per spot object, never by id, and the shared
// result is read-only. A rebuilt catalog brings new spot objects.
const sameIdOtherMobs = { id: spot.id, npcEntries: species.slice(0, 3).map((npc) => ({ selfId: npc.selfId, count: 1 })) };
for (let pass = 0; pass < 2; pass++) {
    for (const options of optionSets) {
        for (const candidate of [spot, sameIdOtherMobs]) {
            assert.deepStrictEqual(Matchup.spotMatchup(candidate, [fighter()], options),
                referenceMatchup(candidate, [fighter()], options), `spot object ${candidate === spot ? 1 : 2} ${JSON.stringify(options)}`);
        }
    }
}
assert.notDeepStrictEqual(referenceMatchup(spot, [fighter()], { soloSafety: true }),
    referenceMatchup(sameIdOtherMobs, [fighter()], { soloSafety: true }), 'the two spots must differ, or the check above proves nothing');
const shared = Matchup.spotMatchup(spot, [fighter()], { soloSafety: true });
assert.strictEqual(Matchup.spotMatchup(spot, [fighter()], { soloSafety: true }), shared, 'the same profile fields share one result');
assert(Object.isFrozen(shared), 'a shared spot result is read-only');

console.log('shared spot matchup verdict tests passed');
