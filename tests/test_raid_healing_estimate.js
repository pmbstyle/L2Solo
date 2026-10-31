'use strict';
const assert = require('node:assert/strict');
process.env.L2NODE_PROGRESSION_RATE = 'x50';
require('./helpers/databaseIsolation');
require('../src/Global');
invoke('GameServer/DataCache').init({ validate: false });
const Combat = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Rules = invoke('GameServer/Skills/C4SkillRules');
const F = invoke('GameServer/Formulas');
const Actor = invoke('GameServer/Actor/Actor');
const Healing = require('../src/GameServer/Bot/Population/RaidHealingEstimate');
const Policy = require('../src/GameServer/Bot/Population/OpportunisticRaidPolicy');
const Priority = require('../src/GameServer/Bot/Population/RaidRosterPriority');
const record = (selfId, level) => Combat.skillSnapshotsFromRecords([{ selfId, level }])[0];
const chant = record(1229, 4), heart = record(1256, 1), heal = record(1217, 3), percent = record(1258, 2);
const tank = { characterId: 1, stats: { clanId: 7 }, vitals: { maxHp: 2000 } };
const provider = (skill, mp = skill.mp, clanId = 7) => ({
    state: { characterId: skill.selfId, stats: { clanId }, vitals: { mp } },
    profile: { skills: [skill], maxMp: 0, castSpd: 333, atkSpd: 300 }
});
assert.equal(chant.power, 1);
assert.equal(Healing.efficiency(chant, 2000), 345 / 103,
    'native Chant of Life 4 heals fifteen 23-HP ticks, not its placeholder power=1');
// Heart of Paagrio 1 costs the C4 total 27 initial + 107 consume = 134 MP (L2J Lisvus, T117).
assert.equal(Healing.efficiency(heart, 2000), 465 / 134);
assert.equal(Healing.efficiency({ ...chant, power: 0 }, 2000), 345 / 103,
    'authored HoT ticks do not depend on the placeholder power');
assert.equal(Healing.efficiency(percent, 2000), 400 / percent.mp,
    'percentage heals use the recipient HP and native semantic power');
assert.equal(Healing.capacity([provider(chant)], tank, 60), 345,
    'one paid cast credits one recipient, without multiplying the party aura by nine');
assert.equal(Healing.capacity([provider(chant, 0)], tank, 60), 0);
assert.equal(Healing.capacity([provider(heart)], tank, 60), 465);
assert.equal(Healing.capacity([provider(heart, heart.mp, 8)], tank, 60), 0,
    'a foreign-clan Overlord cannot supply clan healing to the tank');
assert.equal(Healing.capacity([provider(heart, heart.mp, 0)], { ...tank, stats: {} }, 60), 0,
    'two clanless characters do not share a clan heal');
const castSeconds = F.calcSkillHitTime(chant.hitTime, 333, { magic: true }) / 1000;
assert.equal(Healing.capacity([provider(chant)], tank, castSeconds + .999), 0,
    'ticks cannot land before casting finishes and the first tick is due');
assert.equal(Healing.capacity([provider(chant)], tank, castSeconds + 2), 46,
    'a fight ending early receives only completed ticks');
const wealthyChant = provider(chant, 1000000), wealthyHeart = provider(heart, 1000000);
const uptime = Healing.capacity([wealthyChant], tank, 60);
assert(uptime <= 23 * 60, 'unlimited mana cannot bypass the HoT uptime or reuse');
assert.equal(Healing.capacity([wealthyChant, wealthyHeart], tank, 60),
    Math.max(uptime, Healing.capacity([wealthyHeart], tank, 60)),
    'Chant of Life and Heart of Paagrio occupy the same native stack family');
assert.equal(Healing.capacity([provider(chant), provider(heal)], tank, 60), 345 + 398,
    'an independent direct healer still contributes alongside the HoT');
const conditional = provider(record(1271, 1), 1000000);
conditional.profile.maxHp = 2000; conditional.state.vitals.hp = 2000;
assert.equal(Healing.capacity([conditional], tank, 600), 0,
    'a healthy caster cannot contribute a heal requiring critical HP');
conditional.state.vitals.hp = 100;
assert.equal(Healing.capacity([conditional], tank, 600), 2000,
    'one conditional rescue cannot promise repeated future critical-HP triggers');

// Use the native cooldown writer as the oracle, rather than copying its
// speed/effect formula into the expected forecast calculation.
function nativeDirectCapacity(fighter, semantic = Rules.resolveCached(fighter.profile.skills[0])) {
    const skill = fighter.profile.skills[0], profile = fighter.profile;
    const actor = { effects: Object.fromEntries((profile.effects || []).map(e => [e.key, e])),
        skillReuseUntil: new Map(), fetchCollectiveCastSpd: () => profile.castSpd,
        fetchCollectiveAtkSpd: () => profile.atkSpd };
    const adapter = { fetchSelfId: () => skill.selfId, fetchLevel: () => skill.level,
        fetchSemantic: () => semantic, fetchReuseTime: () => semantic.reuseTime ?? skill.reuse,
        fetchSpell: () => skill.spell === true };
    const cast = F.calcSkillHitTime(semantic.hitTime ?? skill.hitTime, skill.spell ? profile.castSpd : profile.atkSpd,
        { magic: skill.spell === true, staticHitTime: semantic.staticHitTime });
    let casts = 0;
    for (let start = 0; start + cast <= 60000;) {
        Actor.prototype.markSkillReuse.call(actor, adapter, start);
        casts++;
        start = Math.max(start + cast, actor.skillReuseUntil.get(skill.selfId));
    }
    return casts * F.calcHealAmount(semantic.healPower ?? skill.power);
}
const slow = provider(heal, 100000);
slow.profile.castSpd = 100;
assert.equal(nativeDirectCapacity(slow), 796);
assert.equal(Healing.capacity([slow], tank, 60), nativeDirectCapacity(slow),
    'a slow native caster cannot fit a third Greater Heal into sixty seconds');
for (const magic of [true, false]) {
    const slowed = provider({ ...heal, spell: magic }, 100000);
    slowed.profile.effects = [{ key: 'reuse-delay', type: 'buff',
        stats: { [magic ? 'mReuseMul' : 'pReuseMul']: 3, [magic ? 'mReuseDiv' : 'pReuseDiv']: .5 } }];
    assert.equal(Healing.capacity([slowed], tank, 60), nativeDirectCapacity(slowed),
        'native magic/physical reuse multipliers and divisors constrain forecast casts');
}
const cachedRules = Rules.resolveCached;
try {
    const staticHeal = { ...cachedRules(heal), staticReuse: true };
    Rules.resolveCached = skill => skill.selfId === heal.selfId ? staticHeal : cachedRules(skill);
    assert.equal(Healing.capacity([slow], tank, 60), nativeDirectCapacity(slow, staticHeal),
        'static reuse ignores caster speed exactly as the native writer does');
} finally { Rules.resolveCached = cachedRules; }

const fixture = require('./fixtures/raid_priority_world.json');
const byId = new Map(fixture.members.map(row => [row.characterId, { ...row,
    accountName: `bot_${row.characterId}`, phase: 'cold', party: {},
    stats: { ...row.stats, coldCombat: { ...row.captured,
        skills: Combat.skillSnapshotsFromRecords(row.skills.map(([selfId, level]) => ({ selfId, level }))) } },
    inventory: Object.fromEntries(row.items.map(item => [item.selfId, item])) }]));
const members = fixture.expected.map(id => byId.get(id));
const orc = members[2];
orc.stats.classId = orc.stats.coldCombat.classId = 52;
// A Warcryer keeps the Orc Shaman melee kit (user 10-29): blunt, heavy armour and a shield.
const worn = (selfId, slot, kind, rank = 'c') => ({ selfId, amount: 1, equipped: true, equippedCount: 1,
    equippedSlots: [slot], stackable: false, slot, rank, kind, enchant: 0 });
delete orc.inventory[325]; delete orc.inventory[437]; delete orc.inventory[466];
Object.assign(orc.inventory, { 89: worn(89, 7, 'Weapon.Blunt'), 60: worn(60, 15, 'Armor.Chain'),
    107: worn(107, 8, 'Armor.Shield') });
delete orc.stats.coldCombat.base;
orc.stats.coldCombat.skills = [chant];
const boss = invoke('GameServer/RaidBoss/RaidBossSourceCatalog').findById(`raid:${fixture.bossId}`);
const weaker = structuredClone(members);
weaker[2].stats.coldCombat.skills = [record(1229, 1)];
const before = JSON.stringify(members);
const ordinary = Policy.assessment(members, boss, { timestamp: fixture.at, fundSupplies: true });
const lowerRank = Policy.assessment(weaker, boss, { timestamp: fixture.at, fundSupplies: true });
assert(ordinary.healing > lowerRank.healing + 100,
    `higher learned HoT ranks improve raid healing: ${ordinary.healing} versus ${lowerRank.healing}`);
const rank = Priority.facts(orc, 'healer').score;
const noPower = structuredClone(orc); noPower.stats.coldCombat.skills[0].power = 0;
assert.equal(Priority.facts(noPower, 'healer').score, rank,
    'support ranking and admission both honour semantic HoT healing');
const preparation = Policy.prepared(members, fixture.at);
assert(preparation.at > fixture.at);
const expiredReuse = structuredClone(preparation);
for (const state of expiredReuse.states) state.stats.coldCombat.effects.push({
    key: 'expired-reuse-delay', type: 'buff', stats: { mReuseMul: 100 }, expiresAt: fixture.at + 1
});
assert.deepEqual(Policy.assessment(members, boss, { timestamp: fixture.at, fundSupplies: true, preparation: expiredReuse }),
    Policy.assessment(members, boss, { timestamp: fixture.at, fundSupplies: true, preparation }),
    'reuse effects are evaluated at combat start after preparation, alongside the prepared profiles');
assert.equal(JSON.stringify(members), before, 'estimates never mutate the physical roster');
assert.equal(Rules.resolveCached(chant).hot.heal, 23, 'shared skill semantics stay read-only');
console.log('Native raid HoT ticks, mana, uptime, recipient scope, stacking and full forecast regression passed');
