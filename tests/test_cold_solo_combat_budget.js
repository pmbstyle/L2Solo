const assert = require('assert');
require('../src/Global');
const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const Cold = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const originalNpc = Cold.npcForSpot, originalProfile = Cold.profileFor, originalFightProfile = Cold.fightProfile;
const state = {
    characterId: 901, name: 'SlowFighter', level: 12, activity: 'hunting',
    vitals: { hp: 500, maxHp: 500, mp: 200, maxMp: 200 },
    stats: { classId: 0, karma: 240, coldCombat: {
        version: 1, classId: 0,
        base: { str: 40, dex: 30, con: 43, int: 21, wit: 11, men: 25 },
        equipment: { weaponKind: 'Weapon.Sword', pAtk: 80, pAtkRnd: 0, mAtk: 40,
            atkSpd: 379, critical: 0, accur: 100, pDef: 120, mDef: 50, evasion: 0,
            bonusMp: 0, shieldPDef: 0 },
        skills: [], effects: []
    } }
};
const spot = { id: 'budget', name: 'Budget field', minLevel: 12, maxLevel: 12,
    avgLevel: 12, density: 30, rewards: { exp: 1000, sp: 10, adenaMin: 1, adenaMax: 1 } };
try {
    Cold.npcForSpot = () => ({ level: 12, maxHp: 1200, pAtk: 1, pAtkRnd: 0,
        pDef: 200, mDef: 100, accur: 1, evasion: 0, critical: 0, atkSpd: 253 });
    const run = elapsedMs => Resolver.resolveSolo({ state: structuredClone(state), spot,
        elapsedMs, timestamp: 1750000000000, rng: () => 0.5 });
    const short = run(12000);
    assert.strictEqual(short.debug.wins, 0, 'this opponent must require more than twelve seconds');
    const full = run(60000);
    assert(full.debug.wins > 0, 'available cycle time must allow a slow fighter to finish its kill');
    assert(full.materialize.exp > 0, 'only a completed kill should award experience for karma washing');
    assert(full.debug.fights < 5, 'the same time must not also buy five fresh fights');
    assert(full.debug.combatActions <= 5 * 48, 'the previous cycle action budget must remain bounded');
    // A round's last walk, kill or heal may run past its timestamp; that time is
    // credited once: the next round starts at the bot's clock (the round's last
    // action's end), so over a hunt the fights and rests fit in the time the rounds
    // move the bot's clock (the old resolver ran ~23 s more over these 40 rounds).
    Cold.npcForSpot = () => ({ level: 12, maxHp: 300, pAtk: 1, pAtkRnd: 0,
        pDef: 200, mDef: 100, accur: 1, evasion: 0, critical: 0, atkSpd: 253 });
    {
        let hunter = structuredClone(state), at = 1750000000000, clock = at - 60000, seed = 1;
        let spent = 0, covered = 0, tails = 0;
        const roll = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
        for (let k = 0; k < 40; k++) {
            const elapsedMs = at - clock;
            const round = Resolver.resolveSolo({ state: hunter, spot, elapsedMs, timestamp: at, rng: roll });
            assert.strictEqual(round.patch.activity || 'hunting', 'hunting', 'the harmless mob never sends the bot to rest');
            spent += round.debug.combatMs + (round.debug.seatedMs || 0);
            // The clock the commit carries (BotLifeState.prepareResolve).
            const done = Math.max(at, Math.ceil(Number(round.doneAt) || 0));
            covered += done - clock;
            clock = done;
            if (round.debug.combatMs + (round.debug.seatedMs || 0) > elapsedMs) tails += 1;
            hunter = { ...hunter, ...round.patch, vitals: { ...hunter.vitals, ...round.patch.vitals }, stats: round.patch.stats };
            at = round.nextResolveAt;
        }
        assert(tails > 0, 'some rounds run past their timestamp');
        assert(spent <= covered, `the fights fit in the hunt's time (${Math.round(spent - covered)} ms past it)`);
    }
    // A caster's nuke cast late in a round is stamped at its cast: its reuse ends where
    // it would for a hot bot, so the next round, 30 s on, opens with it.
    {
        const caster = { classId: 10, level: 20, role: 'mage', maxHp: 400, maxMp: 900, pDef: 100, pAtk: 20, mAtk: 120,
            castSpd: 333, atkSpd: 253, weaponMask: 8, equipment: { weaponKind: 'Weapon.Blunt' }, accur: 100, evasion: 0,
            critical: 0, effects: [], skills: [{ selfId: 1177, level: 1, spell: true, passive: false, power: 40, mp: 10,
                hitTime: 2000, reuse: 25000 }] };
        Cold.profileFor = Cold.fightProfile = () => ({ ...caster });
        const mage = { characterId: 902, name: 'Nuker', level: 20, activity: 'hunting', inventory: {}, loc: {}, timing: {},
            vitals: { hp: 400, maxHp: 400, mp: 900, maxMp: 900 }, stats: { classId: 10, classProgressionClassId: 10,
                classProgressionLevel: 20, deaths: 0 } };
        const at = 1750000000000;
        const first = Resolver.resolveSolo({ state: mage, spot, elapsedMs: 120000, timestamp: at, rng: () => 0.5 });
        const cast = Number(first.patch.stats.coldCombat?.cooldowns?.[1177]);
        assert(first.debug.skillUses > 1, `the caster nukes in its round (${first.debug.skillUses})`);
        assert(cast <= Math.max(at, first.doneAt) + 25000,
            `its reuse runs from its cast inside the round, not from the round's end (${cast - at} ms past it)`);
        const next = at + 30000;
        const clock = Math.max(at, Math.ceil(Number(first.doneAt) || 0));
        const second = Resolver.resolveSolo({ state: { ...mage, ...first.patch, stats: first.patch.stats }, spot,
            elapsedMs: next - clock, timestamp: next, rng: () => 0.5 });
        assert(second.debug.skillUses > 0, 'the next round opens with the nuke whose reuse ended');
    }
    // An unkillable mob cannot be chosen voluntarily by the solo safety gate.
    // An aggressive interruption still must consume one bounded fight cycle.
    Cold.npcForSpot = () => ({ level: 12, maxHp: 1e9, pAtk: 1, pAtkRnd: 0,
        pDef: 200, mDef: 100, accur: 1, evasion: 0, critical: 0, atkSpd: 253,
        aggressiveInterruption: true });
    const unkillable = run(60000);
    assert.strictEqual(unkillable.debug.wins, 0);
    assert.strictEqual(unkillable.debug.fights, 0, 'a pending fight is not a completed encounter');
    assert.strictEqual(unkillable.debug.attemptedFights, 1, 'a timeout must consume the cycle instead of resetting the mob five times');
    assert(unkillable.patch.stats.pveEncounter, 'unfinished damage must persist');
    assert.strictEqual(unkillable.materialize.exp, 0);
} finally {
    Cold.npcForSpot = originalNpc;
    Cold.profileFor = originalProfile;
    Cold.fightProfile = originalFightProfile;
}
console.log('Cold solo combat time budget checks passed');
