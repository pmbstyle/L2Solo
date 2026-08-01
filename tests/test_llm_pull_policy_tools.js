const assert = require('assert');
require('../src/Global');

const BotManager = invoke('GameServer/Bot/BotManager');
const BotAgentTools = invoke('GameServer/Bot/AI/BotAgentTools');
const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');

function actor(id, name) {
    return {
        fetchId: () => id,
        fetchName: () => name,
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchDestId: () => 0,
        isDead: () => false,
        state: { fetchSeated: () => false, setSeated() {} },
        unselect() {}
    };
}

function decision(action, turnId, extra = {}) {
    return {
        action,
        confidence: 0.99,
        reply: '',
        targetPlayerName: '',
        spotId: '',
        buffType: '',
        reason: 'party policy test',
        turnId,
        ...extra
    };
}

const leader = { accountId: 'player_leader', actor: { ...actor(700, 'Leader'), fetchIsOnline: () => true }, dataSendToMe() {} };
const outsider = { accountId: 'player_other', actor: { ...actor(701, 'Other'), fetchIsOnline: () => true } };
const bot = {
    accountId: 'bot_policy_tools',
    plan: 'following',
    partyCompanion: true,
    followPlayerSession: leader,
    actor: actor(702, 'PolicyCompanion')
};
BotManager.sessions = [bot];

const originalRefreshPanel = PartyCompanionService.refreshPanel;
PartyCompanionService.refreshPanel = () => {};

try {
    const context = (turnId, playerSession = leader) => ({
        playerSession,
        conversationTurn: { turnId }
    });

    const assigned = BotAgentTools.execute(bot, decision('assign_puller', 'pull-1'), [], context('pull-1'));
    assert.strictEqual(assigned.applied, true);
    assert.strictEqual(PartyCompanionService.getSettings(leader).pullMode, 'bot');
    assert.strictEqual(PartyCompanionService.getSettings(leader).pullerId, 702);

    const denied = BotAgentTools.execute(bot, decision('set_pull_policy', 'pull-2', { pullMode: 'off' }), [], context('pull-2', outsider));
    assert.deepStrictEqual(denied, { applied: false, reason: 'not_authorized' });
    assert.strictEqual(PartyCompanionService.getSettings(leader).pullMode, 'bot', 'outsider must not change party policy');

    const unassigned = BotAgentTools.execute(bot, decision('unassign_puller', 'pull-3'), [], context('pull-3'));
    assert.strictEqual(unassigned.applied, true);
    assert.strictEqual(PartyCompanionService.getSettings(leader).pullMode, 'auto');
    assert.strictEqual(PartyCompanionService.getSettings(leader).pullerId, null);

    const repeatUnassign = BotAgentTools.execute(bot, decision('unassign_puller', 'pull-4'), [], context('pull-4'));
    assert.strictEqual(repeatUnassign.applied, true);
    assert.strictEqual(PartyCompanionService.getSettings(leader).pullMode, 'auto', 'unassign must not disable autonomous pulls');
    console.log('LLM pull policy tool checks passed');
} finally {
    PartyCompanionService.refreshPanel = originalRefreshPanel;
}
