'use strict';
// Task 2: finite farm and spoil facts read by the rules the bot hunts and spoils by.
const assert = require('node:assert/strict');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Towns = require('../src/GameServer/World/TownRespawn');
function drain(iterator) {
    const stages = []; let next;
    do { next = iterator.next(); if (!next.done) stages.push(next.value); } while (!next.done);
    return { value: next.value, stages };
}
const saved = { items: Data.items, npcs: Data.npcs, rewards: Data.npcRewards };
try {
    Data.items = [...saved.items, { selfId: 99101, template: { name: 'Facts Test Stem', kind: 'Other.Material' }, etc: { stackable: true } }];
    Data.npcs = [...saved.npcs, { selfId: 99001, template: { name: 'Facts Test Mob', level: 40, kind: 'Monster' } }];
    Data.npcRewards = [...saved.rewards, { selfId: 99001, template: { name: 'Facts Test Mob' },
        rewards: [{ overall: 100, items: [{ selfId: 99101, chance: 100, min: 1, max: 1 }] }],
        spoils: [{ overall: 100, items: [{ selfId: 99101, chance: 100, min: 2, max: 2 }] }] }];
    const spots = [{ id: 'facts-test', avgLevel: 40, capacity: 9, density: 4,
        center: { locX: Towns.towns.giran_town.locX + 2000, locY: Towns.towns.giran_town.locY, locZ: Towns.towns.giran_town.locZ },
        npcEntries: [{ selfId: 99001, count: 1 }, { selfId: 99002, count: 3 }], npcSelfIds: [99001, 99002] }];
    const spotValue = () => ({ kills: 100, valueHours: 0.75 });
    const armed = state => {
        const role = Planner.roleFor(state);
        const weapon = saved.items.find(item => [7, 14].includes(Number(item.etc?.slot))
            && Planner.suitable(item, state, role, String(item.etc?.rank || 'none')));
        return { ...state, inventory: { [weapon.selfId]: { selfId: weapon.selfId, amount: 1, equipped: true,
            equippedCount: 1, slot: Number(weapon.etc.slot) } } };
    };
    const base = { characterId: 990001, level: 42, adena: 0, spotId: 'facts-test', loc: spots[0].center, inventory: {} };
    const warsmith = armed({ ...base, stats: { classId: 57, coldCombat: { skills: [{ selfId: 254, level: 1 }] } } });
    const noSpoil = armed({ ...base, characterId: 990002, stats: { classId: 54, coldCombat: { skills: [] } } });
    const facts = (state, options = {}) => drain(Planner.sourceFacts(state, 99101, 50,
        { spots, spotValue, timestamp: 1, ...options })).value;
    const byKind = rows => Object.fromEntries(rows.map(row => [row.kind, row]));

    // On the current spot: no trip; hours from kills x yield x the NPC's share (1 of 4);
    // an hour costs the bot's hour less what the spot gives back (1 - 0.75).
    const own = byKind(facts(warsmith));
    assert.equal(own.drop.status, 'ready');
    assert.equal(own.drop.perHour, 25);
    assert.equal(own.drop.hours, 2);
    assert.equal(own.drop.netHourCost, 0.25);
    assert.equal(own.drop.tripHours, 0);
    assert.equal(own.drop.costHours, 0.5);
    assert.equal(own.spoil.status, 'ready', 'a warsmith with Spoil learned can spoil');
    assert.equal(own.spoil.hours, 1);

    // Spoil eligibility is the executor's rule (learned skill 254), not the class (E189).
    assert.equal(byKind(facts(noSpoil)).spoil.reason, 'spoil_skill');
    assert.equal(byKind(facts(noSpoil)).drop.status, 'ready');

    // Hunt rules: level band, occupancy, solo safety; raids are not a solo farm.
    assert.equal(byKind(facts({ ...warsmith, level: 50 })).drop.reason, 'level_band');
    assert.equal(byKind(facts(warsmith, { occupancy: { 'facts-test': { count: 9, capacity: 9 } } })).drop.reason, 'occupied');
    assert.equal(byKind(facts({ ...warsmith, inventory: {} })).drop.reason, 'party_needed');
    const raid = drain(Planner.sourceFacts(warsmith, 99101, 1, { spotValue, timestamp: 1,
        spots: [{ ...spots[0], id: 'facts-raid', raidBoss: true, raidBossTemplateId: 99001 }] })).value;
    assert(raid.every(row => row.reason === 'raid'));
    // A siege guard is never a bot's farm (BotHuntingTargetPolicy.canHunt); the
    // answer is read once per loaded NPC table and follows a replaced table.
    const ordinaryNpcs = Data.npcs;
    Data.npcs = ordinaryNpcs.map(npc => npc.selfId === 99001 ? { ...npc, clanName: 'Siege Guard' } : npc);
    const guarded = facts(warsmith);
    assert(guarded.length === 2 && guarded.every(row => row.reason === 'cannot_hunt'));
    Data.npcs = ordinaryNpcs;
    assert.equal(byKind(facts(warsmith)).drop.status, 'ready');

    // Unknown is explicit: no kills, no income, no route.
    assert.equal(byKind(facts(warsmith, { spotValue: () => null })).drop.reason, 'yield');
    assert.equal(byKind(facts(warsmith, { spotValue: () => ({ kills: 100, valueHours: NaN }) })).drop.reason, 'income');
    const away = { ...warsmith, spotId: 'elsewhere' };
    const noCenter = drain(Planner.sourceFacts(away, 99101, 1, { spotValue, timestamp: 1,
        spots: [{ ...spots[0], center: null }] })).value;
    assert(noCenter.every(row => row.status === 'unknown' && row.reason === 'route'));

    // Away from the spot: a round trip to its regional town, read once per town.
    const trips = new Map();
    const travelled = drain(Planner.sourceFacts(away, 99101, 50, { spots, spotValue, timestamp: 1, trips }));
    const drop = byKind(travelled.value).drop;
    assert.equal(drop.status, 'ready');
    assert(drop.town && trips.size === 1, 'two sources on one spot read one trip');
    assert(Number.isFinite(drop.tripHours) && drop.tripHours >= 0);
    assert.equal(drop.costHours, drop.hours * drop.netHourCost + drop.tripHours);
    assert.equal(travelled.stages.filter(stage => stage === 'source').length, 2, 'one step per index record');
    // The spot's town is found once per planning spot: a later read walks no region edge and names the same town.
    const again = drain(Planner.sourceFacts(away, 99101, 50, { spots, spotValue, timestamp: 1, trips }));
    assert.equal(byKind(again.value).drop.town, drop.town);
    assert(travelled.stages.includes('edge') && !again.stages.includes('edge'), 'regional town read once per spot');
    // A known non-spoiler is read once from its learned skills, never from a combat profile per spoil record.
    const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile'), profileFor = Profile.profileFor;
    let profiles = 0;
    Profile.profileFor = (...args) => { profiles++; return profileFor(...args); };
    try {
        const twoSpots = [spots[0], { ...spots[0], id: 'facts-test-2' }];
        const refused = drain(Planner.sourceFacts(noSpoil, 99101, 50, { spots: twoSpots, spotValue, timestamp: 1 })).value
            .filter(row => row.kind === 'spoil');
        assert.equal(refused.length, 2);
        assert(refused.every(row => row.reason === 'spoil_skill'));
        assert.equal(profiles, 0, 'no combat profile for spoil eligibility');
    } finally { Profile.profileFor = profileFor; }

    // A travelling bot's spot is its destination, as PopulationService reads it.
    const travelling = byKind(facts({ ...warsmith, spotId: 'elsewhere', stats: { ...warsmith.stats, travel: { spotId: 'facts-test' } } })).drop;
    assert.equal(travelling.tripHours, 0, 'the destination spot needs no further trip');
    console.log('test_source_facts: ok');
} finally { Data.items = saved.items; Data.npcs = saved.npcs; Data.npcRewards = saved.rewards; }
