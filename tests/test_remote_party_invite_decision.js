'use strict';

const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');

const World = invoke('GameServer/World/World');
const Availability = invoke('GameServer/Bot/AI/BotAvailability');
const Manager = invoke('GameServer/Bot/BotManager');
const Social = invoke('GameServer/Bot/AI/BotSocialMemory');
const Memory = invoke('GameServer/Social/InteractionMemoryRuntime');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const Party = invoke('GameServer/Bot/AI/PartyCompanionService');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Income = invoke('GameServer/Bot/Population/PartyProgressComparison');
const Merchant = invoke('GameServer/Bot/Economy/BotMerchantStoreService');
const Meetings = invoke('GameServer/AfkTrade/TradeMeetingService');
const Friends = invoke('GameServer/Bot/AI/BotFriendship');
const restores = [];
function replace(object, key, value) {
    const previous = object[key];
    restores.push(() => { object[key] = previous; });
    object[key] = value;
}
function actor(id, name) {
    return { fetchId: () => id, fetchName: () => name, fetchLevel: () => 60,
        fetchClanId: () => 0, fetchLocX: () => 100, fetchLocY: () => 200,
        fetchLocZ: () => -300, isDead: () => false };
}

async function run() {
    let hot = null, activations = 0, attachments = 0, onActivation = () => {};
    let onLookup = () => {}, onMemory = () => {};
    let memory = {}, hostile = false, ready = true;
    const reviews = [], events = [], replies = [], timers = [], packets = [];
    const leaderActor = actor(91001, 'Leader');
    const player = { actor: leaderActor, dataSendToMe: packet => packets.push(packet) };
    const state = { characterId: 91002, name: 'RemoteCompanion', level: 60,
        phase: 'cold', activity: 'hunting', spotId: 'home', stats: {},
        loc: { locX: 90000, locY: 80000, locZ: -300 }, vitals: { hp: 100 },
        persona: { primaryDrive: 'social', traits: { sociability: .8, empathy: .8, commitment: .7 } } };
    try {
        replace(Manager, 'sessions', []);
        replace(Manager, 'findSessionByName', () => hot);
        replace(Manager, 'botTell', (_bot, _player, text) => replies.push(text));
        replace(Social, 'getSnapshot', () => memory);
        replace(Social, 'recordEvent', async (leader, _bot, event, detail) => events.push({
            event, detail, playerId: leader.actor?.fetchId()
        }));
        replace(Memory, 'ensureMany', async () => { await onMemory(); });
        replace(Memory, 'assess', () => ({ ready, personal: hostile ? { trust: -10, hostility: 20 } : null }));
        replace(Life, 'findByName', async () => { await onLookup(); return state; });
        // Every camp is financially unattractive: a player invitation never
        // consults these autonomous earning forecasts.
        replace(Economy, 'stateForActor', (value, session) => ({
            ...session.coldLifeState, characterId: value.fetchId(), stats: {},
            spotId: session.currentSpot?.id
        }));
        replace(Income, 'compare', (value) => {
            reviews.push(value.spotId);
            return { accept: false, reason: 'solo_sooner' };
        });
        replace(Population, 'requestActivation', async (value, reason, options) => {
            assert.equal(value, state);
            assert.equal(reason, 'remote_invite');
            assert.equal(options.forceNearPlayer, true);
            assert.equal(options.interruptBackgroundActivity, true);
            activations++;
            hot = { actor: actor(state.characterId, state.name), accountId: 'bot_remote_companion',
                plan: 'hunting', coldLifeState: state, persona: state.persona,
                currentSpot: { id: 'destination' } };
            await onActivation();
            return { ok: true };
        });
        replace(Party, 'attach', (leader, companion, options) => {
            attachments++;
            Party.releaseCapacity(leader, options.capacityReservation);
            companion.followPlayerSession = leader;
            companion.partyCompanion = true;
            return true;
        });
        replace(global, 'setTimeout', (callback) => { timers.push(callback); return 0; });

        const reset = () => {
            hot = null; activations = 0; attachments = 0;
            memory = {}; hostile = false; ready = true; onActivation = () => {};
            onLookup = onMemory = () => {};
            player.actor = leaderActor;
            leaderActor.isDead = () => false;
            reviews.length = events.length = replies.length = timers.length = packets.length = 0;
            Party.releaseCapacity(player, state);
        };
        const invite = () => World.inviteBotByName(player, player.actor, state.name, 1, 'botparty');

        assert.equal(await invite(), true, 'an accepted remote invite must survive the change of spot during activation');
        assert.equal(activations, 1);
        assert.equal(attachments, 1);
        assert.deepEqual(reviews, [], 'player invitations never ask the autonomous economic/persona policy');
        assert.deepEqual(events.map(event => event.event), ['invite_attempt', 'party_formed']);
        timers.splice(0).forEach(callback => callback());
        assert.equal(replies.length, 1);
        assert(!replies[0].includes('get to know'), 'the delayed reply must keep the accepted decision');

        // A later hot invite follows the same rules without stored consent.
        hot.partyCompanion = false; hot.followPlayerSession = null;
        assert.equal(World.inviteBotCompanion(player, player.actor, hot, 1), true);
        assert.deepEqual(reviews, []);

        reset(); hostile = true;
        assert.equal(await invite(), false);
        assert.equal(activations, 0, 'a bot that refuses remotely must never be summoned');
        assert.equal(attachments, 0);

        for (const [reason, change] of [
            ['already_grouped', () => { hot.hotBackgroundPartyId = 'other-party'; }],
            ['relationship_hostile', () => { hostile = true; }],
            ['level_gap_too_large', () => { hot.actor.fetchLevel = () => 80; }]
        ]) {
            reset(); onActivation = change;
            assert.equal(await invite(), false, `accepted consent must still respect ${reason} after activation`);
            assert.equal(activations, 1);
            assert.equal(attachments, 0);
            assert.equal(events.at(-1).detail, reason);
            assert.equal(Party.hasCapacity(player), true, 'a failed attachment must release its reserved slot');
            player.actor.isDead = () => false;
        }

        assert.equal(Availability.evaluate(player, hot).reason,
            'level_gap_too_large');

        for (const activity of ['traveling', 'pk_hunting', 'merchant', 'resting', 'dead']) {
            reset();
            state.activity = activity;
            onActivation = () => {
                hot.actor.isDead = () => activity === 'dead';
                player.actor.isDead = () => true;
                memory = { recentlyAbandonedAt: Date.now() };
            };
            assert.equal(await invite(), true, `${activity} must not veto a player invitation`);
            assert.equal(attachments, 1);
        }
        state.activity = 'hunting';

        const materialize = () => {
            hot = { actor: actor(state.characterId, state.name), accountId: 'bot_remote_companion',
                plan: 'hunting', coldLifeState: state };
        };
        for (const afterLoadHostile of [false, true]) {
            reset(); materialize(); ready = false;
            onMemory = () => { ready = true; hostile = afterLoadHostile; };
            assert.equal(await World.inviteBotCompanion(player, player.actor, hot, 1), !afterLoadHostile,
                'an unloaded hot relationship is awaited before accepting or refusing');
            assert.equal(events.filter(e => e.event === 'invite_attempt').length, 1);
        }
        reset(); materialize(); ready = false;
        onMemory = () => { ready = true; player.actor = actor(91003, 'Replacement'); };
        assert.equal(await World.inviteBotCompanion(player, leaderActor, hot, 1), false);
        assert.equal(attachments, 0, 'a hot relationship load cannot transfer an invite to another character');
        assert.equal(events.length, 0);

        let tradeReady = true, interrupted = 0, onTrade = () => {};
        replace(Meetings, 'canJoinParty', () => tradeReady);
        replace(Meetings, 'prepareForPlayerParty', async () => {
            interrupted++; await onTrade(); tradeReady = true; return true;
        });
        for (const phase of ['hot', 'cold']) {
            reset(); tradeReady = false; interrupted = 0;
            if (phase === 'hot') materialize();
            assert.equal(await invite(), true, `${phase} player invitations interrupt personal trade`);
            assert.equal(interrupted, 1);
            assert.equal(attachments, 1);
            assert.equal(events.filter(e => e.event === 'invite_attempt').length, 1, 'trade preparation is one invitation');
        }
        reset(); tradeReady = false;
        onTrade = () => { player.actor = actor(91003, 'Replacement'); };
        assert.equal(await invite(), false);
        assert.equal(attachments, 0);
        assert.equal(Party.releaseCapacity(player, state), false, 'trade interruption releases a stale invite reservation');
        onTrade = () => {};

        replace(Friends, 'isFriend', async () => true);
        replace(Party, 'detach', () => { throw Error('friend invitation must not steal another party member'); });
        replace(Life, 'leaveParty', () => { throw Error('friend invitation must not dissolve an autonomous party'); });
        for (const phase of ['hot', 'cold']) {
            reset();
            if (phase === 'hot') { materialize(); hot.followPlayerSession = {}; hot.partyCompanion = true; }
            else state.party = { partyId: 'autonomous' };
            assert.equal(await World.inviteFriendByName(player, player.actor, state.name, 1), false);
            assert.equal(attachments, 0);
            assert.equal(events.at(-1).detail, 'already_grouped');
            state.party = null;
        }

        // Character selection reuses the connection. Pending work must not
        // transfer the old character's invitation to the replacement actor.
        for (const phase of ['lookup', 'memory', 'activation', 'same_character_relogin', 'disconnect']) {
            reset();
            let packetsAtChange;
            const changeActor = () => {
                packetsAtChange = packets.length;
                player.actor = phase === 'disconnect' ? null
                    : actor(phase === 'same_character_relogin' ? leaderActor.fetchId() : 91003, 'Replacement');
            };
            if (phase === 'lookup') onLookup = changeActor;
            else if (phase === 'memory') onMemory = changeActor;
            else onActivation = changeActor;
            assert.equal(await invite(), false, `the old invite must be cancelled during ${phase}`);
            assert.equal(activations, ['lookup', 'memory'].includes(phase) ? 0 : 1);
            assert.equal(attachments, 0, 'a replacement character must never inherit the old acceptance');
            assert.equal(events.length, 0, 'a stale invite must not alter the replacement character\'s social history');
            assert.equal(replies.length, 0);
            assert.equal(packets.length, packetsAtChange, 'old invite responses must not reach a replacement character');
            assert.equal(Party.releaseCapacity(player, state), false, 'cancellation must already have released its slot');
        }

        reset();
        let materialized;
        onActivation = () => { materialized = hot; hot = null; };
        const waiting = invite();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(timers.length, 1, 'the invite is waiting for the activated bot session');
        player.actor = actor(91003, 'Replacement');
        const packetsAtChange = packets.length;
        hot = materialized;
        timers.shift()();
        assert.equal(await waiting, false, 'a character swap while waiting for the bot session cancels the invite');
        assert.equal(attachments, 0);
        assert.equal(events.length, 0);
        assert.equal(packets.length, packetsAtChange);
        assert.equal(Party.releaseCapacity(player, state), false);
        assert.equal(World.inviteBotCompanion(player, leaderActor, hot, 1, 'invite', { forceFriend: true }), false,
            'a stale direct callback must also preserve the original inviter identity');

        reset();
        assert.equal(await invite(), true);
        player.actor = actor(91003, 'Replacement');
        timers.splice(0).forEach(callback => callback());
        assert.equal(replies.length, 0, 'a delayed joined reply belongs only to the original actor');

        reset();
        let restored = 0, packetsAtWithdrawal;
        replace(Merchant, 'needsPartyWithdrawal', () => true);
        replace(Merchant, 'withdrawForParty', async () => {
            packetsAtWithdrawal = packets.length;
            player.actor = actor(91003, 'Replacement');
            return { ok: true, withdrawn: true };
        });
        replace(Merchant, 'restoreAfterPartyFailure', async () => { restored++; });
        assert.equal(await invite(), false, 'a character swap during store withdrawal must cancel the final attachment');
        assert.equal(attachments, 0);
        assert.equal(restored, 1, 'cancellation must restore a merchant store already withdrawn for this invite');
        assert.deepEqual(events.map(event => [event.event, event.playerId]), [['invite_attempt', leaderActor.fetchId()]]);
        assert.equal(packets.length, packetsAtWithdrawal);
        assert.equal(replies.length, 0);
        assert.equal(Party.releaseCapacity(player, state), false);
    } finally {
        Party.releaseCapacity(player, state);
        restores.reverse().forEach(restore => restore());
    }
    console.log('Player party invite: no economic veto, activity interruption, live gates, actor identity and merchant rollback passed');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
