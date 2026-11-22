const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
process.env.L2NODE_PROGRESSION_RATE = 'x1';
require('../src/Global');

const Database = invoke('Database');
const World = invoke('GameServer/World/World');
const Clan = invoke('GameServer/Clan/ClanService');
const Quests = invoke('GameServer/Quest/QuestService');
const Ambition = invoke('GameServer/Clan/ClanAmbitionService');
const Bot = invoke('GameServer/Bot/AI/ClanAmbitionQuestAI');
const PartyAwareness = invoke('GameServer/Bot/AI/PartyAwareness');
const Rules = require('../src/GameServer/Clan/ClanAmbitionRules');
const { ID, NPC, MOB, ITEM } = Rules;
const cost = require('../src/GameServer/Clan/ClanRules').LEVEL_REQUIREMENTS[4].sp;
const reward = Math.round(Rules.SP_REWARD * Quests.questRates().questSp);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-clan-ambition-'));
const filename = path.join(directory, 'world.sqlite');
let nextObjectId = 1000000;

function npc(selfId, location = 0) {
    const objectId = nextObjectId++;
    return {
        x: location, dead: false, hp: 100,
        fetchId: () => objectId, fetchSelfId: () => selfId, fetchName: () => String(selfId),
        fetchLocX() { return this.x; }, fetchLocY: () => 0, fetchLocZ: () => 0,
        isDead() { return this.dead; }, fetchHp() { return this.hp; }, fetchMaxHp: () => 100
    };
}

function makeSession(id, clanId, sp) {
    const actor = {
        ...npc(0), fetchId: () => id, fetchClanId: () => clanId,
        fetchLevel: () => 69, fetchExp: () => 100, fetchClassId: () => 2, fetchMp: () => 100, fetchMaxMp: () => 100,
        fetchIsOnline: () => true, fetchSp: () => sp, setSp: value => { sp = value; },
        state: { fetchSeated: () => false },
        automation: { replenishVitals() {} },
        backpack: {
            items: [], fetchItems() { return this.items; },
            insertItem(objectId, selfId, { amount }) {
                this.items.push({ fetchId: () => objectId, fetchSelfId: () => selfId,
                    fetchAmount: () => amount, setAmount: n => { amount = n; } });
            }
        }
    };
    return { actor, pages: [], dataSendToMe(packet) { if (typeof packet === 'string') this.pages.push(packet); }, dataSendToOthers() {} };
}

const player = makeSession(1000001, 1, 0);
const helper = { ...makeSession(1000002, 1, 0), botSession: true };
const bot = { ...makeSession(1000003, 2, cost - reward + 17), botSession: true };
const precollectedMaterials = [[ITEM.thunder, 2], [ITEM.broken, 3], [ITEM.stone, 1], [ITEM.key, 2]];
const npcIds = [...Object.values(NPC), ...Object.values(MOB), 7191];
const staticNpcs = new Map(npcIds.filter(id => !Rules.DYNAMIC_NPCS.includes(id)).map((id, i) => [id, npc(id, i * 120)]));
const find = id => staticNpcs.get(id);
const count = (session, id) => Ambition.inventoryCounts(session)[id] || 0;
const step = session => Ambition.state(session).cond;
const encounter = (session, name) => Ambition.encounters(session, Ambition.state(session).attempt, name);

function moveTo(session, target) { session.actor.x = target.x; }
async function event(session, name, target = find(Rules.TALK[name].npc)) {
    moveTo(session, target);
    session.activeNpcTalk = { selfId: target.fetchSelfId(), objectId: target.fetchId() };
    return Quests.onEvent(session, { questId: ID, name });
}
async function kill(session, target, material = 0) {
    moveTo(session, target);
    target.dead = true;
    const random = Math.random;
    const rolls = [0, material];
    Math.random = () => rolls.shift() ?? 0;
    try { await Quests.onKill(session, target, session.actor); } finally { Math.random = random; }
}
const freshMob = id => npc(id, find(id).x);

async function discardSeal(session) {
    const bag = session.actor.backpack;
    const seal = bag.items.find(item => item.fetchSelfId() === ITEM.seal);
    assert(seal);
    await Database.execute(['DELETE FROM items WHERE id = ?', [seal.fetchId()]], 'test:ambition:discard-seal');
    bag.items = bag.items.filter(item => item !== seal);
}

async function seed() {
    const db = new DatabaseSync(filename);
    db.exec(fs.readFileSync(path.resolve(__dirname, '../database/sql/sqlite.sql'), 'utf8'));
    const account = db.prepare('INSERT INTO accounts(username,password) VALUES (?,?)');
    const character = db.prepare(`INSERT INTO characters (id,username,name,classId,race,level,exp,sp,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ,clanId)
        VALUES (?,?,?,2,0,69,100,?,500,500,0,0,0,0,0,0,0,?)`);
    const clans = db.prepare('INSERT INTO clans(id,name,leaderId,level) VALUES (?,?,?,4)');
    clans.run(1, 'PlayerClan', player.actor.fetchId());
    clans.run(2, 'BotClan', bot.actor.fetchId());
    db.prepare(`INSERT INTO clan_simulation_clans(clanId, mode, createdAt, updatedAt, stateJson)
        VALUES (2, 'autonomous', 0, 0, ?)`).run(JSON.stringify({ mode: 'autonomous', level: 4 }));
    for (const [session, username] of [[player, 'player'], [helper, 'bot_clan_helper'], [bot, 'bot_clan_ambition']]) {
        account.run(username, 'test');
        character.run(session.actor.fetchId(), username, username, session.actor.fetchSp(), session.actor.fetchClanId());
        session.accountId = username;
    }
    db.prepare('UPDATE characters SET title = ? WHERE id = ?').run('Clan Leader', bot.actor.fetchId());
    const insertItem = db.prepare('INSERT INTO items(selfId, name, amount, characterId) VALUES (?, ?, ?, ?)');
    for (const [id, amount] of precollectedMaterials) {
        const row = insertItem.run(id, Rules.NAMES[id], amount, player.actor.fetchId());
        player.actor.backpack.insertItem(Number(row.lastInsertRowid), id, { amount });
    }
    db.prepare(`INSERT INTO bot_life_state(characterId, accountName, characterName, level, sp, phase)
        VALUES (?, ?, ?, 69, ?, 'cold')`).run(bot.actor.fetchId(), bot.accountId, bot.accountId, bot.actor.fetchSp());
    db.close();
    options.default.Database.path = filename;
    Database.init();
    World.user = { sessions: [player, helper, bot] };
    World.npc = { spawns: [...staticNpcs.values()] };
    World.spawnQuestNpc = ({ selfId, locX, ownerId, questId }) => {
        const target = npc(selfId, locX);
        target.questSpawn = { ownerId, questId };
        World.npc.spawns.push(target);
        return target;
    };
    const spawns = invoke('GameServer/World/Generics/SpawnNpcs');
    spawns.despawnQuestNpc = (_, target) => { World.npc.spawns = World.npc.spawns.filter(n => n !== target); };
    const packets = invoke('GameServer/Network/Response');
    for (const key of ['itemsList', 'statusUpdate', 'userInfo', 'pledgeShowInfoUpdate']) packets[key] = () => Buffer.alloc(0);
    packets.npcHtml = (_, html) => html;
    invoke('GameServer/Clan/ClanSocialRuntime').syncMemberships = () => {};
    PartyAwareness.partySessions = leader => leader === player ? [player, helper] : [leader];
    PartyAwareness.npcThreateningActor = () => null;
    await Clan.reload();
}

function verifyKeeperBanishment(keeper) {
    moveTo(helper, keeper);
    const teleports = [];
    const originalInvoke = global.invoke;
    const random = Math.random;
    global.invoke = key => key === 'GameServer/Actor/Generics/TeleportTo'
        ? (session, actor, coords) => {
            teleports.push({ session, coords });
            actor.x = coords.locX;
            return true;
        } : originalInvoke(key);
    Math.random = () => 0;
    try {
        Ambition.onAttack(player, keeper);
        assert.deepEqual(teleports, [], 'the player is immune even when the teleport roll would succeed');
        Ambition.onAttack(helper, keeper);
        moveTo(helper, keeper);
        Ambition.onAttack(helper, keeper);
        assert.deepEqual(teleports, [{ session: helper, coords: Rules.KEEPER_BANISHMENT }]);
        assert.equal(player.actor.x, keeper.x, 'banishing the bot leaves the player in range');
    } finally {
        global.invoke = originalInvoke;
        Math.random = random;
    }
}

async function play() {
    assert.equal(await Quests.hasTalk(helper, find(NPC.gustav)), false);
    await event(helper, 'start');
    assert.equal(count(helper, ITEM.first), 0);
    await Quests.onTalk(player, find(NPC.gustav));
    assert(player.pages.at(-1).includes('Accept the commission'));
    await event(player, 'start');
    assert.equal(step(player), 1);
    for (const [id, amount] of precollectedMaterials) {
        assert.equal(count(player, id), amount, 'starting the quest keeps materials in the backpack');
    }
    const savedMaterials = await Database.execute([
        'SELECT selfId, amount FROM items WHERE characterId = ? AND selfId <> ? ORDER BY selfId',
        [player.actor.fetchId(), ITEM.first]
    ], 'test:ambition:precollected-materials');
    assert.deepEqual(savedMaterials.map(({ selfId, amount }) => [selfId, amount]), precollectedMaterials);
    await player.questStates.get(ID).quest.onAbort(player.questStates.get(ID));
    assert.equal(count(player, ITEM.first), 0);
    assert.equal(step(player), undefined);
    await event(player, 'restore_seal');
    assert.equal(count(player, ITEM.seal), 0);
    await Promise.all([event(player, 'start'), event(player, 'start')]);
    assert.equal(count(player, ITEM.first), 1);
    assert.equal(await event(player, 'meet_martien', find(NPC.gustav)), false);
    await event(player, 'meet_martien');
    await event(player, 'eggs');
    assert.equal(step(player), 2, 'an early hand-in must leave the stage unchanged');

    const thunder = freshMob(MOB.thunder);
    await kill(helper, thunder);
    await kill(helper, thunder);
    assert.equal(count(player, ITEM.thunder), 1, 'one nearby clan party kill credits the leader once');
    assert.equal(count(helper, ITEM.thunder), 0);
    for (let i = 0; i < 10; i++) {
        await kill(player, freshMob(MOB.thunder));
        await kill(player, freshMob(MOB.drake));
    }
    assert.equal(count(player, ITEM.thunder), 10);
    await event(player, 'fritz');
    await event(player, 'fritz');
    assert.equal(count(player, ITEM.blitz), 3);
    assert.equal(encounter(player, 'fritz').length, 2);
    await kill(player, encounter(player, 'fritz')[0]);
    const savedAttempt = Ambition.state(player).attempt;
    World.npc.spawns = World.npc.spawns.filter(n => n.ambition?.attempt !== savedAttempt);
    player.questStates = new Map();
    player.questStatesLoaded = false;
    await Quests.ensureLoaded(player);
    await event(player, 'fritz');
    assert.equal(encounter(player, 'fritz').length, 1, 'recovery resummons only the outstanding wyrm');
    await kill(player, encounter(player, 'fritz')[0]);
    await event(player, 'lutz');
    for (const target of encounter(player, 'lutz')) await kill(player, target);
    await event(player, 'kurtz');
    await event(player, 'coin');
    await event(player, 'eggs');
    await event(player, 'second');
    await event(player, 'meet_smith');
    await event(player, 'recipe');
    assert.equal(count(player, ITEM.recipe), 1);
    await kill(player, freshMob(MOB.scout), 0.9);
    assert.equal(count(player, ITEM.broken), 1);
    for (let i = 0; i < 10; i++) {
        await kill(player, freshMob(MOB.soldier));
        await kill(player, freshMob(MOB.scout), 0.5);
    }
    for (const name of ['research', 'third', 'meet_rodemai', 'riddle', 'cemetery']) await event(player, name);
    await kill(player, freshMob(MOB.keeper));
    assert.equal(encounter(player, 'coffer').length, 0);
    for (let i = 0; i < Rules.KEYS; i++) {
        await kill(player, freshMob(MOB.guard));
        await kill(player, encounter(player, 'keymaster')[0]);
    }
    const keeper = freshMob(MOB.keeper);
    keeper.hp = 51;
    moveTo(player, keeper);
    Ambition.onAttack(player, keeper);
    assert.equal(encounter(player, 'keeper_guards').length, 0);
    keeper.hp = 50;
    Ambition.onAttack(player, keeper);
    assert.equal(encounter(player, 'keeper_guards').length, 4);
    verifyKeeperBanishment(keeper);
    await kill(helper, keeper);
    await kill(helper, keeper);
    const coffers = encounter(player, 'coffer');
    assert.equal(coffers.length, 1, 'the nearby leader gets one coffer when the companion kills the keeper');
    const [coffer] = coffers;
    assert.equal(coffer.x, keeper.x);
    assert.equal(await event(bot, 'coffer', coffer), false);
    await event(player, 'coffer', coffer);
    assert.equal(count(player, ITEM.key), 0);
    assert.equal(count(player, ITEM.scepter), 1);
    await event(player, 'discuss');
    await Promise.all([event(player, 'finish'), event(player, 'finish')]);
    assert.equal(count(player, ITEM.seal), 1);
    assert.equal(count(player, ITEM.recipe), 0);
    assert.equal(player.actor.fetchSp(), reward);
    const seal = player.actor.backpack.items.find(item => item.fetchSelfId() === ITEM.seal);
    const Backpack = invoke('GameServer/Actor/Backpack');
    Backpack.prototype.dropItem.call({
        fetchItemRaw: () => seal, deleteItem: () => assert.fail('the seal must not be transferable by dropping it')
    }, player, seal.fetchId(), 1, player.actor.x, 0, 0);
    const trade = invoke('GameServer/Bot/TradeService');
    assert.equal(trade.isSellableInventoryItem({ ...seal, fetchEquipped: () => false }), false);

    await discardSeal(player);
    await Quests.onTalk(player, find(NPC.gustav));
    assert.match(player.pages.at(-1), /Replace my lost Seal of Aspiration/);
    const completedAttempt = Ambition.state(player).attempt;
    await event(helper, 'restore_seal');
    assert.equal(count(helper, ITEM.seal), 0);
    await Promise.all([event(player, 'restore_seal'), event(player, 'restore_seal')]);
    assert.equal(count(player, ITEM.seal), 1);
    assert.equal(Ambition.state(player).attempt, completedAttempt);
    assert.equal(player.actor.fetchSp(), reward);
    const [savedLeader] = await Database.execute(['SELECT sp FROM characters WHERE id = ?', [player.actor.fetchId()]], 'test:ambition:restore-sp');
    assert.equal(savedLeader.sp, reward);

    const manager = invoke('GameServer/World/Generics/NpcBypasses/Clan');
    assert.equal((await manager(player, ['clan', 'level-up'])).code, 'not_enough_sp');
    assert.equal(count(player, ITEM.seal), 1);
    player.actor.setSp(cost + 42);
    const results = await Promise.all([manager(player, ['clan', 'level-up']), manager(player, ['clan', 'level-up'])]);
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.equal(player.actor.fetchSp(), 42);
    assert.equal(count(player, ITEM.seal), 0);
    await event(player, 'restore_seal');
    assert.equal(count(player, ITEM.seal), 0);
}

async function activateBot() {
    const life = { phase: 'cold', activity: 'traveling', sp: bot.actor.fetchSp(), characterId: bot.actor.fetchId(),
        accountName: bot.accountId, stats: {} };
    const goalService = invoke('GameServer/Clan/ClanGoalService');
    const actions = invoke('GameServer/Clan/ClanActionService');
    const lifeState = invoke('GameServer/Bot/Population/BotLifeState');
    const population = invoke('GameServer/Bot/Population/PopulationService');
    const pvpRuntime = invoke('GameServer/Bot/Population/PvpEncounterRuntime');
    const strategy = require('../src/GameServer/Clan/ClanStrategyService');
    const projection = await goalService.clanProjectionById(2);
    const { cachedState } = lifeState;
    const { requestActivation } = population;
    const { review } = strategy;
    const now = Date.now;
    let timestamp = now();
    const encounterKey = 'ambition-activation-test';
    const pendingReviews = () => Database.execute(["SELECT id, availableAt FROM clan_actions WHERE clanId = 2 AND actionType = 'goal_plan' AND status = 'pending'"]);
    const activations = [];
    lifeState.cachedState = () => life;
    strategy.review = async () => ({ ok: true, pending: true });
    Date.now = () => timestamp;
    population.requestActivation = async (state, reason) => {
        assert.equal(state, life);
        assert.equal(reason, 'clan_ambition');
        const result = life.activity === 'traveling' || life.stats.pvpEncounter
            ? await requestActivation.call(population, state, reason) : { ok: true };
        activations.push(result.reason || 'ok');
        if (result.ok) life.phase = 'hot';
        return result;
    };
    try {
        await Promise.all([goalService.resolveClan(projection), goalService.resolveClan(projection)]);
        assert.deepEqual(activations, ['in_transit']);
        const retries = await pendingReviews();
        assert.equal(retries.length, 1);
        const [retry] = retries;
        assert(retry.availableAt > timestamp);
        assert.deepEqual(await Database.claimClanActions({ at: retry.availableAt - 1 }), []);
        timestamp = retry.availableAt;
        const [firstRetry] = await Database.claimClanActions({ at: timestamp });
        assert.equal(firstRetry.id, retry.id);
        await actions.resolveAction(firstRetry);
        assert.deepEqual(activations, ['in_transit', 'in_transit']);
        const [nextRetry] = await pendingReviews();
        assert(nextRetry.availableAt > timestamp);
        life.activity = 'hunting';
        timestamp = nextRetry.availableAt;
        life.stats.pvpEncounter = { key: encounterKey, expiresAt: timestamp + 60000 };
        pvpRuntime.pending.add(encounterKey);
        const [pvpRetry] = await Database.claimClanActions({ at: timestamp });
        await actions.resolveAction(pvpRetry);
        assert.deepEqual(activations, ['in_transit', 'in_transit', 'encounter_transition_pending']);
        const afterPvp = await pendingReviews();
        assert.equal(afterPvp.length, 1, 'a busy PvP encounter must leave a durable activation retry');
        assert(afterPvp[0].availableAt > timestamp);

        pvpRuntime.pending.delete(encounterKey);
        delete life.stats.pvpEncounter;
        timestamp = afterPvp[0].availableAt;
        const [ready] = await Database.claimClanActions({ at: timestamp });
        assert.equal(ready?.id, afterPvp[0].id, `expected the queued PvP retry, got ${ready?.actionType}`);
        await actions.resolveAction(ready);
        assert.deepEqual(activations, ['in_transit', 'in_transit', 'encounter_transition_pending', 'ok']);
        assert.deepEqual(await pendingReviews(), []);
    } finally {
        pvpRuntime.pending.delete(encounterKey);
        lifeState.cachedState = cachedState;
        population.requestActivation = requestActivation;
        strategy.review = review;
        Date.now = now;
    }
    await Database.execute(['UPDATE bot_life_state SET phase = ? WHERE characterId = ?', ['hot', bot.actor.fetchId()]], 'test:ambition:hot');
}

async function botPlays() {
    await activateBot();
    const movement = invoke('GameServer/Bot/AI/ClanAllianceQuestAI');
    movement.move = (session, target) => { moveTo(session, target); return true; };
    const pending = [];
    let killed = 0;
    let researched = 0;
    const combat = { executeCombat(session, actor, target) {
        killed++;
        const id = target.fetchSelfId();
        const material = id === MOB.soldier || id === MOB.scout ? (researched++ % 2 ? 0.5 : 0) : 0;
        pending.push(kill(session, target.questSpawn ? target : freshMob(id), material));
    } };
    const settle = async () => {
        await Promise.all(pending.splice(0));
        while (bot.clanAmbitionPending) await new Promise(resolve => setImmediate(resolve));
    };
    let sealLost = false;
    for (let i = 0; i < 150 && Clan.findById(2).level === 4; i++) {
        Bot.tick(bot, bot.actor, {}, combat);
        await settle();
        if (!sealLost && count(bot, ITEM.seal)) {
            sealLost = true;
            await discardSeal(bot);
        }
    }
    assert(sealLost);
    assert(killed >= 50);
    assert.equal(step(bot), 13);
    assert.equal(Clan.findById(2).level, 5);
    assert.equal(bot.actor.fetchSp(), 17);
    assert.equal(count(bot, ITEM.seal), 0);
    const [simulation] = await Database.execute(['SELECT stateJson FROM clan_simulation_clans WHERE clanId = 2'], 'test:ambition:projection');
    assert.equal(JSON.parse(simulation.stateJson).level, 5);
    const [savedBot] = await Database.execute(['SELECT sp FROM bot_life_state WHERE characterId = ?', [bot.actor.fetchId()]], 'test:ambition:bot-sp');
    assert.equal(savedBot.sp, 17);
}

(async () => {
    await seed();
    await play();
    await botPlays();
    const rows = await Database.execute(['SELECT id, level FROM clans ORDER BY id'], 'test:ambition:levels');
    assert.deepEqual(rows.map(({ level }) => level), [5, 5]);
    console.log('Clan Ambition player and bot quest paths passed');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await Database.close();
    fs.rmSync(directory, { recursive: true, force: true });
});
