const C4RecipeItems = invoke('GameServer/Items/C4RecipeItems');
const ServerResponse = invoke('GameServer/Network/Response');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const Item = invoke('GameServer/Item/Item');

// The C4 client can repeat a craft packet while the recipe result dialog is
// still visible. Keep this lock server-side so a single material snapshot can
// never produce more than one item.
const activeCrafters = new Set();

function craftLevelFor(actor, recipe) {
    return recipe.type === 'dwarven'
        ? actor.backpack?.fetchDwarvenCraftLevel?.(actor)
        : actor.backpack?.fetchCommonCraftLevel?.(actor);
}

function hasLearnedRecipe(actor, recipe) {
    return actor.backpack?.fetchRecipeBook?.(actor, recipe.type)
        .some((known) => Number(known.recipeId) === Number(recipe.recipeId));
}

function materialPlan(backpack, materials) {
    const remaining = new Map();
    materials.forEach(({ selfId, amount }) => {
        remaining.set(Number(selfId), (remaining.get(Number(selfId)) || 0) + Number(amount));
    });

    const plan = [];
    for (const [selfId, required] of remaining) {
        let left = required;
        const items = backpack.fetchItems()
            .filter((item) => Number(item.fetchSelfId()) === selfId && !item.fetchEquipped?.());
        for (const item of items) {
            const used = Math.min(left, Number(item.fetchAmount()) || 0);
            if (used > 0) plan.push({ item, amount: used });
            left -= used;
            if (left === 0) break;
        }
        if (left > 0) return null;
    }
    return plan;
}

function sendMakeInfo(session, recipe, status) {
    session.dataSendToMe?.(ServerResponse.recipeItemMakeInfo(
        recipe.recipeId,
        session.actor,
        recipe.type === 'dwarven',
        status
    ));
}

function fail(session, recipe = null) {
    if (recipe) sendMakeInfo(session, recipe, 0);
    session.dataSendToMe?.(ServerResponse.actionFailed());
    return false;
}

function productTemplate(recipe) {
    return DataCache.items?.find((item) => Number(item.selfId) === Number(recipe.productId)) || null;
}

function applyCommittedMaterials(actor, consumed, sources) {
    sources.forEach((source) => {
        const item = consumed.find((entry) => Number(entry.item.fetchId()) === Number(source.id))?.item;
        if (!item) return;
        if (source.amount === 0) {
            actor.backpack.items = actor.backpack.fetchItems().filter((entry) => entry !== item);
        } else {
            item.setAmount(source.amount);
        }
    });
}

function applyCommittedCraft(actor, consumed, product, template, result) {
    applyCommittedMaterials(actor, consumed, result.sources);
    const existing = actor.backpack.fetchItems().find((item) => Number(item.fetchId()) === Number(result.product.id));
    if (existing) {
        existing.setAmount(result.product.amount);
    } else {
        actor.backpack.items.push(new Item(result.product.id, {
            ...utils.crushOb(template),
            amount: product.amount,
            equipped: false,
            slot: product.slot
        }));
    }
}

async function craftSelf(session, recipeId, random = Math.random) {
    const actor = session?.actor;
    const actorId = Number(actor?.fetchId?.());
    const recipe = C4RecipeItems.resolveByRecipeId(recipeId);
    if (!actor || !recipe || actor.isDead?.() || Number(actor.fetchPrivateStoreType?.() || 0) > 0) {
        return fail(session);
    }
    if (!Number.isFinite(actorId) || activeCrafters.has(actorId)) return fail(session, recipe);
    if (!hasLearnedRecipe(actor, recipe) || Number(craftLevelFor(actor, recipe) || 0) < recipe.level) {
        return fail(session, recipe);
    }
    if (Number(actor.fetchMp?.() || 0) < recipe.mpCost) return fail(session, recipe);

    const consumed = materialPlan(actor.backpack, recipe.materials);
    if (!consumed) return fail(session, recipe);

    const template = productTemplate(recipe);
    if (!template) return fail(session, recipe);
    const mp = Number(actor.fetchMp?.() || 0) - recipe.mpCost;
    const product = {
        selfId: recipe.productId,
        name: template.template?.name || '',
        amount: recipe.productCount,
        stackable: !!template.etc?.stackable,
        slot: template.etc?.slot || 0
    };

    activeCrafters.add(actorId);
    try {
        const success = recipe.successRate >= 100 || (Number(random()) * 100) < recipe.successRate;
        const result = await Database.craftInventoryItems(actorId, {
            materials: consumed.map(({ item, amount }) => ({ id: item.fetchId(), selfId: item.fetchSelfId(), amount })),
            product: success ? product : null,
            mp
        });
        if (success) applyCommittedCraft(actor, consumed, product, template, result);
        else applyCommittedMaterials(actor, consumed, result.sources);
        actor.setMp?.(mp);
        actor.statusUpdateVitals?.(actor);
        session.dataSendToMe?.(ServerResponse.itemsList(actor.backpack.fetchItems()));
        sendMakeInfo(session, recipe, success ? 1 : 0);
        return success;
    } catch (error) {
        utils.infoWarn('Crafting', 'craft rejected: %s', error.message || error);
        return fail(session, recipe);
    } finally {
        activeCrafters.delete(actorId);
    }
}

module.exports = {
    craftSelf,
    materialPlan
};
