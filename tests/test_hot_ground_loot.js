const assert = require('assert');
require('../src/Global');
const GroundItems = require('../src/GameServer/World/GroundItems');

const World = invoke('GameServer/World/World');
const Data = invoke('GameServer/DataCache');
const Rates = invoke('GameServer/ProgressionRates');
const Bots = invoke('GameServer/Bot/BotManager');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Loot = invoke('GameServer/Bot/AI/PartyCompanionService');
const Rewards = invoke('GameServer/World/Generics/NpcRewards');
const Pickup = invoke('GameServer/World/Generics/PickupItem');
const Automation = invoke('GameServer/Automation');
const Awareness = invoke('GameServer/Bot/AI/PartyAwareness');
const Combat = invoke('GameServer/Bot/AI/PartyCombatState');
const Geo = invoke('GameServer/Geodata/GeodataEngine');
const saved = [];
const actors = [];
function replace(object, key, value) {
    const old = object[key];
    saved.push(() => object[key] = old);
    object[key] = value;
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function bot(id, x) {
    const session = { accountId: `bot_${id}`, botSession: true, plan: 'hunting', packets: [],
        fetchAccountId() { return this.accountId; },
        dataSendToMe() {}, dataSendToMeAndOthers(packet) { this.packets.push(packet); } };
    session.actor = {
        session, x, z: 0, backpack: {}, automation: new Automation(),
        fetchId: () => id, fetchLevel: () => 40, fetchHead: () => 0,
        fetchLocX() { return this.x; }, fetchLocY: () => 0, fetchLocZ() { return this.z; },
        setLocXYZ(loc) { this.x = loc.locX; this.z = loc.locZ; },
        fetchCollectiveRunSpd: () => 200, fetchIsOnline: () => true, isDead: () => false,
        state: { towards: false, casts: false, pickup: false,
            fetchSeated: () => false, fetchHits: () => false,
            fetchCasts() { return this.casts; }, setTowards(v) { this.towards = v; },
            fetchPickinUp() { return this.pickup; }, setPickinUp(v) { this.pickup = v; } }
    };
    actors.push(session.actor);
    return session;
}

(async () => {
    try {
        replace(Data, 'fetchNpcRewardsFromSelfId', (_id, cb) => cb({ rewards: [{}] }));
        replace(Data, 'fetchItemFromSelfId', (id, cb) => cb({ selfId: id, etc: { stackable: true } }));
        replace(Rates, 'rewardGroupRoll', () => ({ hit: true, itemRate: 1 }));
        replace(Rates, 'selectDropItem', () => ({ selfId: 57 }));
        replace(Rates, 'rollDropAmount', () => 11);
        replace(Math, 'random', () => 0);
        // Open flat ground, whatever map files the machine has.
        replace(Geo, 'getCellData', (_x, _y, z) => ({ z, nswe: 15 }));
        replace(World, 'items', { spawns: [], byLeader: new Map() });
        replace(World, 'npc', { spawns: [] });
        replace(World, 'fetchNpcsInRadius', () => []);
        const purchases = [];
        let nextId = 700000;
        replace(World, 'spawnItem', (_s, selfId, amount, coords, cb) => {
            const id = ++nextId;
            const item = { model: coords, fetchId: () => id, fetchSelfId: () => selfId,
                fetchAmount: () => amount, fetchLocX: () => coords.locX,
                fetchLocY: () => coords.locY, fetchLocZ: () => coords.locZ };
            GroundItems.put(World.items, item);
            cb(item);
        });
        replace(World, 'fetchItem', async id => World.items.spawns.find(i => i.fetchId() === id));
        replace(World, 'purchaseItem', (s, id, amount) => purchases.push([s.actor.fetchId(), id, amount]));
        replace(World, 'pickupItem', Pickup.bind(World));
        const npc = { fetchSelfId: () => 20, fetchLocX: () => 300, fetchLocY: () => 0,
            fetchLocZ: () => 0, fetchLevel: () => 40 };

        for (const grouped of [false, true]) {
            const leader = bot(grouped ? 2 : 1, 0);
            const follower = grouped ? bot(3, -300) : null;
            const sessions = follower ? [leader, follower] : [leader];
            replace(Bots, 'sessions', sessions);
            replace(World, 'user', { sessions: [], revision: 0 });
            sessions.forEach(session => World.insertUser(session));
            if (grouped) {
                sessions.forEach(s => s.hotBackgroundPartyId = 'test');
                replace(Parties, 'find', () => ({ partyId: 'test', status: 'hot', leaderId: 2, memberIds: [2, 3] }));
            }
            purchases.length = 0;
            // A native support cast must finish before loot can claim movement.
            leader.actor.state.casts = true;
            Rewards.call(World, follower || leader, npc);
            const item = World.items.spawns[0];
            assert(item, 'hot rewards must first create a ground object');
            assert.strictEqual(item.model.partyLootLeaderId, leader.actor.fetchId());
            assert.deepStrictEqual(purchases, [], 'neither solo nor party receives an instant inventory award');
            assert.strictEqual(leader.partyGroundPickupInProgress, undefined, 'loot cannot interrupt a support cast');
            leader.actor.state.casts = false;
            leader.pendingSupportCast = { expiresAt: Date.now() + 10000 };
            assert.strictEqual(Loot.startQueuedGroundPickup(leader), false, 'a pending support approach also owns movement');
            leader.pendingSupportCast = null;
            leader.pvpDefense = {};
            assert.strictEqual(Loot.startQueuedGroundPickup(leader), false, 'PvP takes priority over collecting loot');
            leader.pvpDefense = null;
            const enemy = { z: 0, fetchId: () => 1009000, fetchSelfId: () => 20,
                fetchName: () => 'Dungeon mob', fetchAttackable: () => true, isDead: () => false,
                fetchLocX: () => 100, fetchLocY: () => 0, fetchLocZ() { return this.z; },
                fetchDestId: () => leader.actor.fetchId(), getHating: () => 349,
                state: { fetchCombats: () => true }, fetchStateAttack: () => true };
            replace(World, 'npc', { spawns: [enemy] });
            replace(World, 'fetchNpcsInRadius', () => [enemy]);
            leader.actor.fetchDestId = () => enemy.fetchId();
            Awareness.invalidateThreatProjection(leader);
            assert.strictEqual(Awareness.npcThreateningActor(leader), enemy, 'a real nearby attacker still triggers defense');
            assert.strictEqual(Loot.startQueuedGroundPickup(leader), false, 'same-floor combat must still block loot');
            enemy.z = -1689;
            leader.incomingThreatId = enemy.fetchId();
            leader.incomingThreatAt = Date.now();
            Awareness.invalidateThreatProjection(leader);
            assert.strictEqual(Awareness.npcThreateningActor(leader), null, 'underground hate cannot trigger surface defense');
            assert.strictEqual(Awareness.underDirectNpcAttack(leader), false, 'a retained underground target is not direct pressure');
            assert.deepStrictEqual(Awareness.npcsAttackingActor(leader.actor, 1500), []);
            assert.strictEqual(Combat.isActive(leader), false, 'an underground selection cannot lock the loot queue');
            assert.strictEqual(Loot.startQueuedGroundPickup(leader), true, 'the closest bot (including a party leader) starts pickup');
            await wait(350);
            assert(leader.actor.x > 0 && leader.actor.x < item.fetchLocX(), 'native pickup interpolates the bot toward the item');
            assert(leader.packets.some(packet => packet[0] === 0x01), 'the client receives visible movement');
            assert.deepStrictEqual(purchases, [], 'inventory stays unchanged while running');
            assert.strictEqual(World.items.spawns.length, 1, 'loot remains on the ground during travel');
            assert.strictEqual(Loot.startQueuedGroundPickup(leader), true, 'pickup keeps ownership of the AI tick during movement');
            assert.strictEqual(Loot.reconcileGroundLoot(leader), 0, 'reconciliation does not assign the same object twice');
            await wait(2000);
            assert.strictEqual(leader.actor.x, item.fetchLocX() - 20, 'the collector stops at the C4 pickup offset');
            assert.strictEqual(World.items.spawns.length, 0, 'native pickup removes the ground item after arrival');
            assert.deepStrictEqual(purchases, grouped ? [[2, 57, 6], [3, 57, 5]] : [[1, 57, 11]],
                'physical pickup preserves solo ownership and native party Adena distribution');
            assert.strictEqual(Pickup.call(World, leader, leader.actor, item), false, 'a second claimant cannot duplicate the reward');
            assert.deepStrictEqual(leader.partyGroundPickupQueue, [], 'completion releases the queue');
        }
        // A tree stands by the corpse (one closed geodata cell, x 352..367). C4:
        // a drop lies where a walk from the corpse gets and a pickup run ends
        // where a walk ends (Lisvus ItemDropTask and moveToLocation: moveCheck),
        // so no body ends inside the tree.
        {
            const tree = (x, y) => (x >> 4) === 22 && (y >> 4) === 0;
            const inTree = actor => tree(actor.fetchLocX(), actor.fetchLocY());
            replace(Geo, 'getCellData', (x, y, z) => ({ z, nswe: tree(x, y) ? 0 : 15 }));
            const hunter = bot(5, 250);
            replace(Bots, 'sessions', [hunter]);
            replace(World, 'user', { sessions: [], revision: 0 });
            World.insertUser(hunter);
            purchases.length = 0;
            // The scatter throws the drop 50 east of the corpse: past the tree.
            let roll = 0;
            replace(Math, 'random', () => [1, 0][roll++ % 2]);
            Rewards.call(World, hunter, { ...npc, fetchLocX: () => 330 });
            replace(Math, 'random', () => 0);
            const drop = World.items.spawns[0];
            assert(drop.fetchLocX() >= 330 && drop.fetchLocX() < 352, 'a drop thrown past a tree lands on the corpse side of it');
            await wait(700);
            assert.deepStrictEqual(purchases, [[5, 57, 11]], 'the hunter collects the drop');
            assert.strictEqual(inTree(hunter.actor), false, 'the collector does not end inside the tree');

            // A drop already lying behind the tree: no straight run gets to it.
            const stoodAt = hunter.actor.x;
            Rewards.call(World, hunter, { ...npc, fetchLocX: () => 420 });
            assert.strictEqual(Loot.startQueuedGroundPickup(hunter), false, 'a drop behind a tree does not hold the hunter');
            await wait(600);
            assert.strictEqual(hunter.actor.x, stoodAt, 'the hunter does not run through the tree');
            assert.strictEqual(World.items.spawns.length, 1, 'the drop stays on the ground');
            // The hunt moves the hunter past the tree: its next loot scan takes the drop.
            hunter.actor.x = 500;
            assert.strictEqual(Loot.reconcileGroundLoot(hunter), 1, 'a clear line makes the drop the hunter\'s again');
            await wait(600);
            assert.deepStrictEqual(purchases, [[5, 57, 11], [5, 57, 11]], 'the drop is collected from the clear side');

            // A party: the nearer member stands behind the tree, the farther one
            // has a clear line. The farther one collects; the nearer one stays put.
            const near = bot(7, 300), far = bot(8, 600);
            [near, far].forEach(s => s.hotBackgroundPartyId = 'tree');
            replace(Parties, 'find', () => ({ partyId: 'tree', status: 'hot', leaderId: 7, memberIds: [7, 8] }));
            replace(Bots, 'sessions', [near, far]);
            replace(World, 'user', { sessions: [], revision: 0 });
            [near, far].forEach(s => World.insertUser(s));
            purchases.length = 0;
            Rewards.call(World, near, { ...npc, fetchLocX: () => 420 });
            await wait(1000);
            assert.strictEqual(far.actor.x, 440, 'the member with a clear line runs to the drop');
            assert.strictEqual(World.items.spawns.length, 0, 'and collects it');
            assert.strictEqual(purchases.reduce((sum, p) => sum + p[2], 0), 11);
            assert.strictEqual(near.actor.x, 300, 'the nearer member behind the tree does not run into it');

            // A drop is queued to the nearer member while it casts; it then walks
            // behind the tree. It is not stopped for the drop, which waits for a
            // member with a clear line.
            near.actor.x = 250;
            near.actor.state.casts = true;
            Rewards.call(World, near, { ...npc, fetchLocX: () => 330 });
            near.actor.state.casts = false;
            near.actor.x = 400;
            near.packets.length = 0;
            assert.strictEqual(Loot.startQueuedGroundPickup(near), false, 'a drop whose line closed does not hold the member');
            await wait(400);
            assert.strictEqual(near.actor.x, 400, 'the member does not run through the tree');
            assert.strictEqual(far.actor.x, 440, 'nor does the far member, the tree is between it and the drop');
            assert(!near.packets.some(packet => packet[0] === 0x47), 'nor is it stopped for the drop');
            assert.strictEqual(World.items.spawns.length, 1, 'the drop stays on the ground');
            far.actor.x = 200;
            near.lastGroundLootScanAt = 0;
            assert.strictEqual(Loot.reconcileGroundLoot(near), 1, 'a member with a clear line takes it');
            await wait(600);
            assert.strictEqual(World.items.spawns.length, 0, 'and collects it');
            assert.strictEqual(near.actor.x, 400);

            // A player clicks an item behind the tree: no straight run gets to it,
            // so the click is refused (ActionFailed) and the item stays. From a
            // stand with a clear line the same click takes it.
            const State = invoke('GameServer/Model/State');
            const player = { accountId: 'player', packets: [], fetchAccountId() { return this.accountId; },
                dataSendToMe(packet) { this.packets.push(packet); }, dataSendToMeAndOthers(packet) { this.packets.push(packet); } };
            player.actor = { session: player, x: 250, z: 0, backpack: {}, automation: new Automation(), state: new State(),
                fetchId: () => 6, fetchHead: () => 0, fetchRadius: () => 10,
                fetchLocX() { return this.x; }, fetchLocY: () => 0, fetchLocZ() { return this.z; },
                setLocXYZ(loc) { this.x = loc.locX; this.z = loc.locZ; }, fetchCollectiveRunSpd: () => 200,
                fetchIsOnline: () => true, isDead: () => false, isBlocked() { return this.state.isBlocked(); } };
            actors.push(player.actor);
            purchases.length = 0;
            let clicked = null;
            World.spawnItem(player, 57, 11, { locX: 420, locY: 0, locZ: 0 }, item => clicked = item);
            const Generics = invoke(path.actor);
            Generics.pickupRequest(player, player.actor, { id: clicked.fetchId() });
            await wait(50);
            assert(player.packets.some(packet => packet[0] === 0x25), 'a click on an item behind a tree gets ActionFailed');
            await wait(600);
            assert.strictEqual(player.actor.x, 250, 'the player does not run into the tree');
            assert.strictEqual(World.items.spawns.length, 1, 'the item stays on the ground');
            assert.deepStrictEqual(purchases, []);
            player.actor.x = 500;
            Generics.pickupRequest(player, player.actor, { id: clicked.fetchId() });
            await wait(600);
            assert.deepStrictEqual(purchases, [[6, 57, 11]], 'the same click from a clear line takes the item');
            assert.strictEqual(World.items.spawns.length, 0);
            replace(Geo, 'getCellData', (_x, _y, z) => ({ z, nswe: 15 }));
        }
        // A melee hunter's own swing kills. C4: a body neither moves nor picks
        // up inside its swing (Lisvus L2CharacterAI.onIntentionPickUp); the drop
        // is its next action and it runs to it when the swing ends.
        {
            const Attack = invoke('GameServer/Actor/Attack'), State = invoke('GameServer/Model/State');
            const Npc = invoke('GameServer/Npc/Npc'), Index = require('../src/GameServer/World/NpcObjectIndex');
            const Quests = invoke('GameServer/Quest/QuestService');
            Data.init();
            replace(invoke('GameServer/Formulas'), 'calcHitChance', () => true);
            replace(Geo, 'canWalkStraight', () => true);
            replace(invoke('GameServer/Actor/Generics'), 'experienceReward', () => {});
            replace(invoke('GameServer/World/Generics/NpcDecay'), 'schedule', () => {});
            replace(invoke('GameServer/Items/SoulCrystalProgression'), 'onDeath', async () => {});
            replace(Quests, 'onAttack', async () => {});
            replace(Quests, 'onKill', async () => {});
            replace(World, 'npc', { spawns: [] });
            replace(World, 'fetchNpcsInRadius', () => []);
            Index.reset(World);
            // The drop lands at the far edge of its 50-unit scatter around the corpse.
            const spawnAtCorpse = World.spawnItem;
            replace(World, 'spawnItem', (s, selfId, amount, coords, cb) => spawnAtCorpse(s, selfId, amount, { ...coords, locX: coords.locX + 50 }, cb));
            const hunter = bot(4, 0);
            Object.assign(hunter.actor, { state: new State(), attack: new Attack(), effects: {}, hp: 1000,
                backpack: { fetchTotalWeaponKind: () => 'Weapon.Sword' }, fetchRadius: () => 8, fetchName: () => 'Hunter',
                fetchCollectiveAtkSpd: () => 333, fetchCollectiveRunSpd: () => 130, fetchMaxHp: () => 1000,
                fetchHp() { return this.hp; }, statusUpdateVitals() {}, isBlocked() { return this.state.isBlocked(); } });
            hunter.actor.attack.prepareMeleeHit = () => ({ damage: 50, flags: 0 });
            replace(Bots, 'sessions', [hunter]);
            replace(World, 'user', { sessions: [], revision: 0 });
            World.insertUser(hunter);
            const monster = Data.npcs.find(entry => entry.template?.kind === 'Monster');
            const mob = new Npc(1500001, { ...utils.crushOb(monster), locX: 50, locY: 0, locZ: 0, head: 0 });
            mob.setHp(1);
            World.npc.spawns.push(mob);
            Index.add(World, mob);
            purchases.length = 0;
            hunter.actor.attack.meleeHit(hunter, mob); // 333 attack speed: lands at 0.9 s, ends at 1.4 s
            await wait(1150);
            assert.strictEqual(World.items.spawns.length, 1, 'the killing hit drops a ground object');
            assert.strictEqual(hunter.actor.x, 0, 'the hunter finishes its swing before it moves to the drop');
            assert.strictEqual(Loot.startQueuedGroundPickup(hunter), true, 'the drop is the next action: the AI tick starts no other hunt');
            await wait(1450);
            assert.deepStrictEqual(purchases, [[4, 57, 11]], 'the hunter collects its drop right after the swing ends');
            assert.deepStrictEqual(hunter.partyGroundPickupQueue, [], 'completion releases the queue');

            // An order that stops the body mid-run (a stun, a teleport, a command)
            // does not leave the drop waiting: the next AI tick runs to it again.
            Rewards.call(World, hunter, { ...npc, fetchLocX: () => 400 });
            await wait(200);
            hunter.actor.automation.abortAll(hunter.actor);
            const stoppedAt = hunter.actor.x;
            assert.strictEqual(Loot.startQueuedGroundPickup(hunter), true, 'the drop stays the hunter\'s action');
            await wait(300);
            assert(hunter.actor.x > stoppedAt + 20, 'a stopped run to the drop is taken again at the next tick');

            // Another member kills the victim of a picker mid-swing. The picker's
            // hit timer clears its swing before the swing ends, yet it has taken
            // the drop: the party still has a collector and must not pull on.
            await wait(1500);
            hunter.actor.automation.abortAll(hunter.actor);
            Object.assign(hunter, { partyGroundPickupQueue: [], partyGroundPickupInProgress: false, partyGroundPickupRun: null });
            World.items.spawns.length = 0;
            hunter.actor.x = 0;
            const victim = new Npc(1500002, { ...utils.crushOb(monster), locX: 50, locY: 0, locZ: 0, head: 0 });
            victim.setHp(1000);
            World.npc.spawns.push(victim);
            Index.add(World, victim);
            hunter.actor.attack.meleeHit(hunter, victim);
            await wait(300);
            victim.state.setDead(true);
            Rewards.call(World, hunter, { ...npc, fetchLocX: () => 50 });
            let waiting = false;
            for (let i = 0; i < 80 && !waiting; i++) {
                waiting = hunter.partyGroundPickupInProgress === true && hunter.partyGroundPickupRun == null
                    && !hunter.actor.state.fetchHits();
                if (!waiting) await wait(25);
            }
            assert(waiting, 'the swing clears before its end while the drop is already taken');
            assert.strictEqual(Loot.collectingGroundLoot(hunter), true, 'a picker finishing its swing is still the party\'s collector');
            const alive = hunter.actor.isDead;
            hunter.actor.isDead = () => true;
            assert.strictEqual(Loot.collectingGroundLoot(hunter), false, 'a dead body that took a drop collects nothing');
            hunter.actor.isDead = alive;
            await wait(2500); // the swing ends and the drop is collected
            assert.strictEqual(hunter.partyGroundPickupInProgress, false, 'the collector finishes its drop');
        }
        console.log('Hot ground loot: native drop, movement, arrival, swing-end and resumed pickup, drops and runs around a tree, solo/party ownership and combat/support priority passed');
    } finally {
        actors.forEach(actor => actor.automation.abortAll(actor, { notifyClient: false }));
        saved.reverse().forEach(restore => restore());
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
