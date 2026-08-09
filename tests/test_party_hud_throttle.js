const assert = require('assert');

require('../src/Global');

const BotManager = invoke('GameServer/Bot/BotManager');
const BotAI = invoke('GameServer/Bot/BotAI');
const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
const CompanionControl = invoke('GameServer/World/Generics/NpcBypasses/CompanionControl');

function actor(id, name) {
    return {
        locX: 0,
        fetchId: () => id,
        fetchName: () => name,
        fetchCp: () => 0,
        fetchMaxCp: () => 0,
        fetchLevel: () => 20,
        fetchClassId: () => 0,
        fetchLocX() { return this.locX; },
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchIsOnline: () => true,
        hp: 100,
        mp: 100,
        fetchHp() { return this.hp; },
        fetchMaxHp: () => 100,
        fetchMp() { return this.mp; },
        fetchMaxMp: () => 100,
        setHp(value) { this.hp = value; },
        setMp(value) { this.mp = value; },
        state: {
            seated: false,
            fetchSeated() { return this.seated; },
            setSeated(value) { this.seated = value; },
            fetchDead: () => false,
            fetchTowards: () => false,
            fetchHits: () => false,
            fetchCasts: () => false,
            fetchPickinUp: () => false
        },
        automation: { stopReplenish() {} },
        unselect() {}
    };
}

const originalBotSessions = BotManager.sessions;
const originalWakeup = BotAI.wakeup;
const originalNow = Date.now;
const originalRender = CompanionControl.render;
try {
    let now = 10000;
    Date.now = () => now;
    CompanionControl.render = () => {};
    const packets = [];
    const leaderSession = {
        actor: actor(1, 'leader'),
        dataSendToMe(packet) { packets.push(packet); }
    };
    const companion = actor(2, 'companion');
    const companionSession = {
        actor: companion,
        partyCompanion: true,
        followPlayerSession: leaderSession
    };
    BotManager.sessions = [companionSession];

    PartyCompanionService.updateMember(companionSession);
    assert.strictEqual(packets.filter((packet) => packet[0] === 0x52).length, 1, 'the HUD should receive an initial vitals update');
    assert.strictEqual(packets.filter((packet) => packet[0] === 0xee).length, 0, 'an ordinary AI tick must not resend PartySpelled');

    PartyCompanionService.updateMember(companionSession);
    assert.strictEqual(packets.filter((packet) => packet[0] === 0x52).length, 1, 'repeated AI ticks must not flood PartySmallWindowUpdate');

    companion.locX = 200;
    PartyCompanionService.updateMember(companionSession);
    assert.strictEqual(packets.filter((packet) => packet[0] === 0xa7).length, 2, 'a material movement should still refresh party positions');

    now += 1000;
    PartyCompanionService.updateMember(companionSession);
    assert.strictEqual(packets.filter((packet) => packet[0] === 0x52).length, 2, 'HUD vitals should refresh after the bounded interval');

    const joiningBot = actor(3, 'joining');
    let abortedCasts = 0;
    let clearedAttackTimers = 0;
    let resetAttackQueues = 0;
    let abortedAutomation = 0;
    let urgentWakeups = 0;
    joiningBot.hp = 15;
    joiningBot.mp = 20;
    joiningBot.state.seated = true;
    joiningBot.attack = {
        abortCast() { abortedCasts += 1; },
        clearTimers() { clearedAttackTimers += 1; },
        resetQueuedEvent() { resetAttackQueues += 1; }
    };
    joiningBot.automation.abortAll = () => { abortedAutomation += 1; };
    const joiningSession = {
        actor: joiningBot,
        plan: 'resting',
        dataSendToMeAndOthers() {}
    };
    BotAI.wakeup = (session, options) => {
        assert.strictEqual(session, joiningSession, 'party attachment should wake the joining bot session');
        assert.deepStrictEqual(options, { urgent: true }, 'party attachment should bypass a stale background AI timeout');
        urgentWakeups += 1;
    };
    BotManager.sessions = [companionSession, joiningSession];
    assert.strictEqual(PartyCompanionService.attach(leaderSession, joiningSession), true, 'the invited bot should join the party');
    assert.strictEqual(abortedCasts, 1, 'joining should abort an old cast before changing the bot to party follow');
    assert.strictEqual(clearedAttackTimers, 1, 'joining should clear old attack callbacks before a distant catch-up');
    assert.strictEqual(resetAttackQueues, 1, 'joining should discard queued actions from the bot previous combat');
    assert.strictEqual(abortedAutomation, 1, 'joining should abort movement from the bot previous solo plan');
    assert.strictEqual(urgentWakeups, 1, 'joining should start party follow without waiting for the previous AI schedule');
    assert.strictEqual(joiningBot.fetchHp(), joiningBot.fetchMaxHp(), 'joining companion should restore HP immediately');
    assert.strictEqual(joiningBot.fetchMp(), joiningBot.fetchMaxMp(), 'joining companion should restore MP immediately');
    assert.strictEqual(joiningBot.state.fetchSeated(), false, 'joining companion should stand after the instant recovery');
    assert.strictEqual(joiningSession.plan, 'following', 'joining companion should return to party follow after recovery');

    console.info('party HUD throttling tests passed');
} finally {
    BotManager.sessions = originalBotSessions;
    BotAI.wakeup = originalWakeup;
    Date.now = originalNow;
    CompanionControl.render = originalRender;
}
