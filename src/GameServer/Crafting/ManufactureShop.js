const C4RecipeItems = invoke('GameServer/Items/C4RecipeItems');
const ServerResponse = invoke('GameServer/Network/Response');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const Item = invoke('GameServer/Item/Item');
const { materialPlan } = invoke('GameServer/Crafting/CraftMaterials');

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
    return DataCache.items?.find((item) => Number(item.selfId) === Number(recipe.productId)) || null;
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
    const template = DataCache.items?.find((entry) => Number(entry.selfId) === 57);
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
    const World = invoke('GameServer/World/World');
    return BotManager.findSessionById?.(id) || (World.user?.sessions || []).find((session) => (
        Number(session.actor?.fetchId?.()) === Number(id)
    )) || null;
}

function broadcastState(session, actor) {
    session.dataSendToMeAndOthers?.(ServerResponse.userInfo(actor), actor);
    session.dataSendToMeAndOthers?.(ServerResponse.charInfo(actor), actor);
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

async function craft(session, crafterId, recipeId, random = Math.random) {
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

    const consumed = materialPlan(customer.backpack, recipe.materials);
    const template = productTemplate(recipe);
    if (!consumed || !template) return fail();
    const price = Number(entry.price);
    if (!Number.isSafeInteger(price) || price < 0 || Number(customer.backpack.fetchTotalAdena?.() || 0) < price) return fail();

    const product = {
        selfId: recipe.productId,
        name: template.template?.name || '',
        amount: recipe.productCount,
        stackable: !!template.etc?.stackable,
        slot: template.etc?.slot || 0
    };
    const crafterMp = publicStation ? Number(crafter.fetchMp()) : Number(crafter.fetchMp()) - recipe.mpCost;
    activeCrafters.add(actorId);
    try {
        const success = recipe.successRate >= 100 || (Number(random()) * 100) < recipe.successRate;
        const result = await Database.craftForCustomer(actorId, customerId, {
            materials: consumed.map(({ item, amount }) => ({ id: item.fetchId(), selfId: item.fetchSelfId(), amount })),
            product: success ? product : null,
            crafterMp,
            price,
            adena: { name: 'Adena' }
        });
        applyMaterials(customer, consumed, result.sources);
        if (success) applyItem(customer, result.product.id, result.product.amount, {
            ...utils.crushOb(template), amount: product.amount, equipped: false, slot: product.slot
        });
        applyAdena(customer, result.customerAdena);
        applyAdena(crafter, result.crafterAdena);
        crafter.setMp?.(crafterMp);
        customer.statusUpdateVitals?.(customer);
        crafter.statusUpdateVitals?.(crafter);
        crafter.automation?.replenishVitals?.(crafter);
        session.dataSendToMe?.(ServerResponse.itemsList(customer.backpack.fetchItems()));
        crafterSession?.dataSendToMe?.(ServerResponse.itemsList(crafter.backpack.fetchItems()));
        session.dataSendToMe?.(ServerResponse.recipeShopItemInfo(crafter, recipe.recipeId, success ? 1 : 0));
        return success;
    } catch (error) {
        utils.infoWarn('Crafting', 'manufacture rejected: %s', error.message || error);
        return fail();
    } finally {
        activeCrafters.delete(actorId);
    }
}

module.exports = { MANUFACTURE, MANUFACTURE_MANAGE, shop, open, title, publish, makeInfo, previous, craft };
