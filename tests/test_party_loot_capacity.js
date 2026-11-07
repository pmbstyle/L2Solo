'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');

const Data = invoke('GameServer/DataCache');
const Item = invoke('GameServer/Item/Item');
const Backpack = invoke('GameServer/Model/Backpack');
const Party = invoke('GameServer/Bot/AI/PartyCompanionService');
const Manager = invoke('GameServer/Bot/BotManager');
const Pickup = invoke('GameServer/World/Generics/PickupItem');
const GroundItems = require('../src/GameServer/World/GroundItems');
Data.init();

let nextId = 870000;
function item(selfId, amount = 1) {
    const template = Data.items.find(row => row.selfId === selfId);
    assert(template, `missing item template ${selfId}`);
    return new Item(++nextId, { ...utils.crushOb(template), amount });
}
function session(id, items = [], maxLoad = 1000) {
    const backpack = new Backpack({});
    backpack.items = items;
    return { actor: {
        backpack, fetchId: () => id, fetchRace: () => 0, fetchMaxLoad: () => maxLoad,
        fetchLocX: () => 0, fetchLocY: () => 0,
        fetchIsOnline: () => true, isDead: () => false
    }, packets: [], dataSendToMe(packet) { this.packets.push(packet); }, dataSendToMeAndOthers() {} };
}
function party(distribution, overloaded = true) {
    const leader = session(1), bot = session(2, overloaded ? [item(1835, 10000)] : []), other = session(3);
    assert(!overloaded || bot.actor.backpack.fetchTotalLoad() > bot.actor.fetchMaxLoad());
    leader.partyCompanionSettings = { distribution, itemLastLootIndex: -1 };
    for (const member of [bot, other]) {
        member.partyCompanion = true;
        member.followPlayerSession = leader;
    }
    Manager.sessions = [bot, other];
    return { leader, bot, other };
}
function world(drops, award = () => {}) {
    return { items: { spawns: drops }, awards: [], purchaseItem(...args) {
        this.awards.push(args);
        return award(...args);
    } };
}
const pick = (world, picker, drop) => Pickup.call(world, picker, picker.actor, drop);
const messages = picker => picker.packets.filter(packet => packet[0] === 0x64).map(packet => packet.readInt32LE(1));
const originalSessions = Manager.sessions, originalRandom = Math.random;

(async () => {
    try {
        // Soulshots overload one companion. Every picker must still be able
        // to collect weightless Adena, preserving that companion's share.
        for (const pickerName of ['leader', 'bot', 'other']) {
            const members = party(1), coins = item(57, 10), w = world([coins]);
            assert.equal(pick(w, members[pickerName], coins), true, `${pickerName}: an overloaded companion must not block party Adena`);
            assert.deepEqual(w.awards.map(([recipient, selfId, amount]) => [recipient.actor.fetchId(), selfId, amount]),
                [[1, 57, 4], [2, 57, 3], [3, 57, 3]], 'keep the complete split, including the overloaded bot');
            assert.deepEqual(w.items.spawns, []);
        }

        // Force Random toward the overloaded bot in the original roster.
        Math.random = () => 0.5;
        for (const distribution of [1, 2, 3, 4]) {
            for (const pickerName of ['leader', 'bot', 'other']) {
                const members = party(distribution);
                members.leader.partyCompanionSettings.itemLastLootIndex = 0;
                for (const selfId of [1865, 2155]) {
                    const drop = item(selfId, 2), w = world([drop]);
                    assert.equal(pick(w, members[pickerName], drop), true, `mode ${distribution}, ${pickerName}: skip a recipient overloaded with shots`);
                    assert.notEqual(w.awards[0][0], members.bot);
                    assert.equal(w.awards[0][2], 2);
                }
            }
        }

        const turn = party(3);
        const drops = Array.from({ length: 4 }, () => item(1865));
        const turns = world(drops.slice());
        drops.forEach(drop => assert.equal(pick(turns, turn.leader, drop), true));
        assert.deepEqual(turns.awards.map(([recipient]) => recipient.actor.fetchId()), [1, 3, 1, 3],
            'skipping a full member must preserve the original turn order');
        turn.bot.actor.backpack.items = [];
        for (const expected of [turn.leader, turn.bot]) {
            const recovered = item(1865); turns.items.spawns.push(recovered);
            assert.equal(pick(turns, turn.leader, recovered), true);
            assert.equal(turns.awards.at(-1)[0], expected, 'a recovered member rejoins its original place in the rotation');
        }

        const finder = party(0), finderDrop = item(1865), finderWorld = world([finderDrop]);
        assert.equal(pick(finderWorld, finder.bot, finderDrop), false, 'Finder still enforces the actual picker capacity');
        assert.deepEqual(finderWorld.items.spawns, [finderDrop]);
        assert(messages(finder.bot).includes(422));
        assert.equal(pick(finderWorld, finder.leader, finderDrop), true);
        assert.equal(finderWorld.awards[0][0], finder.leader);

        // A full bag is also ineligible for new material stacks, while an
        // existing stack still fits and remains eligible for distribution.
        const full = party(1, false);
        full.bot.actor.backpack.items = Array.from({ length: 80 }, () => item(955));
        const material = item(1865), fullWorld = world([material]);
        assert.equal(pick(fullWorld, full.leader, material), true);
        assert.notEqual(fullWorld.awards[0][0], full.bot);
        full.bot.actor.backpack.items[0] = item(1865);
        full.bot.actor.fetchMaxLoad = () => 1000000;
        const stack = item(1865), stackWorld = world([stack]);
        assert.equal(pick(stackWorld, full.leader, stack), true);
        assert.equal(stackWorld.awards[0][0], full.bot);

        // Recipient selection must see awards still waiting for persistence.
        const pending = party(1, false);
        pending.bot.actor.fetchMaxLoad = () => item(1865).fetchMass();
        const first = item(1865), second = item(1865), finishes = [];
        const pendingWorld = world([first, second], () => new Promise(resolve => finishes.push(resolve)));
        assert.equal(pick(pendingWorld, pending.leader, first), true);
        assert.equal(pendingWorld.awards[0][0], pending.bot);
        assert.equal(pick(pendingWorld, pending.leader, second), true);
        assert.notEqual(pendingWorld.awards[1][0], pending.bot, 'a pending award reserves the bot weight during selection');
        finishes.forEach(done => done());
        await Promise.resolve();

        const blocked = party(3);
        blocked.leader.actor.fetchMaxLoad = blocked.other.actor.fetchMaxLoad = () => 0;
        const blockedDrop = item(1865), blockedWorld = world([blockedDrop]);
        assert.equal(pick(blockedWorld, blocked.leader, blockedDrop), false);
        assert.deepEqual(blockedWorld.items.spawns, [blockedDrop]);
        assert.equal(blockedWorld.awards.length, 0);
        assert.equal(blocked.leader.partyCompanionSettings.itemLastLootIndex, -1, 'a rejected pickup must not consume a turn');
        assert(messages(blocked.leader).includes(422), 'retain weight feedback when nobody can accept the drop');
        // The party's loot scan leaves the refused drop alone until a bag changes,
        // instead of sending a companion to it again every scan.
        const World = invoke('GameServer/World/World'), savedItems = World.items;
        Object.assign(blockedDrop, { partyLootLeaderId: 1, fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0 });
        const Combat = invoke('GameServer/Bot/AI/PartyCombatState'), combatActive = Combat.isActive;
        const Generics = invoke(path.actor), actions = { stop: Generics.stopAutomation, pickup: Generics.pickupExec };
        World.items = { spawns: [], byLeader: new Map() }; GroundItems.put(World.items, blockedDrop); Combat.isActive = () => false;
        Generics.stopAutomation = () => {}; Generics.pickupExec = () => {};
        try {
            blocked.leader.lastGroundLootScanAt = 0;
            assert.equal(Party.reconcileGroundLoot(blocked.leader), 0, 'no picker is sent to a drop nobody has room for');
            blocked.other.actor.fetchMaxLoad = () => 1000000;
            blocked.leader.lastGroundLootScanAt = 0;
            assert.equal(Party.reconcileGroundLoot(blocked.leader), 1, 'room in a bag makes the drop worth a pickup again');
        } finally {
            World.items = savedItems; Combat.isActive = combatActive;
            Generics.stopAutomation = actions.stop; Generics.pickupExec = actions.pickup;
        }
        assert.equal(invoke('Database').isReady(), false, 'the regression must not open a live database');
        console.log('Party loot capacity: overloaded soulshots, all pickers/modes, Adena split, turn recovery, full bags and pending awards passed');
    } finally {
        Manager.sessions = originalSessions;
        Math.random = originalRandom;
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
