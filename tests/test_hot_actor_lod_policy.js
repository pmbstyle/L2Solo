const assert = require('assert');

require('../src/Global');

const Policy = invoke('GameServer/Bot/AI/HotActorLodPolicy');
const BotAI = invoke('GameServer/Bot/BotAI');
const BotSession = invoke('GameServer/Bot/BotSession');
const World = invoke('GameServer/World/World');
const HuntingState = invoke('GameServer/Bot/AI/States/HuntingState');

function actor(id, x, options = {}) {
    return {
        fetchId: () => id,
        fetchIsOnline: () => options.online !== false,
        fetchLocX: () => x,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchDestId: () => options.destId || 0,
        state: {
            fetchHits: () => options.hits === true,
            fetchCasts: () => options.casts === true,
            fetchCombats: () => options.combat === true,
            fetchDead: () => options.dead === true
        }
    };
}

function botSession(id = 2001, x = 0, options = {}) {
    return {
        accountId: `bot_${id}`,
        actor: actor(id, x, options),
        aiActive: true,
        ...options.session
    };
}

function playerSession(id = 1001, x = 0, options = {}) {
    return {
        accountId: `player_${id}`,
        actor: actor(id, x, options)
    };
}

const player = playerSession(1001, 0);
const near = botSession(2001, 3500);
assert.strictEqual(Policy.evaluate(near, [player], 1000).tier, 'full', '3500 is the inclusive full-quality boundary');
assert.strictEqual(Policy.nextTickDelay(near, Policy.evaluate(near, [player], 1000), () => 0), 3000, 'near ambient bots retain the established full-quality decision cadence');

near.actor = actor(2001, 3900);
assert.strictEqual(Policy.evaluate(near, [player], 2000).tier, 'full', 'full tier must retain the 500-unit distance hysteresis');
near.actor = actor(2001, 4001);
assert.strictEqual(Policy.evaluate(near, [player], 3000).tier, 'visible', 'distance hysteresis must release outside 4000');

const visible = botSession(2002, 6000);
const visibleContext = Policy.evaluate(visible, [player], 1000);
assert.strictEqual(visibleContext.tier, 'visible', '6000 remains server-visible at reduced decision quality');
assert.strictEqual(Policy.nextTickDelay(visible, visibleContext), 7000, 'far-visible AI uses the bounded lower cadence');
visible.actor = actor(2002, 6001);
assert.strictEqual(Policy.evaluate(visible, [player], 2000).tier, 'preload', 'outside server visibility is preload-only');
assert.strictEqual(Policy.nextTickDelay(visible, { tier: 'preload' }), 30000, 'outer preload remains lightweight');

const companion = botSession(2003, 9000, { session: { partyCompanion: true, followPlayerSession: player } });
const companionContext = Policy.evaluate(companion, [player], 1000);
assert.strictEqual(companionContext.tier, 'full', 'party companions always receive full quality');
assert.strictEqual(Policy.nextTickDelay(companion, companionContext, () => 0), 1000, 'party companions keep the fast player hot path');

const selected = botSession(2004, 5500);
const selectingPlayer = playerSession(1002, 0, { destId: 2004 });
assert.strictEqual(Policy.evaluate(selected, [selectingPlayer], 1000).tier, 'full', 'a player selecting a visible bot promotes it immediately');
selectingPlayer.actor = actor(1002, 0);
assert.strictEqual(Policy.evaluate(selected, [selectingPlayer], 8999).tier, 'full', 'promotion remains full during the hysteresis hold');
assert.strictEqual(Policy.evaluate(selected, [selectingPlayer], 9001).tier, 'visible', 'promotion demotes after the hold when no interaction remains');

const fighting = botSession(2005, 5000, { hits: true });
assert.strictEqual(Policy.evaluate(fighting, [player], 1000).tier, 'full', 'visible combat cannot be degraded to far-visible thinking');

const targetingPlayer = botSession(2006, 5500, { session: { currentTargetId: 1001 } });
assert.strictEqual(Policy.evaluate(targetingPlayer, [player], 1000).tier, 'full', 'a bot attacking or chasing a real player is promoted');

const statusBot = botSession(2007, 5000);
const statusContext = Policy.evaluate(statusBot, [player], 1000);
assert.strictEqual(Policy.shouldRefreshStatus(statusBot, statusContext, 1000), true);
statusBot.botStatus = { available: true };
Policy.recordStatusRefresh(statusBot, 2, 1000);
assert.strictEqual(Policy.shouldRefreshStatus(statusBot, statusContext, 14999), false, 'far-visible status work is coalesced');
assert.strictEqual(Policy.shouldRefreshStatus(statusBot, statusContext, 16000), true, 'coalesced status eventually refreshes');
assert.strictEqual(Policy.budgetExceeded(statusContext, 1000, 1006), true, 'far-visible work stops at its per-tick decision budget');

const scanBot = actor(2010, 0);
const denseCandidates = Array.from({ length: 100 }, (_, index) => actor(4000 + index, 100 - index));
assert.strictEqual(HuntingState.limitTargetCandidates({ hotActorLod: { tier: 'visible' } }, scanBot, denseCandidates).length, 32, 'far-visible target scoring has a hard candidate budget');
assert.strictEqual(HuntingState.limitTargetCandidates({ hotActorLod: { tier: 'full' } }, scanBot, denseCandidates).length, 96, 'near target selection keeps a high but finite candidate budget');
const claimOwner = botSession(2050, 0, { session: { plan: 'hunting', currentTargetId: 4567 } });
assert.deepStrictEqual([...HuntingState.claimedTargetIds(scanBot.session || {}, [claimOwner])], [4567], 'one pass builds the target claim set without rescanning every bot per NPC');

const population = Array.from({ length: 300 }, (_, index) => botSession(5000 + index, 1000 + (index % 3) * 3000));
const tierCounts = population.reduce((counts, session) => {
    const tier = Policy.evaluate(session, [player], 20000).tier;
    counts[tier] += 1;
    return counts;
}, { full: 0, visible: 0, preload: 0 });
assert.deepStrictEqual(tierCounts, { full: 100, visible: 100, preload: 100 }, 'large hot populations split deterministically across bounded LOD tiers');

let urgentWakeups = 0;
const originalWakeup = BotAI.wakeup;
try {
    BotAI.wakeup = (session, options) => {
        urgentWakeups += 1;
        assert.strictEqual(session, selected);
        assert.strictEqual(options?.urgent, true);
    };
    assert.strictEqual(BotAI.promoteForPlayerInteraction(selected, 'player_selected', player), true);
    assert.strictEqual(urgentWakeups, 1, 'player interaction must event-wake the bot instead of waiting for a scan');
} finally {
    BotAI.wakeup = originalWakeup;
}

const originalUsers = World.user;
try {
    let playerPackets = 0;
    let botPackets = 0;
    const source = new BotSession('bot_packet_source');
    source.actor = actor(3001, 0);
    const realRecipient = playerSession(1100, 100);
    realRecipient.socket = { write: () => { playerPackets += 1; } };
    const botRecipient = botSession(3100, 100);
    botRecipient.socket = { write: () => { botPackets += 1; } };
    World.user = { sessions: [realRecipient, botRecipient], revision: 1 };
    const npcInfo = Buffer.alloc(5);
    npcInfo[0] = 0x16;
    npcInfo.writeInt32LE(987654, 1);
    source.dataSendToOthers(npcInfo, source.actor);
    assert.strictEqual(playerPackets, 1, 'visible real clients still receive authoritative bot packets');
    assert.strictEqual(botPackets, 0, 'server-side bots do not consume pointless packet broadcasts');
    assert.strictEqual(realRecipient.knownNpcIds.has(987654), true, 'real-client known-object tracking remains intact');
} finally {
    World.user = originalUsers;
}

console.log('Hot actor LOD policy checks passed');
