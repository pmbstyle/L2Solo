// One passive-skill requirement rule (SkillRequirements) for hot EffectStats
// and the cold combat profile: C4 worn armour sets, excluded armour kinds,
// conditional stats, and the HP / night conditions a cold fight judges once
// at its start.
const assert = require('assert');
require('../src/Global');
const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const Requirements = invoke('GameServer/Skills/SkillRequirements');
const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const EffectStats = invoke('GameServer/Effects/EffectStats');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const GameTime = invoke('GameServer/World/GameTime');

// ---------- the rule itself ----------
assert.strictEqual(Requirements.wornSetKind('Armor.Fabric', '', ''), 'Armor.Fabric', 'a full-body robe is a robe set');
assert.strictEqual(Requirements.wornSetKind('', 'Armor.Leather', 'Armor.Leather'), 'Armor.Leather', 'a leather chest and legs are a set');
assert.strictEqual(Requirements.wornSetKind('', 'Armor.Chain', 'Armor.Leather'), '', 'a mixed chest and legs are no set');
assert.strictEqual(Requirements.wornSetKind('', 'Armor.Chain', ''), '', 'a chest alone is no set');
const gear = (setKind, armorKinds = [], extra = {}) => ({ weaponKind: 'Weapon.Sword', armorKinds, setKind, shield: false, ...extra });
const lightMastery = { armorSetKind: 'Armor.Leather', excludedArmorSetKinds: ['Armor.Chain', 'Armor.Fabric'] };
assert.strictEqual(Requirements.requirementsMet(lightMastery, gear('Armor.Leather', ['Armor.Leather', 'Armor.Leather'])), true);
assert.strictEqual(Requirements.requirementsMet(lightMastery, gear('', ['Armor.Chain', 'Armor.Leather'])), false, 'a chain piece breaks the leather set');
assert.strictEqual(Requirements.requirementsMet({ excludedArmorKinds: ['Armor.Fabric'] }, gear('', ['Armor.Fabric'])), false);
assert.strictEqual(Requirements.requirementsMet({ armorKinds: ['Armor.Leather', 'Armor.Chain'] }, gear('', ['Armor.Chain'])), true);
assert.strictEqual(Requirements.requirementsMet({ weaponKinds: ['Weapon.Bow'] }, gear('')), false);
assert.strictEqual(Requirements.requirementsMet({ shield: true }, gear('', [], { shield: true })), true);
const situation = { hp: 100, maxHp: 100, moving: false, walking: false, seated: false, night: false };
assert.strictEqual(Requirements.conditionMet({ actorHpPercentAtMost: 30 }, situation), false, 'full HP: an HP <= 30% passive is off');
assert.strictEqual(Requirements.conditionMet({ actorHpPercentAtMost: 30 }, { ...situation, hp: 30 }), true);
assert.strictEqual(Requirements.conditionMet({ night: true }, { ...situation, night: true }), true);
assert.strictEqual(Requirements.conditionMet({ moving: true, walking: false }, situation), false);
const armorMastery = C4SkillRules.resolve({ selfId: 142, level: 5 });
// (the skill's own stats block is empty: only the conditional blocks carry stats)
const blocks = (...args) => Requirements.passiveStats(...args).filter((stats) => Object.keys(stats).length);
assert.deepStrictEqual(blocks(armorMastery, gear('Armor.Leather', ['Armor.Leather', 'Armor.Leather']), situation),
    [{ pDefAdd: 14 }, { pEvasionRateAdd: 3 }], 'Armor Mastery in leather: P.Def and evasion blocks');
assert.deepStrictEqual(blocks(armorMastery, gear('Armor.Chain', ['Armor.Chain', 'Armor.Chain']), situation),
    [{ pDefAdd: 14 }], 'Armor Mastery in chain: only the P.Def block');

// ---------- fighters: class, level, worn gear of the level's grade ----------
const RANKS = ['none', 'd', 'c', 'b', 'a', 's'];
const rankFor = (level) => level >= 76 ? 's' : level >= 61 ? 'a' : level >= 52 ? 'b' : level >= 40 ? 'c' : level >= 20 ? 'd' : 'none';
const byPrice = (a, b) => Number(b.template?.price || 0) - Number(a.template?.price || 0);
function itemFor(kind, slot, rank) {
    for (let r = RANKS.indexOf(rank); r >= 0; r--) {
        const all = DataCache.items.filter((i) => i.template?.kind === kind && (slot === null || Number(i.etc?.slot) === slot)
            && (i.etc?.rank || 'none') === RANKS[r]);
        if (all.length) return all.sort(byPrice)[0];
    }
    return null;
}
// gear: { weapon, chest, legs, full, shield }
function fighter(classId, level, worn) {
    const rank = rankFor(level);
    const inventory = {};
    const pieces = [];
    let n = 1;
    const put = (item, slot) => {
        if (!item) return;
        inventory[n++] = { selfId: item.selfId, amount: 1, equipped: true, slot, equippedSlots: [slot] };
        pieces.push({ kind: item.template.kind, slot });
    };
    put(itemFor(worn.weapon, null, rank), 7);
    if (worn.chest) put(itemFor(worn.chest, 10, rank), 10);
    if (worn.legs) put(itemFor(worn.legs, 11, rank), 11);
    if (worn.full) put(itemFor(worn.full, 15, rank), 15);
    if (worn.shield) put(itemFor('Armor.Shield', 8, rank), 8);
    return { state: { characterId: 1, name: 'F', level, classId, stats: { classId }, inventory, vitals: {} }, pieces };
}

// The first day and the first night moment from a fixed time, by the game clock.
const TS = 1_791_060_000_000;
let DAY = TS;
while (GameTime.isNight(DAY)) DAY += GameTime.GAME_MINUTE_MS * 30;
let NIGHT = TS;
while (!GameTime.isNight(NIGHT)) NIGHT += GameTime.GAME_MINUTE_MS * 30;

const passiveOnly = (profile) => ({ ...profile, effects: [] });
const coldAdd = (f, stat, at = DAY) => ColdCombatProfile.statAdd(passiveOnly(ColdCombatProfile.profileFor(f.state, at)), stat, at);
const coldMul = (f, stat, at = DAY) => ColdCombatProfile.statMultiplier(passiveOnly(ColdCombatProfile.profileFor(f.state, at)), stat, at);

const sorcererRobe = fighter(12, 60, { weapon: 'Weapon.Blunt', chest: 'Armor.Fabric', legs: 'Armor.Fabric' });
const sorcererFull = fighter(12, 60, { weapon: 'Weapon.Blunt', full: 'Armor.Fabric' });
const sorcererMixed = fighter(12, 60, { weapon: 'Weapon.Blunt', chest: 'Armor.Fabric', legs: 'Armor.Leather' });
const bishopLeather = fighter(16, 60, { weapon: 'Weapon.Blunt', chest: 'Armor.Leather', legs: 'Armor.Leather' });
const warcryerMixed = fighter(52, 60, { weapon: 'Weapon.Blunt', chest: 'Armor.Chain', legs: 'Armor.Leather' });
const elderChain = fighter(30, 52, { weapon: 'Weapon.Blunt', chest: 'Armor.Chain', legs: 'Armor.Chain' });
const gladiatorChain = fighter(2, 60, { weapon: 'Weapon.Dual', chest: 'Armor.Chain', legs: 'Armor.Chain' });
const gladiatorMixed = fighter(2, 60, { weapon: 'Weapon.Dual', chest: 'Armor.Chain', legs: 'Armor.Leather' });
const gladiatorLeather = fighter(2, 60, { weapon: 'Weapon.Dual', chest: 'Armor.Leather', legs: 'Armor.Leather' });
const paladin = fighter(5, 60, { weapon: 'Weapon.Sword', chest: 'Armor.Chain', legs: 'Armor.Chain', shield: true });
const treasureHunter = fighter(8, 60, { weapon: 'Weapon.Knife', chest: 'Armor.Leather', legs: 'Armor.Leather' });
const abyssWalker = fighter(36, 40, { weapon: 'Weapon.Knife', chest: 'Armor.Leather', legs: 'Armor.Leather' });

// ---------- cold: decided cases ----------
// Mystic cast speed passives: 228 Fast Spell Casting x1.1 always, 163 Spellcraft x0.5 out of a robe set,
// 236 Light Armor Mastery x1.91 in a leather set; 118 Magician's Movement attack speed x0.8 out of a robe set.
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`);
near(coldMul(sorcererRobe, 'castSpdMul'), 1.1, 'a robe-set sorcerer has no Spellcraft (163) cast speed penalty');
near(coldMul(sorcererRobe, 'pAtkSpdMul'), 1, 'a robe-set sorcerer has no Magician\'s Movement (118) attack speed penalty');
near(coldMul(sorcererRobe, 'regMp'), 1.2, 'a robe-set sorcerer gets Mana Recovery (214)');
near(coldMul(sorcererFull, 'castSpdMul'), 1.1, 'a full-body robe counts as a robe set');
near(coldMul(sorcererMixed, 'castSpdMul'), 0.55, 'a robe chest with leather legs is no robe set: the penalty applies');
near(coldMul(sorcererMixed, 'pAtkSpdMul'), 0.8, 'and the attack speed penalty');
near(coldMul(sorcererMixed, 'regMp'), 1, 'and no robe-set Mana Recovery (214)');
near(coldMul(warcryerMixed, 'castSpdMul'), 0.55, 'mixed chain/leather: no set mastery (252/253), the robe penalty applies');
near(coldMul(bishopLeather, 'castSpdMul'), 1.1 * 0.5 * 1.91, 'a leather-set bishop: Light Armor Mastery (236) and the robe penalty');
assert.strictEqual(coldAdd(gladiatorMixed, 'pEvasionRateAdd'), 0, 'a chain piece turns Light Armor Mastery (227) off');
assert.ok(coldAdd(gladiatorLeather, 'pEvasionRateAdd') > 0, 'a full leather set turns Light Armor Mastery (227) on');
assert.strictEqual(coldAdd(gladiatorMixed, 'pDefAdd'), 14, 'mixed chain/leather: no 227/231 P.Def, only Armor Mastery (142)');
assert.ok(Math.abs(coldAdd(gladiatorChain, 'pDefAdd') - 14 - C4SkillRules.resolve({ selfId: 231, level:
    ColdCombatProfile.profileFor(gladiatorChain.state, DAY).skills.find((s) => s.selfId === 231).level }).stats.pDefAdd) < 1e-9,
'a chain set: Heavy Armor Mastery (231) plus the Armor Mastery (142) conditional P.Def');
// HP <= 30% passives: off at the full-HP cold fight start, on for a hot actor at 20% HP.
function hotFor(f, weaponKind, options = {}) {
    const skills = ColdCombatProfile.profileFor(f.state, DAY).skills.filter((s) => s.passive);
    return hotActor(skills, f.pieces, { weaponKind, ...options });
}
const finalFrenzy = C4SkillRules.resolve(ColdCombatProfile.profileFor(gladiatorChain.state, DAY).skills.find((s) => s.selfId === 290));
assert.ok(Math.abs(coldAdd(gladiatorChain, 'pAtkAdd') - EffectStats.add(hotFor(gladiatorChain, 'Weapon.Dual'), 'pAtkAdd')) < 1e-9
    && Math.abs(EffectStats.add(hotFor(gladiatorChain, 'Weapon.Dual', { hpRatio: 0.2 }), 'pAtkAdd')
        - coldAdd(gladiatorChain, 'pAtkAdd') - finalFrenzy.stats.pAtkAdd) < 1e-9,
'Final Frenzy (290) is off at the full-HP cold fight start');
const finalFortress = C4SkillRules.resolve(ColdCombatProfile.profileFor(paladin.state, DAY).skills.find((s) => s.selfId === 291));
assert.ok(Math.abs(EffectStats.add(hotFor(paladin, 'Weapon.Sword', { shield: true, hpRatio: 0.2 }), 'pDefAdd')
    - coldAdd(paladin, 'pDefAdd') - finalFortress.stats.pDefAdd) < 1e-9,
'Final Fortress (291) is off at the full-HP cold fight start');
const walkerSkills = ColdCombatProfile.profileFor(abyssWalker.state, DAY).skills;
assert.ok(walkerSkills.some((s) => s.selfId === 294), 'the abyss walker knows Shadow Sense (294)');
assert.strictEqual(coldAdd(abyssWalker, 'pAccuracyCombatAdd', NIGHT) - coldAdd(abyssWalker, 'pAccuracyCombatAdd', DAY), 3,
    'Shadow Sense (294): +3 accuracy by night on the game clock, not by day');

// ---------- hot: 227/231/233 need the full set (C4), not any piece ----------
function hotActor(skills, pieces, { weaponKind = '', shield = false, hpRatio = 1, night = false } = {}) {
    const armors = pieces.filter((p) => p.kind.startsWith('Armor.'))
        .map((p) => ({ fetchKind: () => p.kind, fetchSlot: () => p.slot }));
    return {
        effects: {},
        skillset: { fetchSkills: () => skills.map((s) => ({ fetchPassive: () => true, fetchSelfId: () => s.selfId,
            fetchLevel: () => s.level, fetchName: () => '' })) },
        fetchPassiveSkills: () => [],
        backpack: {
            fetchEquippedArmors: () => armors,
            fetchTotalWeaponKind: () => weaponKind,
            fetchTotalShieldPDef: () => shield ? 100 : 0
        },
        fetchHp: () => 1000 * hpRatio,
        fetchMaxHp: () => 1000,
        isNight: () => night,
        state: { inMotion: () => false, fetchWalkin: () => false, fetchSeated: () => false }
    };
}
const lightArmorMastery = [{ selfId: 227, level: 50 }];
const leatherSet = [{ kind: 'Armor.Leather', slot: 10 }, { kind: 'Armor.Leather', slot: 11 }];
assert.ok(EffectStats.add(hotActor(lightArmorMastery, leatherSet), 'pDefAdd') > 0, 'hot 227 with a leather set');
assert.strictEqual(EffectStats.add(hotActor(lightArmorMastery, [{ kind: 'Armor.Leather', slot: 10 }]), 'pDefAdd'), 0,
    'hot 227 needs the full set: a leather chest alone is not enough');
assert.strictEqual(EffectStats.add(hotActor(lightArmorMastery, [{ kind: 'Armor.Leather', slot: 10 }, { kind: 'Armor.Chain', slot: 11 }]), 'pDefAdd'), 0,
    'hot 227 is off with a chain piece');
assert.strictEqual(EffectStats.add(hotActor([{ selfId: 231, level: 50 }], [{ kind: 'Armor.Chain', slot: 15 }]), 'pDefAdd'), 79.3,
    'hot 231 with a full-body chain armour');
assert.strictEqual(EffectStats.add(hotActor([{ selfId: 233, level: 47 }], [{ kind: 'Armor.Leather', slot: 11 }]), 'pDefAdd'), 0,
    'hot 233 needs the full set');

// ---------- parity: cold and hot give the same passive stats for the same gear ----------
const STATS = ['castSpdMul', 'pAtkSpdMul', 'regMp', 'pDefAdd', 'pAtkAdd', 'pEvasionRateAdd', 'pAccuracyCombatAdd', 'maxMpAdd', 'mAtkAdd', 'rShldMul'];
const MULTIPLIERS = new Set(['castSpdMul', 'pAtkSpdMul', 'regMp', 'rShldMul']);
for (const [name, f, weaponKind, shield] of [
    ['sorcerer robe set', sorcererRobe, 'Weapon.Blunt'], ['sorcerer full robe', sorcererFull, 'Weapon.Blunt'],
    ['sorcerer mixed', sorcererMixed, 'Weapon.Blunt'], ['bishop leather', bishopLeather, 'Weapon.Blunt'],
    ['elder chain', elderChain, 'Weapon.Blunt'], ['warcryer mixed', warcryerMixed, 'Weapon.Blunt'],
    ['gladiator chain', gladiatorChain, 'Weapon.Dual'], ['gladiator mixed', gladiatorMixed, 'Weapon.Dual'],
    ['paladin chain + shield', paladin, 'Weapon.Sword', true], ['treasure hunter leather', treasureHunter, 'Weapon.Knife'],
    ['abyss walker leather', abyssWalker, 'Weapon.Knife']
]) {
    for (const [at, night] of [[DAY, false], [NIGHT, true]]) {
        const profile = passiveOnly(ColdCombatProfile.profileFor(f.state, at));
        const actor = hotActor(profile.skills.filter((s) => s.passive), f.pieces, { weaponKind, shield, night });
        for (const stat of STATS) {
            const cold = MULTIPLIERS.has(stat) ? ColdCombatProfile.statMultiplier(profile, stat, at) : ColdCombatProfile.statAdd(profile, stat, at);
            const hot = MULTIPLIERS.has(stat) ? EffectStats.multiplier(actor, stat) : EffectStats.add(actor, stat);
            assert.ok(Math.abs(cold - hot) < 1e-9, `${name} ${night ? 'night' : 'day'} ${stat}: cold ${cold} = hot ${hot}`);
        }
    }
}

console.log('test_skill_requirements passed');
