const assert = require('assert');
require('../src/Global');
const World = invoke('GameServer/World/World');
const Control = invoke('GameServer/Npc/SummonControl');
const Attack = invoke('GameServer/Actor/Attack');
const Formulas = invoke('GameServer/Formulas');
const Response = invoke('GameServer/Network/Response');
const Actors = invoke(path.actor), Npcs = invoke(path.npc);
const original = { user: World.user, npc: World.fetchNpc, fetchUser: World.fetchUser,
    hit: Actors.receivedHit, npcHit: Npcs.receivedHit, chance: Formulas.calcHitChance,
    prepare: Attack.prototype.prepareNpcMeleeHit, attack: Response.attack, peace: utils.isInPeaceZone };
function actor(id, x = 0) {
    const a = { id, x, flag: 1, effects: {}, fetchId: () => id, fetchLocX() { return this.x; },
        fetchLocY: () => 0, fetchLocZ: () => 0, fetchRadius: () => 8, fetchHead: () => 0,
        fetchIsOnline: () => true, fetchPvpFlag() { return this.flag; }, fetchKarma: () => 0,
        state: { fetchDead: () => false, setHits() {}, setCasts() {} }, isDead: () => false };
    a.session = { actor: a, accountId: 'player' };
    return a;
}
(async () => {
    try {
        utils.isInPeaceZone = x => x === 99999;
        const owner = actor(2000001), target = actor(2000002, 40);
        const session = owner.session;
        let rejected = 0;
        session.dataSendToMe = () => rejected++;
        session.dataSendToMeAndOthers = () => {};
        owner.dest = target.id;
        owner.fetchDestId = () => owner.dest;
        owner.select = data => { owner.dest = data.id; };
        const timers = [], moves = [], damage = [];
        const summon = Object.assign(actor(1000001), { fetchKind: () => 'Summon', fetchOwnerId: () => owner.id,
            fetchSummonSkillId: () => 1111, fetchAtkRadius: () => 40, fetchCollectiveAtkSpd: () => 333,
            timer: {}, attack: { clearTimers() {}, queueTimer(fn) { timers.push(fn); } },
            automation: { abortAll() {}, scheduleAction(_s, _a, _t, _r, callback) { moves.push(callback); } } });
        owner.summon = summon;
        World.user = { sessions: [session, target.session] };
        World.fetchNpc = () => Promise.reject(new Error('not an NPC'));
        World.fetchUser = id => Promise.resolve(World.user.sessions.find(s => s.actor.id === id)?.actor);
        Actors.receivedHit = (_s, victim, amount, options) => damage.push({ victim, amount, source: options.source });
        Npcs.receivedHit = () => { throw new Error('PvP damage must not use the NPC victim pipeline'); };
        Formulas.calcHitChance = () => true;
        Attack.prototype.prepareNpcMeleeHit = () => ({ damage: 10, flags: 0 });
        Response.attack = () => Buffer.alloc(0);
        Control.attack(session, owner, summon);
        await new Promise(setImmediate);
        assert.strictEqual(rejected, 0, 'the real attack command accepts a flagged character outside an arena');
        assert.strictEqual(moves.length, 1);
        moves.shift()();
        timers.shift()();
        assert.deepStrictEqual(damage, [{ victim: target, amount: 10, source: summon }]);

        timers.length = 0;
        Control.attackTick(session, summon, target);
        target.x = 1000;
        timers.shift()();
        assert.strictEqual(damage.length, 1, 'a target escaping before impact cannot take remote melee damage');
        timers.shift()();
        assert.strictEqual(moves.length, 1, 'the next swing must chase the moving target');
        target.x = 40;
        moves.shift()();
        target.flag = 0;
        timers.shift()();
        assert.strictEqual(damage.length, 1, 'a flag expiring in flight revokes the attack');
        assert(!Control.isValidEnemyTarget(owner, target));
        session.accountId = 'bot_summoner';
        session.pvpRevenge = { target, initiator: session, expiresAt: Date.now() + 30000 };
        assert(Control.isValidEnemyTarget(owner, target), 'an explicit bot revenge target is permitted');
        session.pvpDefense = { action: 'fight' };
        target.effects.sleep = { key: 'sleep', type: 'debuff', expiresAt: Date.now() + 10000 };
        assert(!Control.isValidEnemyTarget(owner, target), 'the summon respects its party control');
        target.effects = {};
        assert(!new Attack().blockedPvpDefense({ actor: summon }, summon, target,
            { fetchTargetKind: () => 'enemy' }));
        target.x = 99999;
        assert(new Attack().blockedPvpDefense({ actor: summon }, summon, target,
            { fetchTargetKind: () => 'enemy' }), 'summon skill landing rechecks the owner PvP permission');
        target.x = 40;
        session.coldLifeState = target.session.coldLifeState = { party: { partyId: 'joined' } };
        assert(!Control.isValidEnemyTarget(owner, target), 'party changes revoke a summon attack');
        delete session.coldLifeState; delete target.session.coldLifeState;
        session.pvpRevenge.expiresAt = 0;
        assert(!Control.isValidEnemyTarget(owner, target), 'expired revenge does not authorize PK');
        const nextTarget = actor(2000003, 40);
        World.user.sessions.push(nextTarget.session);
        owner.fetchClassId = () => 14;
        owner.skillset = { skills: [] };
        owner.dest = nextTarget.id;
        summon.controlMode = 'attack'; summon.attackTargetId = target.id;
        invoke('GameServer/Bot/AI/SummonerTactics').combatAction(session, owner, nextTarget, {});
        await new Promise(setImmediate);
        assert.strictEqual(summon.attackTargetId, nextTarget.id, 'changing the owner focus must also retarget the attacking summon');
        invoke('GameServer/Bot/AI/BotPvpTactics').followSummon(session, owner);
        assert.strictEqual(summon.controlMode, 'follow', 'ending PvP recalls the summon instead of leaving its attack loop behind');
        assert.strictEqual(summon.attackTargetId, undefined);
        clearInterval(summon.timer.followOwner);
        console.log('Native summon PvP and range checks passed');
    } finally {
        World.user = original.user; World.fetchNpc = original.npc; World.fetchUser = original.fetchUser;
        Actors.receivedHit = original.hit; Npcs.receivedHit = original.npcHit;
        Formulas.calcHitChance = original.chance; Attack.prototype.prepareNpcMeleeHit = original.prepare;
        Response.attack = original.attack; utils.isInPeaceZone = original.peace;
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
