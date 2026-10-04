const assert = require('assert');
require('../src/Global');
const Cache = invoke('GameServer/DataCache'); Cache.init();
const Cold = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Solo = invoke('GameServer/Bot/Population/BackgroundResolver');
const Party = invoke('GameServer/Bot/Population/BackgroundPartyResolver');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const original = Cold.npcForSpot;
const at = Date.now();
const spot = { id: 'shot-consumption', name: 'Shot check', minLevel: 12, maxLevel: 12, avgLevel: 12,
    density: 1, rewards: { exp: 1000, sp: 10, adenaMin: 1, adenaMax: 1 } };
const base = { characterId: 901, name: 'Fighter', level: 12, phase: 'cold', activity: 'hunting',
    loc: { locX: 0, locY: 0, locZ: 0 },
    inventory: { 129: { selfId: 129, amount: 1, equipped: true, slot: 7 },
        1463: { selfId: 1463, amount: 1000 } },
    vitals: { hp: 500, maxHp: 500, mp: 200, maxMp: 200 },
    stats: { classId: 0, classProgressionLevel: 12, classProgressionClassId: 0,
        coldCombat: { version: 1, classId: 0,
            base: { str: 40, dex: 30, con: 43, int: 21, wit: 11, men: 25 },
            equipment: { weaponKind: 'Weapon.Sword', pAtk: 80, pAtkRnd: 0, mAtk: 40,
                atkSpd: 379, critical: 0, accur: 100, pDef: 120, mDef: 50, evasion: 0, bonusMp: 0, shieldPDef: 0 },
            skills: [], effects: [] } } };
Cold.npcForSpot = () => ({ level: 12, maxHp: 100000, pAtk: 1, pAtkRnd: 0,
    pDef: 200, mDef: 100, accur: 1, evasion: 0, critical: 0, atkSpd: 500 });
async function check(state, result) {
    const projected = await Life.prepareResolve(state, result, { persist: false, timestamp: at, projectClassProgression: true });
    const perAction = Cache.items.find(item => item.selfId === 129).etc.soulshot;
    assert(result.debug.shotActions > 0);
    assert.strictEqual(projected.inventory[1463].amount, 1000 - result.debug.shotActions * perAction);
}
// A party of one counts its own turns (`actions`), so every turn is checked.
function fightAlone(state, mob, rng = () => .5) {
    Cold.npcForSpot = () => ({ level: 12, maxHp: 100000, pAtk: 1, pAtkRnd: 0, pDef: 200, mDef: 100,
        accur: 1, evasion: 0, critical: 0, atkSpd: 500, ...mob });
    try { return Solo.resolvePartyFight({ members: [state], spot, rng, timestamp: at }).members[0]; }
    finally { Cold.npcForSpot = original; }
}
function withSkills(skills, patch = {}) {
    const state = structuredClone(base);
    state.stats.coldCombat.skills = skills;
    Object.assign(state.stats.coldCombat.equipment, patch.equipment || {});
    Object.assign(state.vitals, patch.vitals || {});
    if (patch.classId !== undefined) {
        state.stats.classId = state.stats.coldCombat.classId = state.stats.classProgressionClassId = patch.classId;
    }
    Object.assign(state.inventory, patch.inventory || {});
    return state;
}
const powerStrike = { selfId: 3, level: 1, spell: false, passive: false, power: 25, mp: 10, hitTime: 1080, reuse: 0 };
const windStrike = { selfId: 1177, level: 1, spell: true, passive: false, power: 12, mp: 1, hitTime: 4000, reuse: 0 };
const heal = { selfId: 1011, level: 1, spell: true, passive: false, power: 49, mp: 1, hitTime: 5000, reuse: 0 };
const mysticShots = { 2509: { selfId: 2509, amount: 1000 }, 1835: { selfId: 1835, amount: 1000 } };
const wand = { equipment: { weaponKind: 'Weapon.Blunt' }, inventory: { 129: undefined, 6: { selfId: 6, amount: 1, equipped: true, slot: 7 }, ...mysticShots } };
function checkSpendingActions() {
    // Hit chance 20% (C4 floor) against rng 0.5: every normal attack misses.
    const missing = fightAlone(withSkills([]), { evasion: 1000 });
    assert(missing.actions > missing.skillUses && missing.shotActions === missing.skillUses,
        'a missed normal attack keeps its soulshot');
    const landing = fightAlone(withSkills([]), { evasion: 0 });
    assert(landing.actions > 0 && landing.shotActions === landing.actions, 'every landed normal attack spends a soulshot');
    const caster = fightAlone(withSkills([windStrike], { ...wand, classId: 10, vitals: { mp: 100000, maxMp: 100000 } }),
        { evasion: 1000 });
    const healer = fightAlone(withSkills([heal], { ...wand, classId: 15, vitals: { hp: 100, mp: 100000, maxMp: 100000 } }),
        { evasion: 1000, pAtk: 400 });
    // A physical skill spends its soulshot at use, even when it misses.
    const skill = fightAlone(withSkills([powerStrike], { vitals: { mp: 100000, maxMp: 100000 } }), { evasion: 1000 });
    assert(skill.skillUses > 0 && skill.shotActions === skill.skillUses, 'a physical skill spends a shot hit or miss');
    // A spell spends its spiritshot at use; the mystic's normal attacks between casts all miss.
    assert(caster.skillUses > 0 && caster.shotActions === caster.skillUses, 'every cast spends a spiritshot');
    // A heal is a cast too; the healer's normal attacks all miss.
    assert(healer.heals > 0 && healer.shotActions === healer.heals, 'a heal spends a spiritshot');
}
(async () => {
    const solo = Solo.resolveSolo({ state: base, spot, elapsedMs: 12000, timestamp: at, rng: () => .5 });
    assert(solo.debug.shotActions < solo.debug.combatActions, 'enemy turns must not spend the bot shots');
    await check(base, solo);
    const members = [901, 902].map((characterId, i) => {
        const state = structuredClone(base);
        state.characterId = characterId; state.activity = 'grouped'; state.party = { partyId: 'shots-party', role: 'dps' };
        state.stats.coldCombat.equipment.atkSpd = i === 0 ? 200 : 600;
        return state;
    });
    const party = { partyId: 'shots-party', memberIds: [901, 902], leaderId: 901, spotId: spot.id, stats: {} };
    const result = Party.resolve({ party, members, spot, elapsedMs: 12000, timestamp: at, rng: () => .5 });
    assert(result.memberResults.every(member => member.result.debug.shotActions > 0),
        'every attacking member gets their own counter, including non-telemetry owners');
    assert(!result.memberResults[1].result.debug.combatActions, 'aggregate telemetry remains on a single owner');
    for (const member of result.memberResults) await check(member.state, member.result);
    assert.strictEqual(base.inventory[1463].amount, 1000, 'projection does not mutate its input');
    checkSpendingActions();
    console.log('Cold shots: solo excludes enemies, every party member pays own weapon cost; '
        + 'a cast, a skill or a landed hit spends, a miss does not');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { Cold.npcForSpot = original; });
