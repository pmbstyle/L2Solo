const assert = require('assert');
require('../src/Global');
// U26 (user, 2026-10-05): can-I-win is a chance with one roll per decision. A fixed
// middle roll (0.49) makes each such decision the author's threshold (willing iff
// chance >= 0.5, i.e. ratio >= threshold); the chance itself is tested in test_visible_strength.
require('../src/GameServer/Bot/AI/TendencyRoll').roll = () => 0.49;
invoke('GameServer/DataCache').init();
const Profiles = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Pvp = invoke('GameServer/Bot/Population/ColdPvpResolver');
const { seeded } = require('../src/GameServer/Bot/Population/ColdCompetitionMonitor');
const at = 2000000;
function fighter(id) {
    const state = { characterId: id, name: `Force${id}`, phase: 'cold', level: 30,
        loc: { locX: 50000, locY: 15000, locZ: -5000 }, vitals: { hp: 10000, mp: 10000 },
        stats: { classId: 47, coldCombat: { classId: 47, version: Profiles.PROFILE_VERSION,
            skills: Profiles.skillSnapshotsFromRecords([{ selfId: 50, level: 1 }, { selfId: 54, level: 1 }]),
            equipment: { weaponKind: 'Weapon.DualFist', pAtk: 1, mAtk: 1, pAtkRnd: 0,
                pDef: 100000, mDef: 100000, atkSpd: 300, critical: 0 },
            charges: 0, chargeExpiresAt: null } } };
    const profile = Profiles.profileFor(state, at);
    state.vitals = { hp: profile.maxHp, maxHp: profile.maxHp, mp: profile.maxMp, maxMp: profile.maxMp };
    return state;
}
function run(size) {
    let sides = [0, 1].map(side => {
        const members = Array.from({ length: size }, (_, i) => fighter(1 + side * size + i));
        return { principal: members[0], members };
    });
    const roles = new Map(sides.flatMap(side => side.members.map(s => [s.characterId, 'support'])));
    let preparations = 0, attacks = 0, skillAttacks = 0;
    for (let tick = 0; tick < 180; tick++) {
        const timestamp = at + tick * 1000;
        const result = Pvp.resolve({ sides, roles, timestamp, rng: seeded(`sequence-${tick}`),
            personaFor: () => ({ traits: { caution: 0 } }),
            step: { resuming: tick > 0, until: timestamp + 1000, expiresAt: at + 180000 } });
        assert(result.started && result.actions <= Pvp.MAX_ACTIONS);
        for (const f of result.fighters) {
            preparations += f.preparations;
            attacks += f.attacks;
            skillAttacks += f.skills - f.preparations;
            assert(f.mp >= 0 && f.charges >= 0 && f.charges <= 2);
        }
        // Serialize each handoff: charge state must survive real snapshot shape.
        sides = sides.map(side => {
            const members = side.members.map(s => JSON.parse(JSON.stringify(result.updates.get(s.characterId))));
            return { principal: members[0], members };
        });
    }
    assert(preparations > size * 2, 'repeated burst windows prepare charges');
    assert(skillAttacks > size * 2, 'prepared charges produce attacks rather than an endless opener');
    assert(attacks > skillAttacks, 'cooldown/resource gaps retain ordinary attacks');
    console.log(`180-second ${size}v${size}: ${preparations} preparations, ${skillAttacks} skill attacks, ${attacks} attacks`);
}
run(1); run(3);
