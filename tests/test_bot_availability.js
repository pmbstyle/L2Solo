const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
const Availability = invoke('GameServer/Bot/AI/BotAvailability');
const Social = invoke('GameServer/Bot/AI/BotSocialMemory');
const Memory = invoke('GameServer/Social/InteractionMemoryRuntime');
const Clans = invoke('GameServer/Clan/ClanService');
const Income = invoke('GameServer/Bot/Population/PartyProgressComparison');
const Tendency = invoke('GameServer/Bot/AI/TendencyRoll');
const originals = { get: Social.getSnapshot, peek: Social.peekSnapshot, assess: Memory.assess,
    clan: Clans.findById, income: Income.compare, roll: Tendency.roll };
const actor = (id, level = 60, clanId = 0, dead = false) => ({
    fetchId: () => id, fetchName: () => `Actor${id}`, fetchLevel: () => level,
    fetchClanId: () => clanId, isDead: () => dead,
    fetchLocX: () => id === 2 ? 100000 : 0, fetchLocY: () => 0, fetchLocZ: () => 0
});
const player = { actor: actor(1) };
const persona = { primaryDrive: 'wealth', traits: { sociability: 0, empathy: 0, commitment: 0 } };
const state = { characterId: 2, name: 'Loner', level: 60, phase: 'cold', activity: 'hunting',
    spotId: 'home', adena: 21000000, loc: { locX: 100000, locY: 0, locZ: 0 },
    vitals: { hp: 100 }, persona,
    stats: { classId: 23, wishFocus: ['power:2384:10', 0, 173420], money: [1000000, .000001, 175837] } };
const hot = { actor: actor(2), accountId: 'bot_loner', plan: 'hunting', persona, coldLifeState: state };
let memory = {}, relation = { ready: true, personal: null }, reads = 0, previews = 0;
const both = (options = {}, h = hot, c = state) => [Availability.evaluate(player, h, options),
    Availability.evaluateState(player, c, options)];
try {
    Social.getSnapshot = () => { reads++; return memory; };
    Social.peekSnapshot = () => { previews++; return memory; };
    Memory.assess = () => relation;
    Clans.findById = () => ({ members: [{ id: 2 }] });
    Income.compare = () => { throw Error('player invitation must not forecast income'); };
    Tendency.roll = () => { throw Error('player invitation must not roll persona tendencies'); };

    for (let inviteAttempts = 0; inviteAttempts < 64; inviteAttempts++) {
        memory = { trust: 0, familiarity: 0, inviteAttempts };
        assert(both().every(r => r.available), 'a rich, unfamiliar loner accepts every eligible player invite');
    }
    for (const activity of ['hunting', 'resting', 'shopping', 'merchant', 'crafting', 'traveling', 'pk_hunting', 'dead']) {
        const cold = { ...state, activity, vitals: { hp: activity === 'dead' ? 0 : 100 } };
        const live = { ...hot, plan: activity, actor: actor(2, 60, 0, activity === 'dead') };
        assert(both({}, live, cold).every(r => r.available), `${activity} is not a player-party refusal`);
    }
    player.actor = actor(1, 60, 0, true);
    assert(both().every(r => r.available), 'a dead player may invite companions');
    player.actor = actor(1);
    assert.equal(both()[0].distance, 100000, 'distance remains diagnostic');

    for (const offset of [-13, -12, 12, 13]) {
        const results = both({}, { ...hot, actor: actor(2, 60 + offset) }, { ...state, level: 60 + offset });
        assert(results.every(r => r.reason === (Math.abs(offset) > 12 ? 'level_gap_too_large' : 'available')));
    }
    for (const options of [{}, { forceFriend: true }]) {
        for (const trust of [-6, -5, 0]) {
            memory = { trust, familiarity: 0, recentlyAbandonedAt: Date.now() };
            assert(both(options).every(r => r.reason === (trust <= -6 ? 'relationship_hostile' : 'available')),
                'recent departure alone never vetoes an invite, while real distrust does');
        }
        relation = { ready: true, personal: { trust: 0, hostility: 10 } };
        assert(both(options).every(r => r.reason === 'relationship_hostile'));
        relation = { ready: true, personal: null }; memory = {};
        assert(both(options, { ...hot, actor: actor(2, 73) }, { ...state, level: 73 })
            .every(r => r.reason === 'level_gap_too_large'), 'friend flags cannot bypass the level boundary');
    }
    for (const grouped of [{ hotBackgroundPartyId: 'party' }, { hotCompetitionCommit: {} },
        { partyCompanion: true, followPlayerSession: player },
        { coldLifeState: { ...state, party: { partyId: 'party' } } }]) {
        assert.equal(Availability.evaluate(player, { ...hot, ...grouped }).reason, 'already_grouped');
    }
    for (const grouped of [{ party: { partyId: 'party' } }, { partyId: 'party' },
        { stats: { ...state.stats, backgroundPartyId: 'party' } },
        { stats: { ...state.stats, playerPartyTakeover: { playerId: 3 } } }]) {
        assert.equal(Availability.evaluateState(player, { ...state, ...grouped }).reason, 'already_grouped');
    }
    player.actor = actor(1, 60, 77); hot.actor = actor(2, 60, 77);
    memory = { trust: -10 };
    assert(both().every(r => r.clanmate && r.reason === 'relationship_hostile'), 'clanmates use the same relationship rule');
    memory = {}; hot.actor = actor(2, 73, 77);
    assert.equal(Availability.evaluate(player, hot).reason, 'level_gap_too_large');
    hot.actor = actor(2); player.actor = actor(1);
    relation = { ready: false };
    assert(both().every(r => r.reason === 'relationship_unloaded'), 'previews wait for actual remembered relationships');
    relation = { ready: true, personal: null };

    const craft = { ...state, stats: { craftStationId: 'public', craftShop: { town: 'Giran' } } };
    const fixed = { ...hot, staticService: true };
    assert.equal(Availability.evaluateState(player, craft).reason, 'merchant_duty');
    assert.equal(Availability.evaluate(player, fixed, { forceFriend: true }).reason, 'merchant_duty');
    const merchant = { ...hot, actor: actor(6), plan: 'merchant', coldLifeState: { ...state, characterId: 6 } };
    assert.equal(Availability.evaluate(player, merchant).reason, 'available', 'an ordinary temporary seller can close its store and join');
    const own = { actor: actor(3), partyCompanion: true, followPlayerSession: player };
    const other = { actor: actor(4), partyCompanion: true, followPlayerSession: {} };
    const list = Availability.listForPlayer(player, [hot, own, other, fixed]);
    assert.deepEqual(list.map(row => row.session), [hot, other]);
    assert.equal(list[1].availability.reason, 'already_grouped');
    const before = reads;
    const catalog = Availability.catalogForPlayer(player, [hot, own, merchant, fixed],
        [state, { ...state, characterId: 3, name: 'Own' }, { ...state, characterId: 5, name: 'Cold' }, craft]);
    assert.deepEqual(catalog.map(c => c.name).sort(), ['Actor2', 'Actor6', 'Cold']);
    assert.equal(reads, before, 'catalog discovery must not fan out relationship reads');
    Availability.evaluate(player, hot, { loadMemory: false });
    assert.equal(reads, before); assert.equal(previews, 1);
    console.log('Player party availability: only relationships, levels and membership; hot/cold, activities, services and catalog passed');
} finally {
    Social.getSnapshot = originals.get; Social.peekSnapshot = originals.peek; Memory.assess = originals.assess;
    Clans.findById = originals.clan; Income.compare = originals.income; Tendency.roll = originals.roll;
}
