'use strict';

const assert = require('node:assert/strict');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
const Rules = invoke('GameServer/RaidBoss/GrandBossRules');
const Runtime = invoke('GameServer/RaidBoss/GrandBossRuntime');
const Catalog = invoke('GameServer/RaidBoss/RaidBossSourceCatalog');
const Curse = invoke('GameServer/RaidBoss/RaidCurse');
const Minions = invoke('GameServer/World/RaidBossMinionManager');
const Index = invoke('GameServer/World/RaidEntityIndex');
const Spawn = invoke('GameServer/World/Generics/SpawnNpcs');
const Npc = invoke('GameServer/Npc/Npc');
const Skills = invoke('GameServer/Npc/NpcSkills');
const Effects = invoke('GameServer/Effects/EffectStore');
const Equipment = invoke('GameServer/Items/C4EquipmentItemSkills');
const Rates = invoke('GameServer/ProgressionRates');
const World = invoke('GameServer/World/World');
const Policy = invoke('GameServer/Bot/Population/OpportunisticRaidPolicy');
const { useRate } = require('./helpers/progressionRate');

Data.init();
const world = {
    user: { sessions: [] }, npc: { spawns: [], nextId: 3000000, grid: {} },
    addNpcToGrid(npc) { Index.add(this, npc); },
    removeNpcFromGrid(npc) { Index.remove(this, npc); }
};
function make(id, point = Rules.data.locations[id]?.[0] || Rules.data.orfenLair) {
    const npc = new Npc(world.npc.nextId++, { ...utils.crushOb(Data.npcs.find(n => n.selfId === id)), ...point });
    world.npc.spawns.push(npc);
    world.addNpcToGrid(npc);
    return npc;
}
const quiet = { dataSendToMe() {}, dataSendToMeAndOthers() {} };
const actor = (id, level) => ({
    level, online: true, loc: { ...Rules.data.locations[12001][0] },
    fetchId: () => id,
    fetchLevel() { return this.level; },
    fetchIsOnline() { return this.online; },
    fetchLocX() { return this.loc.locX; },
    fetchLocY() { return this.loc.locY; },
    fetchLocZ() { return this.loc.locZ; }
});

async function main() {
    const oldNpc = World.npc, oldUser = World.user;
    World.npc = world.npc; World.user = world.user;
    try {
        for (const [id, level, hp, hours] of [[12001, 40, 229898, 36], [12052, 50, 162561, 60], [12169, 50, 325124, 48]]) {
            const profile = Catalog.findById(`raid:${id}`);
            assert.equal(profile.avgLevel, level);
            assert.equal(profile.maxLevel, 78);
            assert.equal(profile.respawnSeconds, hours * 3600);
            assert.equal(profile.mob.hp, Math.round(hp * .75));
            assert.equal(Curse.isAboveRaidThreshold(actor(1, 78), { fetchSelfId: () => id, fetchLevel: () => level }), false);
            assert(Policy.levelAllowed({ level: 78 }, level, { npcId: id }));
            assert.equal(Rules.respawnDelayMs(id, () => .5), hours * 3600000);
            const spread = Rules.data.respawnHours[id][1];
            assert.equal(Rules.respawnDelayMs(id, () => 0), (hours - spread) * 3600000);
            assert.equal(Rules.respawnDelayMs(id, () => .999999), (hours + spread) * 3600000);
        }
        assert(Curse.isAboveRaidThreshold(actor(1, 60), { fetchSelfId: () => 10001, fetchLevel: () => 40 }));
        assert(!Policy.levelAllowed({ level: 60 }, 40, { npcId: 10001 }));
        const ambient = Data.npcSpawns.flatMap(a => a.spawns).filter(n => [12004, 12171, 12173].includes(n.selfId));
        assert.equal(ambient.filter(n => n.selfId === 12004).length, 25);
        assert.equal(ambient.filter(n => n.selfId === 12171).length, 3);
        assert.equal(ambient.filter(n => n.selfId === 12173).length, 4);
        assert(!Data.npcSpawns.some(a => a.spawns.some(n => n.selfId === 12053)), 'cubes exist only after Core dies');
        for (const [npcId, itemId] of [[12001, 6660], [12052, 6662], [12169, 6661]]) {
            assert(Data.items.some(item => item.selfId === itemId));
            const groups = Data.npcRewards.find(n => n.selfId === npcId).rewards.filter(g => g.items.some(i => i.selfId === itemId));
            assert.equal(groups.length, 1);
            assert.equal(groups[0].overall, 30);
            Data.fetchNpcRewardsFromSelfId(npcId, reward => {
                const live = reward.rewards.find(group => group.items.some(item => item.selfId === itemId));
                assert.equal(live?.epic, true, 'the native reward index must expose the epic row, not its cached predecessor');
                assert.equal(live.overall, 30);
            });
            for (const preset of ['x1', 'x10', 'x50']) {
                useRate(preset);
                const roll = Rates.rewardGroupRoll(groups[0], 'drop', { npcLevel: 50, killerLevel: 50 }, () => .31);
                assert.equal(roll.chance, 30, 'epic chance is independent of the leveling preset');
                assert.equal(roll.hit, false);
                assert.deepEqual(Rates.dropAmountRange(groups[0], groups[0].items[0], roll.itemRate), { min: 1, max: 1 });
                assert(Math.abs(Rates.rewardGroupRoll(groups[0], 'drop', { npcLevel: 40, killerLevel: 56 }, () => .5).chance - 2.8) < 1e-9);
            }
            assert(require('../data/Admin/Shop/shop.json')['epic-jewels'].includes(itemId));
            const wearer = { effects: {} };
            Equipment.sync(wearer, [1, 2].map(id => ({ fetchId: () => id, fetchSelfId: () => itemId, fetchEquipped: () => true })));
            assert.equal(Effects.list(wearer).length, 1, 'two identical epics grant one passive');
        }
        let shopPacket = null;
        const shopSession = { actor: { backpack: { fetchTotalAdena: () => 0 } }, dataSendToMe(packet) { shopPacket = packet; } };
        invoke('GameServer/World/Generics/NpcBypasses/AdminShop')(shopSession, ['admin-shop', 'epic-jewels']);
        assert(shopPacket?.length > 0);
        assert.deepEqual([...shopSession.activeAdminShop.itemIds], [6660, 6661, 6662]);

        // Exercise the actual cached lookup, rated roll, item lookup and
        // ground-drop path at x50, isolating only geometry and pickup work.
        const Geo = invoke('GameServer/Geodata/GeodataEngine');
        const nativeRoll = Rates.rewardGroupRoll, nativeMoveEnd = Geo.straightMoveEnd;
        const awarded = [];
        const lootSession = { ...quiet, accountId: 'bot_epic_review', actor: actor(4000099, 40) };
        Rates.rewardGroupRoll = (group, kind, context) => group.epic
            ? nativeRoll(group, kind, context, () => 0) : { hit: false };
        Geo.straightMoveEnd = (locX, locY, locZ) => ({ locX, locY, locZ });
        try {
            for (const npcId of [12001, 12052, 12169]) {
                const npc = make(npcId);
                npc.setHp(0);
                invoke('GameServer/World/Generics/NpcRewards').call({
                    spawnItem(_session, selfId, amount) { awarded.push([selfId, amount]); }
                }, lootSession, npc);
                npc.destructor(quiet);
                world.removeNpcFromGrid(npc);
                world.npc.spawns.splice(world.npc.spawns.indexOf(npc), 1);
            }
        } finally {
            Rates.rewardGroupRoll = nativeRoll;
            Geo.straightMoveEnd = nativeMoveEnd;
        }
        assert.deepEqual(awarded, [[6660, 1], [6662, 1], [6661, 1]], 'all three native epic drops produce one real item at x50');

        const queen = make(12001);
        const aq = Minions.attachBoss(world, queen);
        assert.deepEqual(aq.groups.map(g => [g.minionId, g.members.length]), [[12002, 1], [12003, 8], [12005, 8]]);
        const larva = aq.groups[0].members[0];
        assert.equal(larva.canEngageCombat(), false);
        const nurses = aq.groups[1];
        const nurse = nurses.members[2];
        queen.setHp(queen.fetchHp() - 20000);
        Runtime.onAttack(world, queen, actor(1, 56), 1, quiet, () => .26);
        assert.equal(nurse.state.fetchCasts(), false, 'the 5% gate must be observed');
        const rolls = [.01, .3];
        Runtime.onAttack(world, queen, actor(1, 56), 1, quiet, () => rolls.shift());
        const casting = nurses.members.find(n => n.state.fetchCasts());
        assert(casting, 'a nurse must cast the native heal');
        assert.equal(casting.attack.activeCast.target, queen);
        assert.equal(casting.attack.activeCast.skill.fetchSelfId(), 4020);
        const before = queen.fetchHp();
        await new Promise(resolve => setTimeout(resolve, casting.attack.activeCast.landsAt - Date.now() + 100));
        assert(queen.fetchHp() > before, 'native nurse heal must land on AQ');
        const noRespawn = larva.fetchId();
        larva.setHp(0); larva.state.setDead(true); Minions.onMinionDeath(world, larva);
        assert(!aq.groups[0].respawnAt);
        nurse.setHp(0); nurse.state.setDead(true); Minions.onMinionDeath(world, nurse);
        const due = nurses.respawnAt;
        const second = nurses.members[3];
        second.setHp(0); second.state.setDead(true); Minions.onMinionDeath(world, second);
        const deadlines = nurses.pendingRespawns.map(r => r.at);
        assert(deadlines.every(t => t >= due && t <= Date.now() + 10000));
        assert.equal(Minions.maintain(world, due - 1), 0);
        Minions.maintain(world, Math.max(...deadlines) + 1);
        assert.equal(nurses.members.filter(n => !n.isDead()).length, 8);
        assert.equal(aq.groups[0].members[0].fetchId(), noRespawn);

        // The source starts drop level calculation at the main damage dealer.
        const low = actor(4000001, 40), high = actor(4000002, 56);
        queen.setHp(queen.fetchMaxHp() - 1);
        Runtime.recordDamage(queen, low, 10000, { actor: low });
        Runtime.recordDamage(queen, high, 1, { actor: high });
        queen.setHp(queen.fetchMaxHp());
        Runtime.recordDamage(queen, high, 1, { actor: high });
        assert.equal(Rates.deepBlueRule(Runtime.dropContext(queen)).active, false, 'a high helper outside +8 does not replace the main damager');
        Runtime.recordDamage(queen, high, 20000, { actor: high });
        assert.equal(Rates.deepBlueRule(Runtime.dropContext(queen)).penaltyPercent, 72);
        assert(Math.abs(Rates.deepBlueRule(Runtime.dropContext(queen)).chanceMultiplier - .09333333333333334) < 1e-9);
        high.online = false;
        assert.equal(Runtime.dropContext(queen, low).killerLevel, 40, 'an offline main damager cannot suppress the surviving raid drop');
        high.online = true;
        high.loc.locZ += 2000;
        assert.equal(Runtime.dropContext(queen, low).killerLevel, 40, 'a main damager outside the C4 reward range is excluded, including another floor');
        high.loc.locZ -= 2000;
        high.level = 57;
        assert.equal(Runtime.dropContext(queen, low).killerLevel, 57, 'drop level uses the current character level, including levels gained from adds');
        high.level = 56;
        high.session = { actor: null };
        assert.equal(Runtime.dropContext(queen, low).killerLevel, 40, 'a detached session is not an online participant');
        delete high.session;
        low.online = false; high.online = false;
        assert.equal(Runtime.dropContext(queen, low).killerLevel, 40, 'without an eligible contributor the source falls back to the last acting player');
        const originalRoll = Rates.rewardGroupRoll;
        let nativeDropLevel = null;
        Rates.rewardGroupRoll = (group, _kind, context) => {
            if (group.epic) nativeDropLevel = context.killerLevel;
            return { hit: false };
        };
        try {
            invoke('GameServer/World/Generics/NpcRewards').call(world, { actor: low }, queen);
        } finally { Rates.rewardGroupRoll = originalRoll; }
        assert.equal(nativeDropLevel, 40, 'the real loot pipeline supplies its last acting player for the fallback');
        low.online = true; high.online = true;
        Runtime.teleportNpc(world, queen, Rules.data.locations[12001][0]);
        assert.equal(queen.grandBossDamage.size, 0, 'a source hate reset also resets damage ownership');
        queen.setHp(100);
        Runtime.recordDamage(queen, high, 1, { actor: high });
        queen.setHp(0);
        queen.destructor(quiet);
        assert.equal(Runtime.dropContext(queen).killerLevel, 56, 'death teardown retains drop ownership for the loot step');

        const orfen = make(12169);
        const orfenState = Minions.attachBoss(world, orfen);
        assert.equal(orfenState.groups[0].members.length, 4);
        assert.equal(orfenState.groups[0].respawnMs, 360000);
        orfen.setHp(orfen.fetchMaxHp() * .49);
        Runtime.onAttack(world, orfen, low, 1, quiet, () => 1);
        assert.equal(orfen.grandBossLair, true);
        assert.equal(orfen.fetchLocX(), Rules.data.orfenLair.locX);
        assert.equal(orfen.aggroList.size, 0);
        Runtime.tick(world, orfen);
        assert(orfenState.groups[0].members.every(n => Math.abs(n.fetchLocX() - orfen.fetchLocX()) < 100));
        orfen.setHp(orfen.fetchMaxHp() * .96);
        Runtime.tick(world, orfen, Date.now(), () => 0);
        assert.equal(orfen.grandBossLair, false);
        assert.equal(orfen.fetchLocX(), Rules.data.locations[12169][0].locX);
        assert(Runtime.insideOrfen(orfen));
        const riba = make(12173);
        orfen.setLocXYZ(Rules.data.orfenLair);
        orfen.setHp(orfen.fetchMaxHp() * .4);
        Runtime.factionCall(world, riba, orfen, low, quiet, () => 0);
        assert.equal(riba.attack.activeCast?.skill.fetchSelfId(), 4516);
        assert.equal(riba.attack.activeCast?.target, orfen);
        riba.attack.abortCast(quiet, riba);

        const core = make(12052);
        const coreState = Minions.attachBoss(world, core);
        assert.equal(core.fetchRunSpd(), 0);
        assert.deepEqual(coreState.groups.map(g => g.members.length), [10, 5, 4]);
        assert(coreState.groups.every(g => g.respawnMs === 60000));
        assert.equal(Minions.onBossAttacked(world, core, low, quiet), 0,
            'Core guards use their faction radius instead of an ordinary raid-wide pull');
        const pet = make(12004);
        pet.model.isSummon = true;
        pet.ownerSession = { ...quiet, actor: low };
        orfen.setHp(orfen.fetchMaxHp());
        const Attack = invoke('GameServer/Actor/Attack');
        assert(new Attack().isValidSkillTarget(pet, Skills.forId(4063), orfen), 'Orfen can paralyze an owned summon');
        const nativeRandom = Math.random;
        try {
            Math.random = () => 0; // Deterministic landing through the real NPC cast/area-effect path.
            Runtime.skillSeen(pet, Skills.forId(4020), () => 0);
            assert.equal(pet.fetchLocX(), orfen.fetchLocX(), 'Orfen pulls the pet when the pet is the actual caster');
            assert.equal(orfen.attack.activeCast?.target, pet);
            await new Promise(resolve => setTimeout(resolve, orfen.attack.activeCast.landsAt - Date.now() + 100));
            assert(Effects.hasDebuff(pet, 'paralyze'), 'the native Orfen cast lands on the owned summon');
        } finally {
            Math.random = nativeRandom;
            orfen.attack.abortCast(quiet, orfen);
        }
        delete pet.ownerSession;
        pet.model.ownerId = high.fetchId();
        high.loc = { locX: orfen.fetchLocX(), locY: orfen.fetchLocY(), locZ: orfen.fetchLocZ() };
        world.user.sessions.push({ actor: high });
        Runtime.recordDamage(orfen, pet, 10, { actor: pet });
        assert.equal(Runtime.dropContext(orfen).killerLevel, 56, 'a servitor cast credits its owner, even through an NPC cast session');
        Runtime.died(world, core);
        const cubes = world.npc.spawns.filter(n => n.fetchSelfId() === 12053);
        assert.equal(cubes.length, 2);
        assert(cubes.every(n => n.questSpawn.timer._idleTimeout === 900000));
        assert.equal(Skills.forId(4063).fetchSemantic().durationMs, 120000);
        assert.equal(Skills.forId(4064).fetchSemantic().durationMs, 120000);
        assert.equal(Skills.forId(4020).fetchPower(), 10845);
        console.log('C4 grand bosses ok');
    } finally {
        for (const npc of [...world.npc.spawns]) {
            Spawn.clearQuestSpawn(npc);
            Minions.removeMinions(world, npc, quiet);
            npc.destructor(quiet);
        }
        World.npc = oldNpc; World.user = oldUser;
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
