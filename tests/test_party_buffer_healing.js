const assert = require('node:assert/strict');
require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const World = invoke('GameServer/World/World');
const Following = invoke('GameServer/Bot/AI/States/FollowingState');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const Effects = invoke('GameServer/Effects/EffectStore');
const Skill = invoke('GameServer/Model/Skill');
const { registerSessions } = require('./helpers/worldSessions');

DataCache.init();

let nextId = 2300000;
function actor(classId, hp = 100, x = 0) {
    return {
        id: nextId++, classId, hp, mp: 380, maxMp: 1000, x, online: true, dead: false, effects: {}, moves: [],
        fetchId() { return this.id; }, fetchName() { return `Member${this.id}`; },
        fetchClassId() { return this.classId; }, fetchLevel: () => 61,
        fetchHp() { return this.hp; }, fetchMaxHp: () => 100,
        fetchMp() { return this.mp; }, fetchMaxMp() { return this.maxMp; },
        fetchLocX() { return this.x; }, fetchLocY: () => 0, fetchLocZ: () => 0,
        fetchIsOnline() { return this.online; }, isDead() { return this.dead; },
        fetchKarma: () => 0, fetchPvpFlag: () => 0,
        select(data) { this.targetId = data.id; }, unselect() { this.targetId = null; },
        moveTo(data) { this.moves.push(data); this.state.towards = 'move'; },
        state: {
            towards: false, casts: false, hits: false,
            fetchDead: () => false, fetchSeated: () => false,
            fetchTowards() { return this.towards; },
            fetchCasts() { return this.casts; }, fetchHits() { return this.hits; },
            setHits(value) { this.hits = value; }
        },
        skillset: { skills: [], fetchSkill(id) { return this.skills.find(skill => skill.fetchSelfId() === id); } },
        automation: { abortAll(bot) { bot.state.towards = false; } },
        attack: { clearTimers() {}, resetQueuedEvent() {} }
    };
}

function session(member, leader = null) {
    const result = {
        accountId: `${leader ? 'bot' : 'player'}_${member.id}`, actor: member,
        plan: 'following', partyCompanion: !!leader, followPlayerSession: leader,
        dataSendToMe() {}, dataSendToOthers() {}, dataSendToMeAndOthers() {}
    };
    member.session = result;
    member.state.fetchDead = () => member.dead;
    return result;
}

function learn(member, id, level = 1) {
    const template = DataCache.skills.find(skill => skill.selfId === id);
    const data = template?.levels.find(skill => skill.level === level);
    assert(data, `authored skill ${id}/${level} must exist`);
    const skill = new Skill({ ...utils.crushOb(template), ...data });
    member.skillset.skills.push(skill);
    return skill;
}

function publish(members) {
    for (const member of [...(World.user?.sessions || [])]) World.removeUser(member);
    registerSessions(members);
}

function fixture(classId = 17) {
    const leader = session(actor(8));
    const provider = session(actor(classId, 100, 80), leader);
    const tank = session(actor(33, 30, 120), leader);
    const members = [leader, provider, tank];
    publish(members);
    return { leader, provider, tank, members };
}

function tick(f, extra = {}) {
    const casts = [];
    const bot = f.provider.actor;
    const context = {
        session: f.provider, bot, playerSession: f.leader, player: f.leader.actor,
        role: Roles.inferRole(bot), pulling: {}, partyRaid: null, partyThreat: null,
        leaderTargetId: null, personalSupportThreat: null, impairments: {},
        botVitals: { hpRatio: bot.hp / 100, mpRatio: bot.mp / bot.maxMp },
        partyVitals: { hpRatio: f.tank.actor.hp / 100 },
        currentPartyAggroMonsters: () => [], acted: false, keepRoleDecision: false,
        Generics: { skillExec(_session, _actor, data) { casts.push(data); } }, ...extra
    };
    Following.tickSupportAndHealing(context);
    return casts;
}

const original = { users: World.user, npcs: World.fetchNpcsInRadius };
try {
    World.fetchNpcsInRadius = () => [];
    let f = fixture();
    learn(f.provider.actor, 1011, 18);
    learn(f.provider.actor, 1015, 15);
    learn(f.provider.actor, 1040, 3);
    assert.deepEqual(tick(f), [{ id: f.tank.actor.id, selfId: 1015, ctrl: false }],
        'a Prophet must rescue the only wounded tank before buffing when no healer is present');
    assert.equal(f.provider.roleDecision.role, 'buffer', 'backup healing must retain the buffer role');
    f.tank.actor.hp = 60;
    assert.deepEqual(tick(f), [{ id: f.tank.actor.id, selfId: 1011, ctrl: false }],
        'routine recovery uses the Prophet\'s learned Heal');
    f.tank.actor.hp = 30;
    assert.deepEqual(tick(f, { impairments: { silenced: true } }), [], 'silence must still prevent backup healing');
    f.provider.actor.mp = 1;
    assert.deepEqual(tick(f), [], 'backup healing must require real MP');
    f.provider.actor.mp = 380;
    f.provider.actor.canUseSkill = () => false;
    assert.deepEqual(tick(f), [], 'skill reuse must still prevent backup healing');
    delete f.provider.actor.canUseSkill;

    const healer = session(actor(15, 100, 100), f.leader);
    publish([...f.members, healer]);
    assert(!tick(f).some(cast => [1011, 1015].includes(cast.selfId)),
        'a living healer reserves party healing for the healer role');
    healer.actor.dead = true;
    assert.equal(tick(f)[0]?.selfId, 1015, 'a dead healer cannot prevent backup healing');
    healer.actor.dead = false;
    healer.actor.online = false;
    assert.equal(tick(f)[0]?.selfId, 1015, 'an offline healer cannot prevent backup healing');
    publish(f.members);
    f.leader.actor.classId = 16;
    assert(!tick(f).some(cast => [1011, 1015].includes(cast.selfId)),
        'a human party leader with a healer class also prevents backup healing');

    f = fixture();
    learn(f.provider.actor, 1011, 18);
    f.tank.actor.x = 800;
    assert.deepEqual(tick(f), [], 'a distant patient requires a safe approach before healing');
    assert.equal(f.provider.pendingSupportApproach.kind, 'emergency_heal');
    assert(f.provider.actor.moves.length > 0);
    f.provider.actor.x = 250;
    const approachedCasts = [];
    assert.equal(Following.tickPendingSupport({ session: f.provider, bot: f.provider.actor,
        playerSession: f.leader, pulling: {}, partyThreat: null,
        Generics: { skillExec(_session, _actor, data) { approachedCasts.push(data); } } }), true);
    assert.deepEqual(approachedCasts, [{ id: f.tank.actor.id, selfId: 1011, ctrl: false }],
        'a backup healer must finish the heal when its safe approach reaches casting range');
    f.provider.actor.x = 80;
    tick(f);
    const joiningHealer = session(actor(15), f.leader);
    publish([...f.members, joiningHealer]);
    Following.tickPendingSupport({ session: f.provider, bot: f.provider.actor,
        playerSession: f.leader, pulling: {}, partyThreat: null,
        Generics: { skillExec() { assert.fail('a joining healer must cancel the pending backup heal'); } } });
    assert.equal(f.provider.pendingSupportApproach, undefined);

    f = fixture(52);
    const chant = learn(f.provider.actor, 1229, 11);
    assert.deepEqual(tick(f), [{ id: f.tank.actor.id, selfId: 1229, ctrl: false }],
        'a Warcryer uses Chant of Life even when only one party member is wounded');
    const semantic = chant.fetchSemantic();
    Effects.apply(f.tank.actor, { id: 1229, key: semantic.effect, level: 11, hot: semantic.hot, durationMs: 15000 });
    assert.deepEqual(tick(f), [], 'an active Chant of Life must not be recast every tick');
    learn(f.provider.actor, 1007, 1);
    f.provider.pendingSupportApproach = { targetId: f.tank.actor.id, skillId: 1007, ctrl: false,
        kind: 'buff:chant_of_battle', startedAt: Date.now(), lastMoveAt: 0 };
    const pendingBuffCasts = [];
    assert.equal(Following.tickPendingSupport({ session: f.provider, bot: f.provider.actor,
        playerSession: f.leader, pulling: {}, partyThreat: null,
        Generics: { skillExec(_session, _actor, data) { pendingBuffCasts.push(data); } } }), true,
        'an already running HoT must not keep aborting an unrelated pending support cast');
    assert.equal(pendingBuffCasts[0]?.selfId, 1007);
    f.provider.actor.skillset.skills = [chant];
    f.tank.actor.effects = {};
    f.provider.actor.hp = 40;
    Effects.apply(f.provider.actor, { id: 1229, key: semantic.effect, level: 11, hot: semantic.hot, durationMs: 15000 });
    f.tank.actor.hp = 100;
    assert.deepEqual(tick(f), [], 'self-preservation must also respect an already active healing effect');

    f = fixture(51);
    learn(f.provider.actor, 1256, 13);
    f.provider.actor.fetchClanId = () => 10;
    f.tank.actor.fetchClanId = () => 20;
    assert.deepEqual(tick(f), [], 'Paagrio healing cannot treat an unrelated party member as a clan ally');
    f.tank.actor.fetchClanId = () => 10;
    assert.deepEqual(tick(f), [{ id: f.tank.actor.id, selfId: 1256, ctrl: false }],
        'an Overlord may heal a wounded clan member when the party has no healer');
    f.tank.actor.x = 600;
    assert.deepEqual(tick(f), [], 'clan healing must approach its native aura radius before casting');
    assert.equal(f.provider.pendingSupportApproach.kind, 'emergency_heal');

    // Chant of Life and Heart of Paagrio are one C4 stack (life_force_orc):
    // a cast over a running member throws away its remaining ticks.
    const overlord = (tankHp, running = null) => {
        const o = fixture(51);
        const skills = { chant: learn(o.provider.actor, 1229, 4), heart: learn(o.provider.actor, 1256, 3) };
        o.provider.actor.fetchClanId = () => 10;
        o.tank.actor.fetchClanId = () => 10;
        o.tank.actor.hp = tankHp;
        if (running) {
            const hot = skills[running].fetchSemantic();
            Effects.apply(o.tank.actor, { id: skills[running].fetchSelfId(), key: hot.effect,
                level: skills[running].fetchLevel(), hot: hot.hot, stackFamily: hot.stackFamily,
                stackOrder: hot.stackOrder, durationMs: 15000 });
        }
        return o;
    };
    f = overlord(30);
    assert.deepEqual(tick(f), [{ id: f.tank.actor.id, selfId: 1256, ctrl: false }],
        'an Overlord opens an emergency with Heart of Paagrio');
    f = overlord(60, 'chant');
    assert.deepEqual(tick(f), [], 'a running Chant of Life is let run outside an emergency');
    f = overlord(30, 'chant');
    assert.deepEqual(tick(f), [{ id: f.tank.actor.id, selfId: 1256, ctrl: false }],
        'an emergency heal replaces a weaker running HoT');
    f = overlord(30, 'heart');
    assert.deepEqual(tick(f), [], 'Chant of Life is not cast into a stronger running Heart');
    f = overlord(30, 'chant');
    f.tank.actor.x = 600;
    assert.deepEqual(tick(f), [], 'Heart of Paagrio approaches a distant tank in an emergency');
    assert.equal(f.provider.pendingSupportApproach.kind, 'emergency_heal');
    assert.equal(f.provider.pendingSupportApproach.skillId, 1256);
    Following.tickPendingSupport({ session: f.provider, bot: f.provider.actor,
        playerSession: f.leader, pulling: {}, partyThreat: null,
        Generics: { skillExec() {} } });
    assert.equal(f.provider.pendingSupportApproach?.skillId, 1256,
        'an emergency approach over a running Chant is kept, not cancelled every tick');

    f = fixture(34);
    assert.deepEqual(tick(f), [], 'a buffer without a learned heal must never invent one');
    f = fixture(15);
    learn(f.provider.actor, 1011, 18);
    assert.equal(tick(f)[0]?.selfId, 1011, 'ordinary healer behavior remains available');
    assert.equal(invoke('Database').isReady(), false, 'support decisions must not open the live database');
    console.log('Party buffer healing, healer presence, periodic healing and native target checks passed');
} finally {
    for (const member of [...(World.user?.sessions || [])]) World.removeUser(member);
    World.user = original.users;
    World.fetchNpcsInRadius = original.npcs;
}
