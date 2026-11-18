'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
const Lifecycle = invoke('GameServer/Bot/Population/GrandBossRaidLifecycle');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Hot = invoke('GameServer/Bot/Population/HotPartyLifecycle');
const Index = invoke('GameServer/World/RaidEntityIndex');
const World = invoke('GameServer/World/World');
const saved = [];
function replace(object, key, value) {
    const old = object[key]; saved.push(() => { object[key] = old; }); object[key] = value;
}
async function main() {
    const timers = new Map(); let serial = 0, listener, activations = 0;
    const epic = { partyId: 'grand', status: 'active', stats: { objective: { sourceKind: 'raid', npcId: 12001 } } };
    const ordinary = { partyId: 'ordinary', status: 'active', stats: { objective: { sourceKind: 'raid', npcId: 10001 } } };
    const rows = new Map([[epic.partyId, epic], [ordinary.partyId, ordinary]]);
    const boss = { fetchHp: () => 100, isDead: () => false };
    try {
        replace(global, 'setTimeout', (fn, delay) => { const timer = { id: ++serial, fn, delay, unref() {} }; timers.set(timer.id, timer); return timer; });
        replace(global, 'clearTimeout', timer => { timers.delete(timer?.id); });
        replace(Parties, 'admitted', () => [...rows.values()]);
        replace(Parties, 'find', id => rows.get(id));
        replace(Parties, 'subscribeChanges', fn => { listener = fn; return () => { listener = null; }; });
        replace(World, 'user', { sessions: [] });
        replace(Index, 'bossByTemplateId', (_world, id) => id === 12001 ? boss : null);
        replace(Hot, 'activate', async (id, reason) => {
            activations++;
            assert.equal(id, epic.partyId);
            assert.equal(reason, 'grand_boss_encounter');
            if (activations === 1) return { ok: false, reason: 'party_not_gathered' };
            epic.status = 'hot'; listener(epic);
            return { ok: true };
        });
        Lifecycle.start();
        assert.equal(timers.size, 1, 'only a grand boss roster wakes without a player');
        const fire = async () => { const timer = [...timers.values()][0]; timers.delete(timer.id); await timer.fn(); };
        await fire();
        assert.equal(timers.size, 1);
        assert.equal([...timers.values()][0].delay, 5000, 'travel/assembly failure retries');
        await fire();
        assert.equal(activations, 2);
        assert.equal(timers.size, 0);
        assert(Lifecycle.keepHot(epic), 'the real player visibility policy cannot cool an active scripted encounter');
        epic.stats.objective.expiresAt = Date.now() - 1;
        assert(!Lifecycle.keepHot(epic), 'an expired raid does not pin native actors');
        delete epic.stats.objective.expiresAt;
        assert(!Lifecycle.keepHot({ ...ordinary, status: 'hot' }));
        epic.stats.raidEncounter = { status: 'defeated' };
        assert(!Lifecycle.keepHot(epic), 'normal cooldown resumes at completion');
        epic.status = 'active'; listener(epic);
        assert.equal(timers.size, 1);
        Lifecycle.stop();
        assert.equal(timers.size, 0);
        assert.equal(listener, null);
        console.log('Grand boss native activation, retry, no-player continuity and shutdown ok');
    } finally {
        Lifecycle.stop();
        saved.reverse().forEach(restore => restore());
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
