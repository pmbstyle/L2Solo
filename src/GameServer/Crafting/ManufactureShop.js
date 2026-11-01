const ItemTemplateIndex = require('../Item/ItemTemplateIndex');
const C4RecipeItems = invoke('GameServer/Items/C4RecipeItems');
const ServerResponse = invoke('GameServer/Network/Response');
const Database = invoke('Database');
const CharacterWriteQueue = invoke('GameServer/Persistence/CharacterWriteQueue');
const DataCache = invoke('GameServer/DataCache');
const Item = invoke('GameServer/Item/Item');
const { materialPlan } = invoke('GameServer/Crafting/CraftMaterials');
const CraftWorkshopService = invoke('GameServer/Bot/Economy/CraftWorkshopService');
const World = invoke('GameServer/World/World');
const PrivateStoreTrade = invoke('GameServer/PrivateStoreTrade');

const MANUFACTURE = 5;
const MANUFACTURE_MANAGE = 6;
const MAX_RECIPES = 100;
const activeCrafters = new Set();

function isPublicCraftStation(session) {
    return /^bot_craft_\d+$/i.test(String(session?.accountId || ''));
}

function shop(actor) {
    const store = actor.model || actor;
    if (!store.manufactureShop) store.manufactureShop = { type: 'dwarven', title: '', entries: [] };
    if (!store.manufactureShop.type) store.manufactureShop.type = 'dwarven';
    return store.manufactureShop;
}

function knownRecipe(actor, recipeId, type) {
    const recipe = C4RecipeItems.resolveByRecipeId(recipeId);
    return recipe?.type === type && actor.backpack?.fetchRecipeBook?.(actor, type)
        .some((entry) => Number(entry.recipeId) === Number(recipeId)) ? recipe : null;
}

function craftLevel(actor, type) {
    return type === 'dwarven'
        ? Number(actor.backpack?.fetchDwarvenCraftLevel?.(actor) || 0)
        : Number(actor.backpack?.fetchCommonCraftLevel?.(actor) || 0);
}

function productTemplate(recipe) {
    return ItemTemplateIndex.find(DataCache.items, recipe.productId) || null;
}

function applyMaterials(actor, consumed, sources) {
    sources.forEach((source) => {
        const item = consumed.find((entry) => Number(entry.item.fetchId()) === Number(source.id))?.item;
        if (!item) return;
        if (source.amount === 0) actor.backpack.items = actor.backpack.fetchItems().filter((entry) => entry !== item);
        else item.setAmount(source.amount);
    });
}

function applyItem(actor, id, amount, data) {
    const item = actor.backpack.fetchItems().find((entry) => Number(entry.fetchId()) === Number(id));
    if (item) item.setAmount(amount);
    else actor.backpack.items.push(new Item(id, data));
}

function applyAdena(actor, result) {
    if (!result) return;
    const item = actor.backpack.fetchItems().find((entry) => Number(entry.fetchSelfId()) === 57);
    if (item) {
        item.setAmount(result.amount);
        return;
    }
    const template = ItemTemplateIndex.find(DataCache.items, 57);
    if (template) actor.backpack.items.push(new Item(result.id, {
        ...utils.crushOb(template), amount: result.amount, equipped: false, slot: 0
    }));
}

function distanceAllows(customer, crafter) {
    const dx = Number(customer?.fetchLocX?.()) - Number(crafter?.fetchLocX?.());
    const dy = Number(customer?.fetchLocY?.()) - Number(crafter?.fetchLocY?.());
    return Number.isFinite(dx) && Number.isFinite(dy) && ((dx * dx) + (dy * dy)) <= (150 * 150);
}

function findSession(id) {
    const BotManager = invoke('GameServer/Bot/BotManager');
    return BotManager.findSessionById?.(id) || (World.user?.sessions || []).find((session) => (
        Number(session.actor?.fetchId?.()) === Number(id)
    )) || null;
}

function broadcastState(session, actor) {
    session.dataSendToMe?.(ServerResponse.userInfo(actor));
    session.dataSendToOthers?.(ServerResponse.charInfo(actor), actor);
}

function open(session, type = 'dwarven') {
    const actor = session?.actor;
    const recipeType = type === 'common' ? 'common' : 'dwarven';
    if (!actor || actor.isDead?.()) return false;
    shop(actor).type = recipeType;
    actor.setPrivateStoreType(MANUFACTURE_MANAGE);
    actor.state?.setSeated?.(false);
    session.dataSendToMeAndOthers?.(ServerResponse.sitAndStand(actor), actor);
    broadcastState(session, actor);
    session.dataSendToMe(ServerResponse.recipeShopManageList(actor));
    return true;
}

function title(session, value) {
    const actor = session?.actor;
    if (!actor || Number(actor.fetchPrivateStoreType?.()) !== MANUFACTURE_MANAGE) return false;
    shop(actor).title = String(value || '').slice(0, 52);
    return true;
}

function publish(session, entries) {
    const actor = session?.actor;
    if (!actor || Number(actor.fetchPrivateStoreType?.()) !== MANUFACTURE_MANAGE || !Array.isArray(entries) || entries.length > MAX_RECIPES) return false;
    const seen = new Set();
    const valid = entries.map((entry) => ({ recipeId: Number(entry.recipeId), price: Number(entry.price) }))
        .every((entry) => Number.isSafeInteger(entry.recipeId) && Number.isSafeInteger(entry.price) && entry.price >= 0 &&
            !seen.has(entry.recipeId) && (seen.add(entry.recipeId) || true) && knownRecipe(actor, entry.recipeId, shop(actor).type));
    if (!valid || entries.length === 0) return false;
    shop(actor).entries = entries.map((entry) => ({ recipeId: Number(entry.recipeId), price: Number(entry.price) }));
    actor.setPrivateStoreType(MANUFACTURE);
    actor.state?.setSeated?.(true);
    session.dataSendToMeAndOthers?.(ServerResponse.sitAndStand(actor), actor);
    broadcastState(session, actor);
    session.dataSendToMeAndOthers?.(ServerResponse.recipeShopMsg(actor), actor);
    CraftWorkshopService.registerPlayer(session);
    return true;
}

function makeInfo(session, crafterId, recipeId) {
    const crafterSession = findSession(crafterId);
    const crafter = crafterSession?.actor;
    const recipe = C4RecipeItems.resolveByRecipeId(recipeId);
    const entry = shop(crafter || {}).entries.find((candidate) => Number(candidate.recipeId) === Number(recipeId));
    if (!crafter || !recipe || !entry || Number(crafter.fetchPrivateStoreType?.()) !== MANUFACTURE || !distanceAllows(session?.actor, crafter)) {
        session?.dataSendToMe?.(ServerResponse.actionFailed());
        return false;
    }
    session.dataSendToMe?.(ServerResponse.recipeShopItemInfo(crafter, recipe.recipeId, -1));
    return true;
}

function previous(session) {
    const customer = session?.actor;
    const crafter = session?.viewedPrivateStoreSeller;
    if (!customer || !crafter || Number(crafter.fetchPrivateStoreType?.()) !== MANUFACTURE || !distanceAllows(customer, crafter)) {
        session?.dataSendToMe?.(ServerResponse.actionFailed());
        return false;
    }
    session.dataSendToMe?.(ServerResponse.recipeShopSellList(crafter, customer));
    return true;
}

async function craft(session, crafterId, recipeId, random = Math.random, order = {}) {
    const customer = session?.actor;
    const crafterSession = findSession(crafterId);
    const crafter = crafterSession?.actor;
    const recipe = C4RecipeItems.resolveByRecipeId(recipeId);
    const entry = shop(crafter || {}).entries.find((candidate) => Number(candidate.recipeId) === Number(recipeId));
    const customerId = Number(customer?.fetchId?.());
    const actorId = Number(crafter?.fetchId?.());
    const publicStation = isPublicCraftStation(crafterSession);
    const fail = () => {
        if (crafter && recipe) session?.dataSendToMe?.(ServerResponse.recipeShopItemInfo(crafter, recipe.recipeId, 0));
        session?.dataSendToMe?.(ServerResponse.actionFailed());
        return false;
    };
    if (!customer || !crafter || customer === crafter || !recipe || !entry || customer.isDead?.() || crafter.isDead?.() ||
        Number(customer.fetchPrivateStoreType?.() || 0) !== 0 ||
        Number(crafter.fetchPrivateStoreType?.()) !== MANUFACTURE || recipe.type !== shop(crafter).type ||
        !knownRecipe(crafter, recipe.recipeId, recipe.type) || craftLevel(crafter, recipe.type) < recipe.level ||
        (!publicStation && Number(crafter.fetchMp?.() || 0) < recipe.mpCost) || !distanceAllows(customer, crafter) ||
        !Number.isSafeInteger(customerId) || !Number.isSafeInteger(actorId) || activeCrafters.has(actorId)) return fail();

    const batches = order.batches ?? 1;
    if (!Number.isSafeInteger(batches) || batches < 1 || batches > 64) return fail();
    if (order.botOrder && recipe.successRate < 100 && batches !== 1) return fail();
    const inputs = publicStation ? require('./StationRecipe').forStation(recipe) : recipe;
    const consumed = materialPlan(customer.backpack, inputs.materials.map(row => ({ ...row, amount: row.amount * batches })));
    const template = productTemplate(recipe);
    if (!consumed || !template) return fail();
    const unitPrice = Number(entry.price), price = unitPrice * batches;
    if (!Number.isSafeInteger(price) || price < 0 || Number(customer.backpack.fetchTotalAdena?.() || 0) < price) return fail();

    const product = {
        selfId: recipe.productId,
        name: template.template?.name || '',
        amount: recipe.productCount * batches,
        stackable: !!template.etc?.stackable,
        slot: template.etc?.slot || 0
    };
    const crafterMp = publicStation ? Number(crafter.fetchMp()) : Number(crafter.fetchMp()) - recipe.mpCost * batches;
    const validate = () => {
        if (session.actor !== customer || crafterSession.actor !== crafter || findSession(actorId) !== crafterSession
            || order.botOrder && !(World.user?.sessions || []).includes(session)
            || customer.isDead?.() || crafter.isDead?.() || customer.fetchIsOnline?.() === false || crafter.fetchIsOnline?.() === false
            || Number(crafter.fetchPrivateStoreType?.()) !== MANUFACTURE || Number(customer.fetchPrivateStoreType?.() || 0) !== 0
            || !shop(crafter).entries.includes(entry) || Number(entry.price) !== unitPrice
            || order.expectedPrice != null && Number(order.expectedPrice) !== unitPrice
            || !knownRecipe(crafter, recipe.recipeId, recipe.type) || craftLevel(crafter, recipe.type) < recipe.level
            || !distanceAllows(customer, crafter) || !publicStation && Number(crafter.fetchMp()) < recipe.mpCost * batches)
            throw Error('player_workshop_changed');
        return { crafterMp: Number(crafter.fetchMp()) - (publicStation ? 0 : recipe.mpCost * batches) };
    };
    let committed;
    activeCrafters.add(actorId);
    try {
        await Promise.all([CharacterWriteQueue.flushCharacter(actorId), CharacterWriteQueue.flushCharacter(customerId)]);
        validate();
        const success = order.botOrder || recipe.successRate >= 100 || (Number(random()) * 100) < recipe.successRate;
        const result = await Database.craftForCustomer(actorId, customerId, {
            materials: consumed.map(({ item, amount }) => ({ id: item.fetchId(), selfId: item.fetchSelfId(), amount })),
            product: success ? product : null,
            crafterMp,
            price,
            adena: { name: 'Adena' }, validate,
            economyCommand: order.economyCommand, funding: order.funding,
            liveWorkshop: order.botOrder ? { recipeId: recipe.recipeId, batches, unitPrice, publicStation } : null,
            fundingPacket: order.botOrder ? () => session.coldLifeState?.stats?.money : null, random
        });
        committed = { ...result, committed: true, success: result.success ?? success };
        crafter.setMp?.(result.crafterMp ?? crafterMp);
        applyMaterials(customer, consumed, result.sources);
        if (committed.success) applyItem(customer, result.product.id, result.product.amount, {
            ...utils.crushOb(template), amount: product.amount, equipped: false, slot: product.slot
        });
        applyAdena(customer, result.customerAdena);
        applyAdena(crafter, result.crafterAdena);
        customer.statusUpdateVitals?.(customer);
        crafter.statusUpdateVitals?.(crafter);
        crafter.automation?.replenishVitals?.(crafter);
        session.dataSendToMe?.(ServerResponse.itemsList(customer.backpack.fetchItems()));
        crafterSession?.dataSendToMe?.(ServerResponse.itemsList(crafter.backpack.fetchItems()));
        session.dataSendToMe?.(ServerResponse.recipeShopItemInfo(crafter, recipe.recipeId, committed.success ? 1 : 0));
        if (order.botOrder && session.coldLifeState) {
            PrivateStoreTrade.syncInventory(session, customer, await Database.fetchItems(customerId), price,
                { ...order.funding, itemId: recipe.productId });
        }
        return order.botOrder ? committed : committed.success;
    } catch (error) {
        if (committed) {
            utils.infoWarn('Crafting', 'presentation after committed manufacture: %s', error.message);
            return order.botOrder ? committed : committed.success;
        }
        utils.infoWarn('Crafting', 'manufacture rejected: %s', error.message || error);
        return fail();
    } finally {
        activeCrafters.delete(actorId);
    }
}

module.exports = { MANUFACTURE, MANUFACTURE_MANAGE, shop, open, title, publish, makeInfo, previous, craft };
