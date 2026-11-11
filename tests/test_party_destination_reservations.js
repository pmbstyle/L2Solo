'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const world = require('./fixtures/native_stock_world')();
require('../src/Global');
const DB = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const BotRoute = require('../src/GameServer/Bot/Population/BotRoute');
const Lifecycle = require('../src/GameServer/Bot/Population/BackgroundPartyLifecycle');
const Material = require('../src/GameServer/Bot/Population/CraftMaterialParty');
const { beginHuntingTrip } = require('../src/GameServer/Bot/Population/HuntingTravel');
const { finishPartyRouteTravelState } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const Assembly = require('../src/GameServer/Bot/Population/PartyHuntingAssembly');
const spot = { id: '27_-3', name: 'Shared destination', capacity: 5, density: 13,
    center: { locX: 167478, locY: -14034, locZ: -3121 }, arrivalPoints: [], npcEntries: [] };
const objective = { status: 'open', priority: 'required', materialParty: true, reason: 'craft_material',
    spotId: spot.id, objectiveKey: `craft-material:${spot.id}`, itemId: 4104, targetId: 78,
    npcId: 1005, sourceKind: 'drop', requiredTotal: 12, amount: 12 };
const at = Date.now(), ids = [];

(async () => {
    DB.init(); invoke('GameServer/DataCache').init();
    for (let i = 0; i < 5; i++) {
        const account = `assembly_reservation_${i}`;
        await DB.createAccount(account, 'fixture');
        const id = Number((await DB.createCharacter(account, { name: `AssemblyReserve${i}`, classId: 14, race: 0,
            sex: 0, face: 0, hair: 0, hairColor: 0, maxHp: 100, maxMp: 100, locX: 0, locY: 0, locZ: 0 })).insertId);
        ids.push(id);
        await DB.execute([`INSERT INTO bot_life_state(characterId,accountName,characterName,phase,activity,partyId,
            spotId,level,hp,maxHp,mp,maxMp,locX,locY,locZ,updatedAt,statsJson)
            VALUES(?,?,?,'cold','grouped','old-assembly','elsewhere',60,100,100,100,100,0,0,0,?,?)`,
        [id, account, `AssemblyReserve${i}`, at, JSON.stringify({ classId: 14, role: 'mage', leaderId: ids[0],
            hennas: [null, null, null], coldCombat: { skillSource: 'database',
                version: invoke('GameServer/Bot/Population/ColdCombatProfile').PROFILE_VERSION, skills: [] } })]]);
    }
    const prepared = Parties.prepareCommit({ partyId: 'old-assembly', status: 'active', leaderId: ids[0],
        memberIds: ids, spotId: spot.id, startedAt: at, stats: { objective } });
    await DB.saveBackgroundParty(prepared.row);
    await Life.init(); await Parties.init();
    const members = ids.map(id => Life.cachedState(id));
    assert(members.every(state => state.spotId === 'elsewhere' && state.loc.locX === 0),
        'a party destination never moves a physical actor');
    // The party record holds the destination; no member keeps a copy and no
    // place is held for the party ahead of its arrival (ARCH-08-c).
    assert(members.every(state => state.stats.backgroundPartySpotId === undefined),
        'startup copies the party destination into no member');

    const party = Parties.find('old-assembly');
    const everyState = Life.everyState;
    Life.everyState = () => { throw Error('party gathering scanned the population'); };
    let route;
    try {
        route = BotRoute.route(members[0], null, party, members, { spots: [spot], timestamp: at });
    } finally { Life.everyState = everyState; }
    assert(route?.needed && route.mode === 'party');
    const departed = members.map(state => beginHuntingTrip(state, route, at));
    assert(departed.every(state => state.loc.locX === 0 && state.stats.backgroundPartySpotId === undefined));
    const arrived = departed.map(state => finishPartyRouteTravelState(state, at + route.travelMs));
    assert(Assembly.ready(party, arrived, spot), 'normal party travel gathers the full roster on the spot');

    const owners = members.map((state, i) => ({ ...state, inventory: {}, stats: { ...state.stats,
        equipmentPlan: { status: 'active', strategy: 'craft', target: { selfId: i === 1 ? 148 : 78 } } } }));
    const blocked = { ...party, stats: { ...party.stats,
        objective: { ...objective, helpDeal: { payerId: ids[0], itemId: 4104, fee: 1000 } },
        agreement: { materialNeeds: [
            { ...objective, characterId: ids[0], quota: 12, collected: 2 },
            { ...objective, characterId: ids[1], itemId: 4108, targetId: 148, quota: 12, collected: 0 }
        ] } } };
    // An assembly nothing more comes to: its members leave (BackgroundPartyResolver's assemblyAbsent).
    const absent = new Map(owners.map(state => [Number(state.characterId), require('../src/GameServer/Bot/Population/PartyHuntingAssembly').REASON]));
    const reviewed = Lifecycle.release(blocked, owners, absent, at + 300000);
    assert.equal(reviewed.party.status, 'dissolved');
    const released = reviewed.states.find(state => state.characterId === ids[1]);
    assert.equal(released.stats.partyRequest.itemId, 4108, 'the Valhalla owner keeps its blade need, not the leader Great Sword need');
    assert.equal(released.stats.partyRequest.targetId, 148);
    assert.equal(released.stats.partyRequest.amount, 12);
    assert.equal(released.stats.partyRequest.attempts, 1, 'the next bounded material review may try another camp');
    assert(!released.stats.partyRequest.helpDeal, 'a departed owner cannot inherit another payer helper proposal');
    assert.equal(reviewed.states[0].stats.partyRequest.amount, 10, 'only the uncollected quota is requested again');
    assert(!reviewed.states[2].stats.partyRequest.materialParty, 'a helper cannot inherit somebody else material goal');
    assert(reviewed.states.every(state => !state.party.partyId));
    assert.equal(Material.requestOf(released).status, 'closed');
    await DB.execute([`UPDATE bot_life_state SET partyId=NULL, activity='hunting', statsJson=?, updatedAt=? WHERE characterId=?`,
        [JSON.stringify(released.stats), released.updatedAt, released.characterId]]);
    Life.acceptLifecycleRow((await DB.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [released.characterId]]))[0]);
    const durable = JSON.parse((await DB.execute(['SELECT statsJson FROM bot_life_state WHERE characterId=?',
        [released.characterId]]))[0].statsJson).partyRequest;
    assert.equal(durable.itemId, 4108);
    assert.equal(durable.attempts, 1, 'the closed request keeps the need and its failed-camp count for the next build');
    console.log('PASS old-party startup without a member copy, native gathering and personal material recovery');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => world.close());
