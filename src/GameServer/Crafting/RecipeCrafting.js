const ItemTemplateIndex = require('../Item/ItemTemplateIndex');
const C4RecipeItems = invoke('GameServer/Items/C4RecipeItems');
const ServerResponse = invoke('GameServer/Network/Response');
const Database = invoke('Database');
const CharacterWriteQueue = invoke('GameServer/Persistence/CharacterWriteQueue');
const DataCache = invoke('GameServer/DataCache');
const Item = invoke('GameServer/Item/Item');
const { materialPlan } = invoke('GameServer/Crafting/CraftMaterials');

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
    return ItemTemplateIndex.find(DataCache.items, recipe.productId) || null;
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

async function craftSelf(session, recipeId, random = Math.random, options = {}) {
    const actor = session?.actor;
    const actorId = Number(actor?.fetchId?.());
    const recipe = C4RecipeItems.resolveByRecipeId(recipeId);
    if (!actor || !recipe || (!options.economyCommand && (actor.isDead?.() || Number(actor.fetchPrivateStoreType?.() || 0) > 0))) {
        return fail(session);
    }
    if (!Number.isFinite(actorId) || activeCrafters.has(actorId)) return fail(session, recipe);
    if (!options.economyCommand && (!hasLearnedRecipe(actor, recipe) || Number(craftLevelFor(actor, recipe) || 0) < recipe.level)) {
        return fail(session, recipe);
    }
    if (!options.economyCommand && Number(actor.fetchMp?.() || 0) < recipe.mpCost) return fail(session, recipe);

    const consumed = materialPlan(actor.backpack, recipe.materials);
    if (!consumed && !options.economyCommand) return fail(session, recipe);

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
    const bot = session.botSession === true || session.constructor?.name === 'BotSession'
        || String(session.accountId || '').startsWith('bot_');
    const Commit = require('../Bot/Economy/EconomyCommit');
    let command = null, committed = null;
    try {
        await CharacterWriteQueue.flushCharacter(actorId);
        if (bot) {
            const state = invoke('GameServer/Bot/Population/BotLifeState').cachedState(actorId);
            if (!state) throw Error('economy_owner_missing');
            const admitted = await Commit.admit(state, Commit.KINDS.craft, options.economyCommand);
            command = admitted.command;
            if (Object.isExtensible(options)) options.economyCommand = command;
        }
        const drawn = bot ? true : recipe.successRate >= 100 || (Number(random()) * 100) < recipe.successRate;
        const result = await Database.craftInventoryItems(actorId, {
            materials: (consumed || []).map(({ item, amount }) => ({ id: item.fetchId(), selfId: item.fetchSelfId(), amount })),
            product: drawn ? product : null, mp, economyCommand: command,
            recipeId: bot ? recipe.recipeId : 0, random,
            validate: bot ? () => {
                const registered = invoke('GameServer/World/World').registeredActorById(actorId);
                if (registered?.session !== session || registered?.actor !== actor || session.actor !== actor
                    || actor.isDead?.() || Number(actor.fetchPrivateStoreType?.() || 0) > 0
                    || !hasLearnedRecipe(actor, recipe) || Number(craftLevelFor(actor, recipe)) < recipe.level) throw Error('craft_actor_changed');
            } : null
        });
        committed = result;
        const success = bot ? result.success : drawn;
        if (result.coldLifeRow) Commit.acceptRow(result.coldLifeRow);
        if (result.replayed) {
            const rows = await Database.fetchItems(actorId);
            actor.backpack.items = rows.map(row => {
                const data = ItemTemplateIndex.find(DataCache.items, Number(row.selfId));
                return new Item(row.id, { ...utils.crushOb(data || {}), amount: row.amount,
                    enchant: row.enchant, equipped: !!row.equipped, slot: row.slot });
            });
        } else if (success) applyCommittedCraft(actor, consumed, product, template, result);
        else applyCommittedMaterials(actor, consumed, result.sources);
        if (!result.replayed) actor.setMp?.(Number(result.mp ?? mp));
        actor.statusUpdateVitals?.(actor);
        actor.automation?.replenishVitals?.(actor);
        session.dataSendToMe?.(ServerResponse.itemsList(actor.backpack.fetchItems()));
        sendMakeInfo(session, recipe, success ? 1 : 0);
        return success;
    } catch (error) {
        utils.infoWarn('Crafting', 'craft rejected: %s', error.message || error);
        if (committed?.committed) return !!committed.success;
        return fail(session, recipe);
    } finally {
        Commit.finish(actorId, command);
        activeCrafters.delete(actorId);
    }
}

module.exports = {
    craftSelf,
    materialPlan
};
