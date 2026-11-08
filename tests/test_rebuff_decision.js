'use strict';
// The rebuff decision (Bot/AI/Rebuff, Situations rebuff): a bot renews its hunting buffs
// when its last one ended (buffs_expired, heard at its next stop) or when it reaches town,
// and holds the answer until then: a newbie walks back to a Newbie Guide in reach and
// gets its blessing, a party member renews nothing on its own, a far hunter with no
// guide, hall or buffer near renews nothing. No clock rebuffs ahead of the end.
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Situations = invoke('GameServer/Bot/Situations');
const Buffs = invoke('GameServer/Bot/AI/BotBuffs');
const Rebuff = invoke('GameServer/Bot/AI/Rebuff');
const Guide = invoke('GameServer/Bot/Population/ColdGuideVisit');

const at = 1800000000000;
const blessing = Buffs.newbieEffects(at);
const ends = blessing[0].expiresAt;

// The buffed fact: its 1 -> 0 fall raises buffs_expired once, kept on the row; a solo
// field step that first reads the bot unbuffed (a new row, a death's restart, a party
// left) raises it once too; a town trip leaves the fact as it was.
{
    const stats = {};
    assert.equal(Situations.buffFact(stats, blessing, at + 1000), null, 'getting buffed raises nothing');
    assert.equal(stats.buffed, 1);
    assert.equal(Situations.buffFact(stats, blessing, ends - 1), null, 'no rebuff ahead of the end');
    assert.equal(Situations.buffFact(stats, blessing, ends + 1), 'buffs_expired', 'the last buff ended');
    assert.equal(Situations.buffFact(stats, blessing, ends + 2), null, 'raised once');
    assert.equal(Situations.buffFact({}, [], at), 'buffs_expired', 'a bot never buffed renews at its next stop');
    const dying = { buffed: 1 };
    assert.equal(Situations.buffFact(dying, [], ends, { dead: true }), null, 'a death clears buffs and raises none');
    assert.equal(Situations.buffFact(dying, [], ends + 1), 'buffs_expired', 'its restart in the field reads them gone');
    // A town trip ends no buff: an unbuffed hunter whose rebuff in town answered none is no news back in the field.
    const visiting = { buffed: 0 };
    assert.equal(Situations.buffFact(visiting, [], ends, { field: false }), null, 'a town visit raises none');
    assert.equal(Situations.buffFact(visiting, [], ends + 1), null, 'back in the field unbuffed as it left');
    const buffedTrip = { buffed: 1 };
    assert.equal(Situations.buffFact(buffedTrip, [], ends, { field: false }), null, 'its buff ends on the trip');
    assert.equal(Situations.buffFact(buffedTrip, [], ends + 1), 'buffs_expired', 'back in the field its last buff ended');
    const grouped = { buffed: 1 };
    assert.equal(Situations.buffFact(grouped, [], ends, { grouped: true }), null, 'a party\'s buffs are its own');
    assert.equal(Situations.buffFact(grouped, blessing, at), null, 'solo again and buffed: nothing to renew');
    // A song or a dance is party tactics, not a hunting buff.
    assert.equal(Buffs.rebuffable({ key: 'dance_of_fury', type: 'buff' }), false);
    assert.equal(Buffs.rebuffable({ key: 'might', type: 'buff' }), true);
}

// A body's buffs with one end time end on as many timers: one raise (one post) per fall.
{
    const Manager = invoke('GameServer/Bot/BotManager'), Events = invoke('GameServer/Bot/AI/DecisionEvents');
    const Hot = invoke('GameServer/Bot/AI/HotTownRebuff');
    const actor = { fetchId: () => 5, effects: {} }, session = { actor, decisionStats: { woken: 0, waiting: 0 } };
    const find = Manager.findSessionById, raise = Events.raiseDecision;
    const posts = [];
    Manager.findSessionById = () => session;
    Events.raiseDecision = (body, name) => { posts.push(name); (body.nearRaise ||= { names: [] }).names.push({ name, payload: null }); };
    try {
        assert.equal(Hot.buffEnded(actor, ends + 30), true);
        assert.equal(Hot.buffEnded(actor, ends + 31), false, 'the next timer finds the raise held');
        session.nearRaise = null; session.decisionStats = { woken: 0, waiting: Situations.BITS.rebuff };
        assert.equal(Hot.buffEnded(actor, ends + 40), false, 'nor while the decision waits for its stop');
        assert.deepEqual(posts, ['buffs_expired']);
    } finally { Manager.findSessionById = find; Events.raiseDecision = raise; }
}

// Heard at the next stop: the hunt goes on, the rest end (or the town) takes it.
{
    const stats = { woken: 0, waiting: 0 };
    Situations.raise(stats, 'buffs_expired', null, Situations.place({ phase: 'cold', activity: 'hunting' }));
    assert.equal(Situations.woken(stats, 'rebuff'), false, 'a hunting bot does not stop for it');
    Situations.stop(stats, Situations.REST);
    assert.equal(Situations.woken(stats, 'rebuff'), true, 'its rest hears it');
    const town = { woken: 0, waiting: 0 };
    Situations.raise(town, 'arrived_town', null, Situations.OPEN);
    assert.equal(Situations.woken(town, 'rebuff'), true, 'a town arrival wakes it');
    const geared = Situations.raise({ woken: 0, waiting: 0 }, 'gear_changed', null, Situations.OPEN);
    assert.equal(Situations.woken(geared, 'rebuff'), false, 'its gear, money or prices wake it not');
}

// The rule: grouped none; the guide for a newbie in reach; a far hunter alone none.
{
    assert.equal(Rebuff.decide({ grouped: true, guide: true }, at).via, 'none');
    assert.equal(Rebuff.decide({ guide: true, hall: true, provider: 7 }, at).via, 'guide', 'the free guide first');
    assert.deepEqual(Rebuff.decide({ provider: 7 }, at), { via: 'buffer', providerId: 7, at });
    assert.equal(Rebuff.decide({}, at).via, 'none');
    const talkingIsland = Buffs.GUIDES[0];
    assert.equal(Buffs.guideInReach({ locX: talkingIsland.locX + 5000, locY: talkingIsland.locY }), true);
    assert.equal(Buffs.guideInReach({ locX: talkingIsland.locX + 9000, locY: talkingIsland.locY }), false);
    assert.equal(Buffs.newbieEligible(Buffs.NEWBIE_GUIDE_MAX_LEVEL, 0), true);
    assert.equal(Buffs.newbieEligible(Buffs.NEWBIE_GUIDE_MAX_LEVEL + 1, 0), false);
    assert.equal(Buffs.newbieEligible(10, 5), false, 'no blessing with karma');
}

// A far newbie's guide visit: the blessing and full HP/MP, the walk spent resting; done once.
{
    const guide = Buffs.GUIDES[0];
    const newbie = { characterId: 1, name: 'Newbie', level: 12, activity: 'hunting', phase: 'cold',
        loc: { locX: guide.locX + 3000, locY: guide.locY, locZ: guide.locZ },
        vitals: { hp: 10, maxHp: 200, mp: 5, maxMp: 100 },
        stats: { karma: 0, coldCombat: { effects: [] }, rebuff: { via: 'guide', providerId: null, at } } };
    const visit = Guide.plan(newbie, at);
    assert.deepEqual(visit.patch.stats.coldCombat.effects.map(effect => effect.key).sort(), blessing.map(effect => effect.key).sort());
    assert.equal(visit.patch.vitals.hp, 200);
    assert.equal(visit.patch.activity, 'resting', 'the walk to the guide and back is no hunt');
    assert.equal(visit.patch.stats.restUntil, at + 50000, '6000 units there and back at 120 a second');
    assert.equal(visit.patch.stats.rebuff.done, true);
    assert.equal(Guide.pending({ ...newbie, stats: visit.patch.stats }), null, 'carried out once');
    const outgrown = Guide.plan({ ...newbie, level: Buffs.NEWBIE_GUIDE_MAX_LEVEL + 1 }, at);
    assert.deepEqual(outgrown.patch.stats.coldCombat.effects, [], 'a bot past the guide\'s levels gets nothing');
    assert.equal(outgrown.patch.stats.rebuff.done, true, 'its answer holds done: no retry');
    const died = Guide.plan({ ...newbie, activity: 'dead', vitals: { ...newbie.vitals, hp: 0 } }, at);
    assert.equal(died.patch.vitals, undefined, 'a bot that died in the round walks to no guide: no HP, no blessing');
    assert.deepEqual(died.patch.stats.coldCombat.effects, []);
    assert.equal(died.patch.activity, undefined, 'it stays dead for its death recovery');
    assert.equal(died.patch.stats.rebuff.done, true);
}
console.log('PASS rebuff: buffs_expired at the last buff\'s end or first read unbuffed in the field, heard at the stop; the guide for a newbie in reach, none grouped or dead; one visit per answer');
