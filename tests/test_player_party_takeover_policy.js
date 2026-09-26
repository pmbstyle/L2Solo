const assert = require('assert');

require('../src/Global');

const Takeover = invoke('GameServer/Bot/AI/PlayerPartyTakeover');
const Companion = invoke('GameServer/Bot/AI/PartyCompanionService');
const ClanService = invoke('GameServer/Clan/ClanService');
const InteractionMemory = invoke('GameServer/Social/InteractionMemoryRuntime');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const BotAvailability = invoke('GameServer/Bot/AI/BotAvailability');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Manager = invoke('GameServer/Bot/BotManager');
const Database = invoke('Database');

const saved = [];
function replace(object, key, value) {
    saved.push(() => { object[key] = value; });
    object[key] = value;
}

function player(level = 20, clanId = 0) {
    return {
        accountId: 'player_account',
        actor: {
            fetchId: () => 9001,
            fetchName: () => 'Player',
            fetchLevel: () => level,
            fetchClanId: () => clanId,
            fetchIsOnline: () => true,
            isDead: () => false
        }
    };
}

function state(id, level = 20, partyId = 'party-test', extras = {}) {
    return {
        characterId: id,
        name: `Bot${id}`,
        level,
        phase: 'cold',
        activity: 'hunting',
        party: { partyId, role: 'dps', leaderId: 1 },
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
        stats: {},
        ...extras
    };
}

async function run() {
    replace(Companion, 'membersForLeader', () => []);
    replace(InteractionMemory, 'ensureMany', async () => true);
    replace(BotSocialMemory, 'load', async () => null);
    replace(BotAvailability, 'evaluateState', () => ({
        relationshipReason: null,
        memory: { trust: 0, recentlyAbandonedAt: null }
    }));
    replace(BotAvailability, 'evaluate', () => ({
        relationshipReason: null,
        memory: { trust: 0, recentlyAbandonedAt: null }
    }));
    replace(ClanService, 'findById', () => null);

    let members = [state(1), state(2)];
    let party = { partyId: 'party-test', memberIds: [1, 2], status: 'active', stats: {} };
    let result = await Takeover.evaluate(player(20), party, members);
    assert(result.ok, 'an ordinary compatible leveling party should accept');

    members = [state(1, 70), state(2, 70)];
    result = await Takeover.evaluate(player(20), party, members);
    assert.strictEqual(result.reason, 'level_mismatch', 'every member must remain eligible for party experience');

    members = [state(1), state(2)];
    BotAvailability.evaluateState = (_player, candidate) => ({
        relationshipReason: candidate.characterId === 2 ? 'relationship_hostile' : null,
        memory: { trust: candidate.characterId === 2 ? -8 : 0, recentlyAbandonedAt: null }
    });
    result = await Takeover.evaluate(player(20), party, members);
    assert.strictEqual(result.reason, 'relationship_hostile', 'one hostile member should veto a non-clan request');

    ClanService.findById = id => Number(id) === 77
        ? { members: [{ id: 1 }, { id: 2 }, { id: 9001 }] }
        : null;
    members = [state(1, 70), state(2, 70)];
    result = await Takeover.evaluate(player(20, 77), party, members);
    assert(result.ok && result.clanmate, 'a same-clan roster should override level and social refusal');

    party = { ...party, stats: { objective: { sourceKind: 'raid', raidBossTemplateId: 29001 } } };
    result = await Takeover.evaluate(player(20, 77), party, members);
    assert.strictEqual(result.reason, 'party_busy', 'same clan must not bypass hard special-operation safety');

    party = { partyId: 'party-test', memberIds: [1, 2], status: 'active', stats: {
        coldCompetition: { outcome: 'pvp_retreated', conflictUntil: Date.now() - 1000, wait: null }
    } };
    members = [state(1, 20, party.partyId, { stats: {
        coldCompetition: { outcome: 'pvp_retreated', conflictUntil: Date.now() - 1000, wait: null }
    } }), state(2, 20, party.partyId)];
    BotAvailability.evaluateState = () => ({
        relationshipReason: null,
        memory: { trust: 0, recentlyAbandonedAt: null }
    });
    BotAvailability.evaluate = BotAvailability.evaluateState;
    result = await Takeover.evaluate(player(20), party, members);
    assert(result.ok, 'completed competition history must not keep a party permanently busy');

    party.stats.coldCompetition.wait = { until: Date.now() + 60000, combat: true };
    result = await Takeover.evaluate(player(20), party, members);
    assert.strictEqual(result.reason, 'party_busy', 'an active competition wait must still block takeover');

    party = { partyId: 'party-test', memberIds: Array.from({ length: 9 }, (_, index) => index + 1), status: 'active', stats: {} };
    members = party.memberIds.map((id) => state(id));
    result = await Takeover.evaluate(player(20), party, members);
    assert.strictEqual(result.reason, 'invalid_party_roster', 'nine bots cannot fit beside a player in a C4 party');

    party = { partyId: 'party-test', memberIds: [1, 2], status: 'hot', stats: {}, updatedAt: 500 };
    members = [state(1, 20, party.partyId, { phase: 'hot', simulation: { revision: 4 }, updatedAt: 400 }),
        state(2, 20, party.partyId, { phase: 'hot', simulation: { revision: 7 }, updatedAt: 450 })];
    const sessions = members.map((member) => ({ actor: { fetchId: () => member.characterId } }));
    let commitRequest = null;
    let attached = null;
    replace(ClanService, 'findById', () => null);
    replace(BotAvailability, 'evaluateState', () => ({ relationshipReason: null, memory: { trust: 0 } }));
    replace(BotAvailability, 'evaluate', () => ({ relationshipReason: null, memory: { trust: 0 } }));
    replace(Parties, 'find', () => party);
    replace(Parties, 'acceptRow', () => ({ ...party, status: 'player_taken_over' }));
    replace(Life, 'statesByIds', async () => members);
    replace(Life, 'settleWrites', async () => true);
    replace(Life, 'acceptLifecycleRow', (row) => row);
    replace(Manager, 'findSessionById', (id) => sessions.find((entry) => entry.actor.fetchId() === Number(id)));
    replace(Companion, 'canAttachRoster', () => ({ ok: true }));
    replace(Companion, 'attachRoster', (_leader, roster, options) => {
        attached = { roster, options };
        return { ok: true, reason: 'party_taken_over', count: roster.length };
    });
    replace(Database, 'takeOverBackgroundParty', async (request) => {
        commitRequest = request;
        return { ok: true, party: {}, rows: members };
    });
    replace(BotSocialMemory, 'recordEvent', async () => true);
    sessions.forEach((session) => { session.hotBackgroundPartyId = party.partyId; });
    result = await Takeover.request({ playerSession: player(20), target: sessions[0], source: 'test_chat' });
    assert(result.ok && result.applied, 'a hot compatible roster should transfer to the player');
    assert.strictEqual(commitRequest.expectedUpdatedAt, 500);
    assert.deepStrictEqual(commitRequest.members.map((member) => member.expectedRevision), [4, 7]);
    assert.strictEqual(attached.roster.length, 2);
    assert.strictEqual(attached.options.expectedBackgroundPartyId, party.partyId);
}

run().then(() => {
    while (saved.length) saved.pop()();
    console.log('player party takeover policy tests passed');
}).catch((error) => {
    while (saved.length) saved.pop()();
    console.error(error);
    process.exit(1);
});
