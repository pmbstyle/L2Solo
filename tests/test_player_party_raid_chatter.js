const assert = require('assert');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Chatter = invoke('GameServer/Bot/AI/PlayerPartyRaidChatter');
const Safety = invoke('GameServer/Bot/AI/BotRaidSafety');
const Chat = invoke('GameServer/Bot/AI/BotPartyChat');
const Manager = invoke('GameServer/Bot/BotManager');
const Threats = invoke('GameServer/Bot/AI/BotPvpThreats');

function actor(id, classId) {
    const value = { id, classId, hp: 1000, mp: 1000, dead: false, online: true, x: 0, destId: 0,
        fetchId: () => id, fetchClassId: () => classId, fetchLevel: () => 40,
        fetchHp: () => value.hp, fetchMaxHp: () => 1000,
        fetchMp: () => value.mp, fetchMaxMp: () => 1000,
        fetchLocX: () => value.x, fetchLocY: () => 0, fetchLocZ: () => 0,
        fetchIsOnline: () => value.online, isDead: () => value.dead,
        fetchDestId: () => value.destId,
        state: { fetchDead: () => value.dead, fetchHits: () => true, fetchCasts: () => true },
        moveTo() { throw Error('Speech must not move an actor'); },
        select() { throw Error('Speech must not change the combat target'); }
    };
    return value;
}
const messages = [];
let current;
function fixture() {
    const owner = { actor: actor(1, 12) };
    const companion = (id, classId) => ({ actor: actor(id, classId), partyCompanion: true, followPlayerSession: owner });
    const tank = companion(2, 5), damage = companion(3, 1), healer = companion(4, 15);
    const boss = actor(900, 0);
    boss.destId = tank.actor.fetchId();
    boss.model = { raidAttackers: new Set([tank.actor.fetchId(), damage.actor.fetchId()]) };
    const members = [owner, tank, damage, healer];
    owner.partyRaidEngagement = { bossId: 900, mainTankId: 2, phase: 'combat', selectedAt: 100000 };
    messages.length = 0;
    current = { owner, tank, damage, healer, boss, members, now: 100000,
        tick(at = current.now) { current.now = at; return Chatter.tick(owner, at); } };
    return current;
}
const originals = [Safety.playerPartySessions, Safety.raidBossByObjectId, Manager.botPartySay, Threats.context, Math.random];
try {
    Safety.playerPartySessions = owner => current.members.filter(member => member === owner || !member.actor.dead);
    Safety.raidBossByObjectId = () => current.boss;
    Manager.botPartySay = (speaker, text) => { messages.push({ speaker, text }); return true; };
    Threats.context = member => ({ threats: member.pvp ? [{}] : [] });
    Math.random = () => 0;

    {
        const f = fixture();
        f.owner.partyRaidEngagement.phase = 'opening';
        f.tick(); f.tick(200000);
        assert.equal(messages.length, 0, 'selection and preparation are not a boss fight');
    }
    {
        const f = fixture();
        assert.equal(f.tick(), false);
        assert.equal(f.tick(108000), true);
        assert.equal(messages[0].speaker, f.healer, 'mana reassurance comes from the actual healer');
        assert.match(messages[0].text, /mana/i);
        for (let i = 0; i < 100; i++) f.tick(108000 + i);
        assert.equal(messages.length, 1, 'more bot ticks cannot buy more party messages');
        f.tick(132999);
        assert.equal(messages.length, 1, 'the raid has a shared cooldown across different speakers');
        f.tick(134000);
        assert.equal(messages[1].speaker, f.tank, 'only the elected bot tank says it holds the boss');
        assert.equal(f.tank.actor.destId, 0, 'chat leaves the native target untouched');
        assert.equal(f.tank.actor.state.fetchHits(), true);
        assert.equal(f.tank.actor.state.fetchCasts(), true);
    }
    {
        const f = fixture();
        f.healer.actor.mp = 400;
        f.boss.destId = f.damage.actor.fetchId();
        f.tick(); f.tick(108000);
        assert.equal(messages.length, 0, 'a tank losing aggro cannot claim to hold the boss');
        f.boss.destId = f.tank.actor.fetchId();
        f.tank.actor.hp = 400;
        f.tick(109000);
        assert.equal(messages.length, 0, 'a struggling tank does not give a false reassurance');
        f.tank.actor.hp = 1000;
        f.tick(110000);
        assert.equal(messages[0].speaker, f.tank);
    }
    {
        const f = fixture();
        f.healer.actor.mp = 200;
        f.tick(); f.tick(108000);
        assert.equal(messages[0].speaker, f.healer);
        assert.match(messages[0].text, /low|not much/i, 'a low-mana healer must not claim to have plenty');
    }
    {
        const f = fixture();
        f.boss.hp = 740;
        f.tick(); f.tick(108000);
        assert.match(messages[0].text, /74%/);
        assert.equal(messages[0].speaker, f.damage);
        f.boss.hp = 80;
        f.tick(133000);
        assert.match(messages[1].text, /8%/, 'a fast fight reports current HP, not a backlog of skipped milestones');
        f.boss.hp = 20;
        f.tick(158000);
        assert.match(messages[2].text, /2%/);
        f.boss.hp = 400;
        f.tick(183000);
        assert(!messages.at(-1).text.includes('40%'), 'boss regeneration does not replay old milestones');
        f.boss.hp = 20;
        f.tick(208000);
        assert.equal(messages.filter(message => message.text.includes('2%')).length, 1,
            'crossing the same HP milestone twice must not repeat the encouragement');
    }
    {
        const f = fixture();
        f.tick();
        Chat.announce(f.tank, { priority: 'critical', key: 'test:danger', text: 'Add on the healer!', now: 108000 });
        f.tick(108000);
        assert.equal(messages.length, 1, 'a raid status must yield to a recent real warning');
        f.tick(123000);
        assert.equal(messages.length, 2);
        Chat.announce(f.damage, { priority: 'critical', key: 'test:danger:2', text: 'Need a heal!', now: 123001 });
        assert.equal(messages.length, 3, 'ambient raid chatter cannot block an urgent warning');
    }
    {
        const f = fixture();
        f.tick();
        f.tank.actor.hp = 300;
        f.tick(108000);
        assert.equal(messages.length, 0, 'urgent healing takes precedence over banter');
        f.tank.actor.hp = 1000; f.damage.pvp = true;
        f.tick(109000);
        assert.equal(messages.length, 0, 'party PvP interrupts raid banter');
        f.damage.pvp = false; f.healer.actor.dead = true;
        f.tick(110000);
        assert.equal(messages[0].speaker, f.tank, 'a dead healer cannot speak');
    }
    {
        const f = fixture();
        f.tick(); f.boss.hp = 100;
        f.tick(108000);
        f.boss.hp = 0; f.boss.dead = true;
        f.owner.partyRaidEngagement = undefined; // Combat cleanup may run before the next chat observer.
        f.tick(109000);
        assert.equal(messages.length, 1, 'victory respects recent party speech');
        f.tick(115000);
        assert.equal(messages.length, 2, 'a confirmed boss death still celebrates after raid state cleanup');
        const first = messages[1].speaker;
        f.tick(122000);
        assert.equal(messages.length, 2, 'the victory reply waits its turn');
        f.tick(123000);
        assert.equal(messages.length, 3);
        assert.notEqual(messages[2].speaker, first, 'another bot answers the celebration');
        for (const now of [124000, 150000, 200000]) f.tick(now);
        assert.equal(messages.length, 3, 'victory is a bounded two-line exchange');
    }
    {
        const f = fixture();
        f.tick(); f.tank.actor.dead = true; f.boss.hp = 80;
        f.tick(108000);
        assert.equal(messages.length, 0, 'tank death stops encouragement even before the combat adapter marks retreat');
    }
    {
        const f = fixture();
        f.tick(); f.owner.partyRaidEngagement.phase = 'retreat';
        f.tick(101000);
        f.boss.dead = true; f.owner.partyRaidEngagement = undefined;
        f.tick(102000);
        assert.equal(messages.length, 0, 'a failed raid does not celebrate someone else finishing the boss');
    }
    {
        const f = fixture();
        f.boss.dead = true;
        f.tick();
        assert.equal(messages.length, 1, 'a very short raid can celebrate before its first ambient check');
        assert.match(messages[0].text, /boss down|boss is down|we did it|there it goes/i);
    }
    {
        const f = fixture();
        f.tick(); f.boss.model.raidAttackers = new Set([999]); f.boss.dead = true;
        f.tick(101000);
        assert.equal(messages.length, 0, 'merely selecting a boss does not earn a victory reaction');
    }
    {
        const f = fixture();
        f.tick(); f.boss.hp = 0;
        f.tick(108000);
        assert(!messages.some(message => /boss down|boss is down|we did it|there it goes/i.test(message.text)),
            'an HP estimate is not a confirmed death');
    }
    {
        const f = fixture();
        f.tick(); f.owner.actor.online = false;
        f.tick(108000);
        assert.equal(messages.length, 0, 'offline player parties stay quiet');
        assert.equal(f.owner.playerRaidChatter, undefined);
    }
    {
        const f = fixture();
        f.tick(); f.boss.dead = true; f.tick(101000);
        f.owner.actor.x = 5000;
        f.tick(162000);
        assert.equal(f.owner.playerRaidChatter, undefined,
            'victory expires even if the player leaves before the second line');
    }
    console.log('Player party raid chatter: facts, pacing, priorities, milestones and victory checks passed');
} finally {
    [Safety.playerPartySessions, Safety.raidBossByObjectId, Manager.botPartySay, Threats.context, Math.random] = originals;
}
