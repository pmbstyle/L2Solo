const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
require('../src/Global');
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const World = invoke('GameServer/World/World');
const Backpack = invoke('GameServer/Actor/Backpack');
const Service = invoke('GameServer/Items/WeaponSAService');
const Catalog = invoke('GameServer/Items/C4WeaponSAExchange');
const WriteQueue = invoke('GameServer/Persistence/CharacterWriteQueue');
const Talk = invoke('GameServer/World/Generics/NpcTalk');
const Bypass = invoke('GameServer/World/Generics/NpcBypasses/WeaponSa');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-sa-exchange-'));
const file = path.join(directory, 'exchange.sqlite');
options.default.Database.path = file;
const template = id => Data.items.find(i => i.selfId === id);
const html = session => session.packets.filter(p => p[0] === 0x0f).at(-1)?.subarray(5).toString('utf16le') || '';
const npcFor = id => ({ fetchId: () => 100000 + id, fetchSelfId: () => id, fetchName: () => 'Smith', fetchTitle: () => '',
    fetchLocX: () => 50, fetchLocY: () => 0, fetchLocZ: () => 0 });
const smith = npcFor(7300), mammon = npcFor(8126), market = npcFor(8092);
function talkTo(session, npc) { session.activeNpcTalk = { selfId: npc.fetchSelfId(), objectId: npc.fetchId() }; }
function makeSession(id) {
    return { packets: [], actor: { fetchId: () => id, fetchName: () => 'SATest', fetchLevel: () => 76,
        fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0, fetchIsOnline: () => true,
        fetchClanId: () => 0, fetchPrivateStoreType: () => 0, isDead: () => false,
        state: { fetchCombats: () => false, fetchHits: () => false, fetchCasts: () => false },
        backpack: new Backpack({ items: [], paperdoll: {} }) },
        dataSendToMe(packet) { this.packets.push(packet); } };
}
async function add(session, selfId, amount = 1, enchant = 0) {
    const data = template(selfId);
    assert(data, `missing template ${selfId}`);
    const result = await Database.setItem(session.actor.fetchId(), { selfId, name: data.template.name, amount, enchant, slot: data.etc.slot || 0 });
    session.actor.backpack.insertItem(Number(result.insertId), selfId, { amount, enchant });
    return session.actor.backpack.fetchItemRaw(Number(result.insertId));
}
async function setup(session, recipe, enchant = 7) {
    await Database.deleteItems(session.actor.fetchId());
    session.actor.backpack.items = [];
    session.packets.length = 0;
    const weapon = await add(session, recipe.sourceId, 1, enchant);
    for (const cost of Catalog.costs(recipe)) await add(session, cost.selfId, cost.amount);
    talkTo(session, recipe.station === 'blacksmith' ? smith : recipe.station === 'mammon' ? mammon : market);
    return weapon;
}
async function apply(session, item, recipe) {
    const token = Service.preview(session, item.fetchId(), recipe.id);
    return Service.exchange(session, token);
}
async function questToWeapon(session) {
    const Quest = invoke('GameServer/Quest/QuestService');
    const Progression = invoke('GameServer/Items/SoulCrystalProgression');
    const Npc = invoke('GameServer/Npc/Npc');
    const Equipment = invoke('GameServer/Items/C4EquipmentItemSkills');
    const Stats = invoke('GameServer/Effects/EffectStats');
    await Database.deleteItems(session.actor.fetchId());
    session.actor.backpack.items = [];
    session.dataSendToMeAndOthers = packet => session.packets.push(packet);
    const actor = session.actor;
    let casting = false, mp = 250;
    actor.state.fetchCasts = () => casting;
    actor.state.setCasts = value => { casting = value; };
    actor.fetchMp = () => mp;
    actor.setMp = value => { mp = value; };
    talkTo(session, npcFor(7194));
    await Quest.onEvent(session, { questId: 350, name: '7194_start' });
    await Quest.onEvent(session, { questId: 350, name: '7194_green' });
    const crystalId = actor.backpack.fetchItemFromSelfId(4640).fetchId();
    const skill = actor.backpack.buildItemSkill(invoke('GameServer/Items/C4ItemSkills').resolve(4640));
    // Drive the real cast-completion callback without waiting on five cast timers.
    let finishCast;
    actor.attack = { queueTimer: fn => { finishCast = fn; } };
    for (let stage = 0; stage < 5; stage++) {
        const target = { fetchId: () => 3000000 + stage, fetchSelfId: () => 625,
            fetchHp: () => 50, fetchMaxHp: () => 100, isDead: () => false,
            fetchAttackable: () => true, fetchLocX: () => 100, fetchLocY: () => 0, fetchLocZ: () => 0,
            addAbsorber: Npc.prototype.addAbsorber, fetchSoulCrystalAbsorber: Npc.prototype.fetchSoulCrystalAbsorber,
            resetSoulCrystalAbsorbers: Npc.prototype.resetSoulCrystalAbsorbers };
        actor.backpack.fetchSelectedNpcTarget = () => target;
        actor.backpack.useDrainSoulItem(session, crystalId, {}, skill);
        assert(casting);
        finishCast();
        assert.equal(target.fetchSoulCrystalAbsorber(actor).crystalItemId, crystalId);
        await Progression.onDeath(session, actor, target, () => 0);
        assert.equal(actor.backpack.fetchItemRaw(crystalId).fetchSelfId(), 4641 + stage);
    }
    assert.equal(mp, 120, 'each successful crystal cast consumes MP');
    const recipe = Catalog.recipes.find(r => r.productId === 4682);
    const weapon = await add(session, recipe.sourceId, 1, 7);
    const weaponId = weapon.fetchId();
    await add(session, 2131, 97);
    talkTo(session, smith);
    await apply(session, weapon, recipe);
    assert.equal(actor.backpack.fetchItemRaw(crystalId), undefined, 'the grown crystal is consumed');
    weapon.setEquipped(true);
    Equipment.sync(actor, actor.backpack.fetchItems());
    assert.equal(Stats.add(actor, 'pCritRateAdd'), 86.7, 'Focus reaches the real stat effect engine');
    weapon.setEquipped(false);
    Equipment.sync(actor, actor.backpack.fetchItems());
    assert.equal(Stats.add(actor, 'pCritRateAdd'), 0);
    const restored = makeSession(actor.fetchId());
    restored.actor.backpack = new Backpack({ items: await Database.fetchItems(actor.fetchId()), paperdoll: {} });
    await Quest.ensureLoaded(restored);
    assert(restored.questStates.get(350).isStarted());
    const restoredWeapon = restored.actor.backpack.fetchItemRaw(weaponId);
    assert.equal(restoredWeapon.fetchSelfId(), 4682);
    assert.equal(restoredWeapon.fetchEnchantLevel(), 7);
    talkTo(restored, mammon);
    await apply(restored, restoredWeapon, Catalog.options(8126, 4682, 'remove')[0]);
    assert.equal(restoredWeapon.fetchSelfId(), 72);
    assert.equal(restoredWeapon.fetchEnchantLevel(), 7);
    restoredWeapon.setEquipped(true);
    Equipment.sync(restored.actor, restored.actor.backpack.fetchItems());
    assert.equal(Stats.add(restored.actor, 'pCritRateAdd'), 0, 'removed SA cannot return on equip');
    assert.equal(restored.actor.backpack.fetchItems().length, 1);
}
async function run() {
    const seed = new DatabaseSync(file);
    seed.exec(fs.readFileSync('database/sql/sqlite.sql', 'utf8'));
    seed.exec("INSERT INTO accounts(username,password) VALUES ('sa_test','test')");
    for (let id = 1; id <= 2; id++) seed.prepare(`INSERT INTO characters(id,username,name,classId,race,level,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ)
        VALUES (?,'sa_test',?,0,0,76,500,250,0,0,0,0,0,0,0)`).run(id, `SATest${id}`);
    seed.close();
    Database.init(); Data.init();
    const a = makeSession(1), b = makeSession(2);
    World.user = { sessions: [a, b] }; World.npc = { spawns: [smith, mammon, market] };
    const installs = Catalog.recipes.filter(r => r.operation === 'install');
    assert.equal(installs.length, 328);
    assert.equal(Catalog.recipes.filter(r => r.station === 'mammon' && r.operation === 'remove').length, 352);
    for (const recipe of Catalog.recipes) {
        assert(template(recipe.sourceId) && template(recipe.productId));
        for (const cost of recipe.costs) assert(template(cost.selfId) && Number.isSafeInteger(cost.amount) && cost.amount > 0);
        if (recipe.operation === 'install' && recipe.station === 'mammon') {
            assert.equal(Catalog.costs(recipe).length, 1, 'A/S installation requires only its Soul Crystal');
            assert(invoke('GameServer/Items/SoulCrystalProgression').crystalIds.includes(Catalog.costs(recipe)[0].selfId));
        } else {
            assert.deepEqual(Catalog.costs(recipe), recipe.costs, 'C/B installation and removal keep their sourced costs');
        }
    }
    // Every installable variant must round-trip with its exact enchanted instance.
    for (const [index, recipe] of installs.entries()) {
        for (const stat of ['pAtk', 'mAtk', 'pAtkRnd', 'crit', 'atkSpd', 'accur']) {
            assert.equal(template(recipe.productId).stats[stat], template(recipe.sourceId).stats[stat],
                `${recipe.id}: installing SA must not change base ${stat}`);
        }
        for (const stat of ['mp', 'soulshot', 'spiritshot', 'slot', 'rank', 'cristals']) {
            assert.equal(template(recipe.productId).etc[stat], template(recipe.sourceId).etc[stat],
                `${recipe.id}: installing SA must not change base ${stat}`);
        }
        const enchant = [0, 3, 7, 16][index % 4];
        const item = await setup(a, recipe, enchant);
        const id = item.fetchId();
        await apply(a, item, recipe);
        assert.equal(item.fetchSelfId(), recipe.productId);
        assert.equal(item.fetchEnchantLevel(), enchant);
        assert.equal(a.actor.backpack.fetchItems().length, 1, 'exact recipe costs consumed');
        assert.equal((await Database.fetchItems(1))[0].enchant, enchant);
        const removal = Catalog.options(8126, recipe.productId, 'remove')[0];
        assert.equal(removal.productId, recipe.sourceId);
        talkTo(a, mammon);
        await apply(a, item, removal);
        assert.equal(item.fetchId(), id);
        assert.equal(item.fetchSelfId(), recipe.sourceId);
        assert.equal(item.fetchEnchantLevel(), enchant);
        assert.equal(a.actor.backpack.fetchItems().length, 1, 'removal never refunds a crystal or gemstones');
    }
    // Waived ingredients must be absent from the preview and remain untouched
    // even if the player already owns them. The crystal is still mandatory.
    for (const grade of ['a', 's']) {
        const highRecipe = installs.find(r => template(r.sourceId).etc.rank === grade);
        const weapon = await setup(a, highRecipe, 16);
        const crystal = a.actor.backpack.fetchItemFromSelfId(Catalog.costs(highRecipe)[0].selfId);
        for (const selfId of [2133, 2134, 5575]) await add(a, selfId, 123);
        const token = Service.preview(a, weapon.fetchId(), highRecipe.id);
        assert.doesNotMatch(html(a), /Gemstone [AS]|Ancient Adena/);
        assert.match(html(a), /Soul Crystal/);
        await Service.exchange(a, token);
        assert.equal(weapon.fetchEnchantLevel(), 16);
        assert.equal(a.actor.backpack.fetchItemRaw(crystal.fetchId()), undefined);
        const rows = await Database.fetchItems(1);
        for (const selfId of [2133, 2134, 5575]) {
            assert.equal(a.actor.backpack.fetchItemFromSelfId(selfId).fetchAmount(), 123);
            assert.equal(rows.find(row => row.selfId === selfId).amount, 123);
        }
        const unenhanced = await add(a, highRecipe.sourceId, 1, 7);
        await assert.rejects(apply(a, unenhanced, highRecipe), /missing_materials/);
        assert.equal(unenhanced.fetchSelfId(), highRecipe.sourceId);
    }
    const recipe = Catalog.recipes.find(r => r.id === '1005:1');
    assert.deepEqual(recipe.costs, [{ selfId: 4634, amount: 1 }, { selfId: 2131, amount: 97 }]);
    assert.equal(recipe.taxBase, 291000, 'Adena field is a tax base, not a fixed service fee');
    let item = await setup(a, recipe, 16);
    const other = await add(a, recipe.sourceId, 1, 3);
    Service.menu(a);
    assert.match(html(a), /\+16 Stormbringer/);
    const token = Service.preview(a, item.fetchId(), recipe.id);
    assert.match(html(a), /97 × Gemstone C/);
    assert.match(html(a), /Enchantment \+16 is preserved/);
    const results = await Promise.allSettled([Service.exchange(a, token), Service.exchange(a, token)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(other.fetchSelfId(), 72); assert.equal(other.fetchEnchantLevel(), 3);
    const saved = await Database.fetchItems(1);
    assert.equal(saved.find(r => r.id === item.fetchId()).enchant, 16);
    assert.equal(saved.find(r => r.id === other.fetchId()).selfId, 72, 'same-name weapon untouched');
    await assert.rejects(Service.exchange(a, token), /Open the weapon exchange/);
    const restored = new Backpack({ items: saved, paperdoll: {} });
    assert.equal(restored.fetchItemRaw(item.fetchId()).fetchEnchantLevel(), 16, 'reload keeps enchant');

    // Missing/wrong materials cannot consume a partial payment.
    for (const missing of [4634, 2131]) {
        item = await setup(a, recipe);
        const material = a.actor.backpack.fetchItemFromSelfId(missing);
        await Database.deleteItem(1, material.fetchId());
        a.actor.backpack.items = a.actor.backpack.items.filter(i => i !== material);
        await add(a, missing === 4634 ? 4645 : 2132, 200);
        const before = await Database.fetchItems(1);
        await assert.rejects(apply(a, item, recipe), /missing_materials/);
        assert.deepEqual(await Database.fetchItems(1), before);
    }
    // A failure after ingredient writes rolls back both payment and weapon.
    item = await setup(a, recipe);
    const inspect = new DatabaseSync(file);
    inspect.exec(`CREATE TRIGGER reject_sa BEFORE UPDATE OF selfId ON items WHEN NEW.selfId = 4681 BEGIN SELECT RAISE(ABORT, 'SA rollback probe'); END`);
    const before = await Database.fetchItems(1);
    await assert.rejects(apply(a, item, recipe), /SA rollback probe/);
    assert.deepEqual(await Database.fetchItems(1), before);
    assert.equal(item.fetchSelfId(), 72); assert.equal(item.fetchEnchantLevel(), 7);
    assert.equal(a.actor.backpack.fetchItemFromSelfId(4634).fetchAmount(), 1);
    inspect.exec('DROP TRIGGER reject_sa'); inspect.close();

    const blocked = [
        [() => { item.setEquipped(true); }, () => { item.setEquipped(false); }],
        [() => { a.activeTrade = {}; }, () => { delete a.activeTrade; }],
        [() => { a.actor.fetchPrivateStoreType = () => 1; }, () => { a.actor.fetchPrivateStoreType = () => 0; }],
        [() => { a.actor.fetchLocX = () => 1000; }, () => { a.actor.fetchLocX = () => 0; }],
        [() => { a.actor.state.fetchCombats = () => true; }, () => { a.actor.state.fetchCombats = () => false; }],
        [() => { a.activeEnchantItem = {}; }, () => { delete a.activeEnchantItem; }],
        [() => { a.actor.fetchIsOnline = () => false; }, () => { a.actor.fetchIsOnline = () => true; }]
    ];
    for (const [block, unblock] of blocked) {
        const quote = Service.preview(a, item.fetchId(), recipe.id);
        block(); await assert.rejects(Service.exchange(a, quote)); unblock();
        assert.equal(item.fetchSelfId(), 72);
    }
    const quote = Service.preview(a, item.fetchId(), recipe.id);
    item.setEnchantLevel(8);
    await assert.rejects(Service.exchange(a, quote), /changed/);
    item.setEnchantLevel(7);
    const staleQuote = Service.preview(a, item.fetchId(), recipe.id);
    await Database.updateItemEnchantLevel(1, item.fetchId(), 9);
    await assert.rejects(Service.exchange(a, staleQuote), /source_changed/);
    assert.equal(a.actor.backpack.fetchItemFromSelfId(4634).fetchAmount(), 1);
    await Database.updateItemEnchantLevel(1, item.fetchId(), 7);
    talkTo(a, mammon);
    assert.throws(() => Service.preview(a, item.fetchId(), recipe.id), /cannot be exchanged/);
    talkTo(b, smith);
    assert.throws(() => Service.preview(b, item.fetchId(), recipe.id), /cannot be exchanged/);

    // Delayed database work revalidates range and the current character.
    talkTo(a, smith);
    const originalExchange = Database.exchangeWeaponSA;
    for (const mode of ['distance', 'character']) {
        let proceed;
        Database.exchangeWeaponSA = async (...args) => { await new Promise(resolve => { proceed = resolve; }); return originalExchange.apply(Database, args); };
        const pending = apply(a, item, recipe);
        const actor = a.actor;
        if (mode === 'distance') actor.fetchLocX = () => 1000;
        else a.actor = b.actor;
        proceed(); await assert.rejects(pending);
        a.actor = actor; actor.fetchLocX = () => 0;
        assert.equal(item.fetchSelfId(), 72);
    }
    Database.exchangeWeaponSA = originalExchange;

    // Split stacks and more than one crystal: installation consumes only one.
    item = await setup(a, recipe);
    const gems = a.actor.backpack.fetchItemFromSelfId(2131);
    gems.setAmount(50); WriteQueue.itemAmount(1, gems.fetchId(), 50);
    await add(a, 2131, 60); await add(a, 4634);
    await apply(a, item, recipe);
    assert.equal(a.actor.backpack.fetchItems().filter(i => i.fetchSelfId() === 2131).reduce((n,i) => n+i.fetchAmount(), 0), 13);
    assert.equal(a.actor.backpack.fetchItems().filter(i => i.fetchSelfId() === 4634).length, 1);

    const paidRemoval = Catalog.options(8092, 4681, 'remove')[0];
    assert.deepEqual(paidRemoval.costs, [{ selfId: 5575, amount: 14550 }]);
    talkTo(a, market);
    await assert.rejects(apply(a, item, paidRemoval), /missing_materials/);
    await add(a, 5575, 15000);
    await apply(a, item, paidRemoval);
    assert.equal(item.fetchSelfId(), 72); assert.equal(item.fetchEnchantLevel(), 7);
    assert.equal(a.actor.backpack.fetchItemFromSelfId(5575).fetchAmount(), 450);

    // Dialog entry points preserve Mammon unsealing and existing quest links.
    for (const npc of [smith, mammon, market]) {
        Talk(a, npc);
        assert.match(html(a), /weapon-sa menu/);
        if (npc === smith) assert.doesNotMatch(html(a), /not on a quest/);
        if (npc === mammon) assert.match(html(a), /Unsealing is free/);
    }
    item = await setup(a, recipe, 16);
    await Bypass(a, ['weapon-sa', 'preview', String(item.fetchId()), recipe.id]);
    await Bypass(a, ['weapon-sa', 'apply', a.activeWeaponSA.token]);
    assert.match(html(a), /installed.*Enchantment \+16 preserved/);
    assert.equal(item.fetchSelfId(), 4681);
    await questToWeapon(a);
    console.log('Weapon SA exchange: 328 enchanted round trips, all 978 recipes, selected instance, costs, rollback, replay, NPC/ownership guards and dialogs passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await WriteQueue.flushAll(); await Database.close(); fs.rmSync(directory, { recursive: true, force: true });
});
