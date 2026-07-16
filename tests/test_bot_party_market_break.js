const assert = require('assert');

require('../src/Global');

const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const PartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
const PartyResolver = invoke('GameServer/Bot/Population/BackgroundPartyResolver');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const GoalService = invoke('GameServer/Bot/Goals/GoalService');
const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const RecruitmentChat = invoke('GameServer/Bot/Population/ColdPartyRecruitmentChat');

const originals = {
    statesForParty: LifeState.statesForParty, applyResolve: LifeState.applyResolve, leaveParty: LifeState.leaveParty,
    createOrUpdate: PartyState.createOrUpdate, findForState: SpotProfiles.findForState,
    resolve: PartyResolver.resolve, review: GoalService.review, beginMarketTravel: GoalExecutor.beginMarketTravel,
    announce: RecruitmentChat.maybeAnnounce
};

async function run() {
    const party = { partyId: 'market_break', leaderId: 1, memberIds: [1, 2, 3], spotId: 'cruma', stats: { formedAt: Date.now() - 700000, fightsResolved: 10 } };
    const members = [1, 2, 3].map((characterId) => ({ characterId, name: `Bot${characterId}`, level: 20, party: { partyId: party.partyId, role: characterId === 1 ? 'tank' : 'dps' }, stats: {}, vitals: {} }));
    const savedParties = [];
    const departed = [];
    LifeState.statesForParty = () => Promise.resolve(members);
    LifeState.applyResolve = (state) => Promise.resolve(state);
    SpotProfiles.findForState = () => ({ id: 'cruma', name: 'Cruma Tower', route: {}, avgLevel: 20, rewards: {} });
    PartyResolver.resolve = () => ({ memberResults: members.map((state) => ({ state, result: { materialize: {}, patch: {}, nextResolveAt: 1 } })), partyPatch: { cohesion: .7, risk: .2, stats: {} }, events: [], nextResolveAt: 2, debug: {} });
    GoalService.review = (state) => Promise.resolve({ current: state.characterId === 3 ? { type: 'upgrade_gear', plan: { expectedBenefit: 'market_search_for_gear' } } : null });
    GoalExecutor.beginMarketTravel = (state, goal) => goal ? { ...state, activity: 'traveling' } : null;
    LifeState.leaveParty = (state) => { departed.push(state.characterId); return Promise.resolve({ ...state, party: { ...state.party, partyId: null } }); };
    PartyState.createOrUpdate = (next) => { savedParties.push(next); return Promise.resolve(next); };
    RecruitmentChat.maybeAnnounce = (state) => ({ party: state, announced: false });

    const result = await PopulationService.resolveBackgroundParty(party);
    assert.strictEqual(result.ok, true, result.reason);
    assert.deepStrictEqual(departed, [3]);
    assert.deepStrictEqual(savedParties.at(-1).memberIds, [1, 2]);
    console.log('Bot party market break checks passed');
}

run().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => Object.assign(LifeState, { statesForParty: originals.statesForParty, applyResolve: originals.applyResolve, leaveParty: originals.leaveParty }) && Object.assign(PartyState, { createOrUpdate: originals.createOrUpdate }) && Object.assign(SpotProfiles, { findForState: originals.findForState }) && Object.assign(PartyResolver, { resolve: originals.resolve }) && Object.assign(GoalService, { review: originals.review }) && Object.assign(GoalExecutor, { beginMarketTravel: originals.beginMarketTravel }) && Object.assign(RecruitmentChat, { maybeAnnounce: originals.announce }));
