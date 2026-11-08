const assert = require('assert');
require('../src/Global');
const Rescue = invoke('GameServer/Bot/Population/ClanPartyRescue');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Clan = invoke('GameServer/Clan/ClanService');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Chat = invoke('GameServer/Bot/AI/BotClanChat');
const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const Planner = invoke('GameServer/Bot/Population/PartyRequestPlanner');
const { lifecycleKind } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const objective = { status: 'open', priority: 'required', clanGoalKey: 'equipment:11', clanId: 11,
    spotId: 'hunt', npcId: 660, minPartySize: 3, maxPartySize: 5, clanOperation: 'equipment' };
const bot = id => ({ characterId: id, name: `Member${id}`, phase: 'cold', activity: 'hunting', level: 53,
    vitals: { hp: 500, maxHp: 500 }, stats: {}, loc: { locX: 1, locY: 1, locZ: 0 } });
const originals = [];
function stub(obj, key, value) { const old = obj[key]; originals.push(() => { obj[key] = old; }); obj[key] = value; }
async function run() {
    let parties = [], created = null, replies = 0, released = 0;
    stub(Parties, 'active', () => parties); stub(Parties, 'find', id => parties.find(p => p.partyId === id));
    stub(Parties, 'activeByGoalKey', key => parties.filter(p => p.status === 'active' && p.stats?.objective?.clanGoalKey === key));
    stub(Clan, 'findById', () => ({ members: [1, 2, 3, 4].map(id => ({ id })) }));
    stub(Chat, 'onPartyHelp', () => { replies++; });
    const requester = bot(1); requester.stats.clanPartyObjective = objective;
    const helper = bot(2); helper.stats.equipmentPlan = { requiresParty: true, partyNeed: 'required' };
    const third = { ...bot(3), activity: 'shopping' };
    const input = { requester, objective, rows: [requester, helper, third], entry: { clanId: 11 }, now: 1000000,
        listeners: () => true, create: async (members, goal) => {
            created = { memberIds: members.map(m => m.characterId), members, stats: { objective: goal } }; return created;
        }, commit: async () => { throw Error('unexpected commit'); }, release: async state => {
            released++; return { ...state, party: null };
        } };
    const target = require('../src/GameServer/Bot/Population/PartyHuntingTarget');
    assert.strictEqual(target.npcId({ stats: { objective: { reason: 'clan_help', spotId: 'safe' } } },
        { stats: { equipmentPlan: { status: 'active', next: { npcId: 999 } } } }), 0,
        'leveling help must not hunt the leader personal gear NPC on another spot');
    assert.strictEqual(target.npcId({ stats: { objective } }, requester), 660);
    const held = Resolver.resolveSolo({ state: requester, spot: null, timestamp: input.now });
    assert.strictEqual(held.patch.activity, 'party_wait'); assert.strictEqual(held.debug.fights, 0);
    assert.strictEqual(held.materialize.exp, 0);
    assert.strictEqual(lifecycleKind({ ...requester, activity: 'party_wait' }), 'resolver');
    const waiter = { ...requester, activity: 'party_wait', stats: { ...requester.stats, eventWait: 'clan_party_assembly', partyRequest: objective } };
    assert.strictEqual(lifecycleKind(waiter), 'event_driven');
    assert.strictEqual(lifecycleKind({ ...waiter, stats: { ...waiter.stats, karma: 120 } }), 'event_driven',
        'a held waiter with karma takes no step: its hold has no due to loop on');
    const req = Planner.partyRequestForPlan(requester, { status: 'active', requiresParty: true, next: { spotId: 'personal' } }, input.now);
    assert.strictEqual(req.clanGoalKey, objective.clanGoalKey, 'personal goal cannot mask clan duty');
    await Rescue.rescue(input);
    assert.deepStrictEqual(created.memberIds, [1, 2, 3]); assert.strictEqual(replies, 1);
    assert(created.members.every(m => m.stats.clanPartyObjective.clanGoalKey === objective.clanGoalKey));
    created = null;
    await Rescue.rescue({ ...input, rows: [requester, helper] });
    assert.strictEqual(created, null, 'do not start an understaffed clan hunt');
    assert.strictEqual(released, 0, 'no helper is interrupted before a complete roster exists');
    const personal = { partyId: 'personal', status: 'active', memberIds: [2, 4], leaderId: 2, stats: {} };
    parties = [personal]; helper.party = { partyId: 'personal' };
    await Rescue.rescue(input); assert.strictEqual(released, 1, 'ordinary party gives way to clan distress');
    assert.strictEqual(replies, 2);
    await Rescue.rescue({ ...input, create: async () => null });
    assert.strictEqual(replies, 2, 'failed creation cannot produce a success reply');
    parties = [{ partyId: 'clan', status: 'active', leaderId: 1, memberIds: [1, 2], stats: { objective } }];
    requester.party = helper.party = { partyId: 'clan' };
    stub(Life, 'statesForParty', async () => [requester, helper]);
    let reinforced;
    await Rescue.rescue({ ...input, commit: async (party, members) => {
        reinforced = members; return { party, failed: [] };
    } });
    assert.strictEqual(reinforced.length, 3, 'a struggling existing clan party receives reinforcements');
    const outsider = { ...third, characterId: 99 };
    reinforced = null;
    await Rescue.rescue({ ...input, rows: [requester, helper, outsider], commit: async () => { throw Error('outsider recruited'); } });
    assert.strictEqual(reinforced, null);
    console.log('Clan duty waits for a group; distress preempts personal goals and parties, reinforces groups, and reports only committed help.');
}
run().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => originals.reverse().forEach(fn => fn()));
