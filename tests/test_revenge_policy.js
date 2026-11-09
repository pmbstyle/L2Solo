const assert = require('assert');
const Policy = require('../src/GameServer/Social/RevengePolicy');
const P = require('../src/GameServer/Social/InteractionMemoryPolicy');
const Memory = require('../src/GameServer/Social/InteractionMemory');
const at = 1800000000000;
const persona = { traits: { assertiveness: 1, caution: 0.1, empathy: 0.2, resilience: 0.2, commitment: 1 } };
const memory = new Memory();
function history(id, target, types, start = at) {
    let snapshot = P.empty(id);
    for (const [i, type] of types.entries()) snapshot = P.apply(snapshot, {
        key: `history:${id}:${i}`, sourceId: id, targetId: target, type, at: start }, start).snapshot;
    return snapshot;
}
memory.accept(history(1, 2, ['attacked', 'killed', 'killed']));
memory.accept(P.empty(2));
const assess = (when = at) => memory.assess({ id: 1 }, { id: 2 }, {}, when);
const social = assess(), chance = Policy.evaluate(social, persona).chance;
assert(chance > 0 && chance <= 0.35);
for (const absent of [undefined, null, {}, { traits: null }]) {
    assert.deepStrictEqual(Policy.evaluate(social, absent), Policy.evaluate(social, { traits: {} }),
        'an absent persona uses the existing neutral traits without losing a loaded grievance');
    assert.deepStrictEqual(Policy.evaluate({ ...social, ready: false }, absent), { chance: 0, reason: 'memory_unloaded' });
}
assert.deepStrictEqual(Policy.evaluate(social, persona), Policy.evaluate(social, JSON.parse(JSON.stringify(persona))),
    'normal traits do not depend on persona object identity');
assert.strictEqual(Policy.evaluate({ ...social, ready: false }, persona).chance, 0);
assert.strictEqual(Policy.evaluate({ ...social, affiliation: 'own' }, persona).chance, 0);
assert.strictEqual(Policy.evaluate({ ...social, personal: null, effective: social.personal }, persona).chance, 0,
    'collective hostility alone must not create a personal revenge campaign');
assert.strictEqual(Policy.evaluate(assess(at + 28 * 86400000), persona).chance, 0, 'old grievances cool down');
assert.strictEqual(Policy.evaluate({ ...social, effective: { ...social.personal, trust: 20, affinity: 20 } }, persona).chance, 0,
    'friendship and help can prevent revenge despite retained old hostile history');
assert(Policy.evaluate({ ...social, effective: { ...social.personal, fear: 30 } }, persona).chance < chance);
assert(Policy.evaluate({ ...social, clanSocial: { selfDiscipline: { stage: 'probation' } } }, persona).chance < chance);
assert(Policy.evaluate({ ...social, effective: { ...social.personal, hostility: 45, trust: -30 } }, persona).chance > chance);
// C4 standing (PvpRules): a bot with karma washes it before any fight; a red PK is free to
// hunt; a white target weighs being flagged and turning red, a flagged one only the flag.
assert.deepStrictEqual(Policy.evaluate(social, persona, { ownKarma: 240 }), { chance: 0, reason: 'own_karma' },
    'a red bot starts no revenge');
const red = Policy.evaluate(social, persona, { targetKarma: 240 }).chance;
const flagged = Policy.evaluate(social, persona, { targetFlagged: true }).chance;
assert(red > flagged && flagged > chance, 'revenge on a red PK is free, on a flagged target cheaper than on a white one');
assert.strictEqual(Policy.evaluate(social, persona, {}).chance, chance, 'no standing reads as a white unflagged target');
// A mutual clan war is a grievance of its own; a stranger without one is none.
const stranger = { ready: true, affiliation: 'stranger', personal: null };
assert.strictEqual(Policy.evaluate(stranger, persona).chance, 0);
const war = Policy.evaluate(stranger, persona, { war: true });
assert(war.chance > 0 && war.reason === 'clan_war', 'a mutual clan war enemy is met as a grievance');
assert(Policy.evaluate(stranger, persona, { war: true, ownKarma: 1 }).chance > 0,
    'a mutual-war kill gives no karma (C4): a red bot still meets its war enemies');
const worker = new Memory();
worker.accept(JSON.parse(JSON.stringify(memory.snapshot(1))));
assert.deepStrictEqual(Policy.evaluate(worker.assess({ id: 1 }, { id: 2 }, {}, at), persona), Policy.evaluate(social, persona));
// enemy_met (EnemyMet, a production caller): a bot arrives where its enemy stands. The pair is
// decided by the rule and rolled once per (holder, peer, arrival step).
const EnemyMet = require('../src/GameServer/Bot/Population/EnemyMet');
const TendencyRoll = require('../src/GameServer/Bot/AI/TendencyRoll');
const bot = (id, stats = {}) => ({ characterId: id, name: `Bot${id}`, phase: 'cold', activity: 'hunting', spotId: 'spot',
    loc: { locX: id * 10, locY: 0, locZ: 0 }, vitals: { hp: 100 }, stats, simulation: { revision: 3 } });
const roll = TendencyRoll.roll;
const meet = (arriving, standing, { force = true, step = 7 } = {}) => {
    if (force) TendencyRoll.roll = () => 0;
    try { return EnemyMet.meet({ arriving, standing, spotId: 'spot', at, step, memory, personaFor: () => persona }); }
    finally { TendencyRoll.roll = roll; }
};
const before = JSON.stringify([bot(1), bot(2)]);
const found = meet([bot(1)], [bot(2)]);
assert.strictEqual(found?.kind, 'cold', 'two far bots meet');
assert.strictEqual(found.meeting.holder.characterId, 1, 'the one with the grievance starts it');
assert.strictEqual(found.meeting.reason, 'revenge');
assert.strictEqual(meet([bot(2)], [bot(1)])?.meeting.holder.characterId, 1, 'either one arriving: the standing one remembers');
assert.strictEqual(JSON.stringify([bot(1), bot(2)]), before, 'a meeting writes nothing');
const event = EnemyMet.coldEvent({ meeting: found.meeting, spotId: 'spot', at, step: 7, partyOf: () => null, memoryRevision: () => 1 });
assert.deepStrictEqual([event.action, event.actor.id, event.peer.id, event.revengeRoll], ['revenge', 1, 2, 0],
    'as main\'s competition actions take it (ColdPartyConflict)');
assert.strictEqual(meet([bot(1, { karma: 240 })], [bot(2)]), null, 'a red bot takes no revenge');
assert.strictEqual(meet([bot(1)], [bot(2, { karma: 240 })])?.meeting.holder.characterId, 1, 'a red PK is a target');
assert.strictEqual(meet([bot(1)], [{ ...bot(2), activity: 'traveling', stats: { travel: { spotId: 'spot' } } }]), null,
    'a bot on its way does not stand there');
assert.strictEqual(meet([bot(1)], [{ ...bot(2), phase: 'hot' }]), null, 'a far and a near bot: counted, no fight (B10)');
assert.strictEqual(meet([{ ...bot(1), phase: 'hot' }], [{ ...bot(2), phase: 'hot' }])?.kind, 'hot', 'two near bots: a command to main');
assert.strictEqual(meet([{ ...bot(1), party: { partyId: 'p' } }], [{ ...bot(2), party: { partyId: 'p' } }]), null,
    'party mates do not fight each other');
{
    // The roll is the pair's own at this arrival: the same at any time, another at the next arrival.
    const own = TendencyRoll.roll('enemy_met', 1, 2, 7);
    const chanceOf = Policy.evaluate(memory.assess({ id: 1, clanId: 0, partyId: null }, { id: 2, clanId: 0, partyId: null }, {}, at), persona).chance;
    assert.strictEqual(!!meet([bot(1)], [bot(2)], { force: false }), own < chanceOf, 'the roll is seeded by the pair and the arrival');
    for (const [id, target] of [[3, 4], [5, 6]]) { memory.accept(history(id, target, ['attacked', 'killed', 'killed'])); memory.accept(P.empty(target)); }
    assert.strictEqual(!!meet([bot(1)], [bot(4), bot(6), bot(2)], { force: false }), own < chanceOf,
        'other grievances on the spot leave its roll as its own');
}
{
    // Its clan at mutual war with its enemy's: the war is passed to the rule, so a red bot
    // still meets its war enemy, with no karma cost; a war alone is a grievance.
    const ClanWarView = require('../src/GameServer/Clan/ClanWarView');
    memory.clanWars = new ClanWarView();
    memory.clanWars.accept({ fromClanId: 10, toClanId: 20, revision: 1, active: 1 });
    memory.clanWars.accept({ fromClanId: 20, toClanId: 10, revision: 2, active: 1 });
    const atWar = meet([bot(1, { clanId: 10, karma: 240 })], [bot(2, { clanId: 20 })]);
    assert.strictEqual(atWar?.meeting.reason, 'revenge', 'a red bot at mutual war still takes its revenge');
    assert(atWar.meeting.chance > chance, 'with no karma cost: above the white target\'s chance');
    memory.accept(P.empty(7)); memory.accept(P.empty(8));
    const strangers = meet([bot(7, { clanId: 10 })], [bot(8, { clanId: 20 })]);
    assert.strictEqual(strangers?.meeting.reason, 'clan_war', 'war enemies with no personal grievance meet as a clan war');
    assert.strictEqual(EnemyMet.coldEvent({ meeting: strangers.meeting, spotId: 'spot', at, step: 7, partyOf: () => null,
        memoryRevision: () => 1 }).action, 'clan_war');
    delete memory.clanWars;
    assert.strictEqual(meet([bot(1, { clanId: 10, karma: 240 })], [bot(2, { clanId: 20 })]), null, 'without the war it washes its karma first');
}
{
    // A player and a bot: the bot's grievance, rolled per (bot, player, the bot's stay).
    const relation = memory.assess({ id: 1 }, { id: 2 }, {}, at);
    TendencyRoll.roll = () => 0;
    try {
        assert.strictEqual(EnemyMet.player({ botId: 1, playerId: 2, stay: 3, social: Policy.evaluate(relation, persona) })?.reason, 'revenge');
        assert.strictEqual(EnemyMet.player({ botId: 1, playerId: 2, stay: 3, social: Policy.evaluate(relation, persona, { ownKarma: 240 }) }), null);
    } finally { TendencyRoll.roll = roll; }
}
console.log('Shared revenge policy: decay, reconciliation, fear, discipline, karma, war and enemy_met at arrivals passed');
