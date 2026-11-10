'use strict';

// The shared worker wish selects one finite batch. Hot execution only checks
// that selected recipe against live stock, then calls the player's native
// self-craft owner; it never buys inputs or grants a sale/profit here.
const DecisionEvents = require('../AI/DecisionEvents');
const pending = new WeakMap();
function canStart(session, leaf) {
    const actor = session?.actor;
    if (!actor || leaf?.activity !== 'crafting' || !/^resale:\d+$/.test(String(leaf.rootKey))
        || !Number.isSafeInteger(Number(leaf.recipeId)) || Number(leaf.recipeId) <= 0) return false;
    const recipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(Number(leaf.recipeId));
    // A craft refused at the act waits for the decision the refusal raised: the
    // body does not try it again each tick (WealthCraftDecision.refused).
    return !!recipe && Number(recipe.productId) === Number(leaf.rootKey.slice(7))
        && !require('./WealthCraftDecision').refused({ stats: DecisionEvents.statsFor(session) }, recipe.recipeId)
        && !actor.isDead?.() && Number(actor.fetchHp?.()) > 0 && Number(actor.fetchMp?.()) >= Number(recipe.mpCost)
        && Number(actor.fetchPrivateStoreType?.() || 0) === 0 && !actor.state?.fetchHits?.() && !actor.state?.fetchCasts?.()
        && !session.currentTargetId && !session.partyCompanion && !session.followPlayerSession && !session.hotBackgroundPartyId;
}
function review(session, context) {
    const leaf = context?.network?.activity;
    const actor = session?.actor;
    if (!actor || leaf?.activity !== 'crafting' || !/^resale:\d+$/.test(String(leaf.rootKey))
        || !Number.isSafeInteger(Number(leaf.recipeId)) || Number(leaf.recipeId) <= 0) return Promise.resolve({ attempted: false });
    if (pending.has(session)) return pending.get(session);
    if (!canStart(session, leaf)) return Promise.resolve({ attempted: false });
    const work = Promise.resolve().then(async () => {
        const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
        const World = invoke('GameServer/World/World');
        const registered = World.registeredActorById(Number(actor.fetchId()));
        const Craft = invoke('GameServer/Bot/Economy/CraftShopService');
        const recipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(Number(leaf.recipeId));
        if (!recipe || Number(recipe.productId) !== Number(leaf.rootKey.slice(7))) return { attempted: false };
        const liveState = () => ({ ...Economy.stateForActor(actor, session), vitals: {
            hp: Number(actor.fetchHp?.()), mp: Number(actor.fetchMp?.()) } });
        const permitted = state => registered?.actor === actor && registered?.session === session && registered.retired !== true
            && World.registeredActorById(Number(actor.fetchId())) === registered && session.actor === actor
            && actor.fetchIsOnline?.() !== false && !actor.isDead?.() && state.phase === 'hot'
            && state.vitals.hp > 0 && state.vitals.mp >= Number(recipe.mpCost)
            && Number(actor.fetchPrivateStoreType?.() || 0) === 0 && !actor.state?.fetchHits?.() && !actor.state?.fetchCasts?.()
            && !session.currentTargetId && !session.partyCompanion && !session.followPlayerSession
            && !session.hotBackgroundPartyId && !state.party?.partyId && !state.partyId
            && !state.stats?.craftStationId && !/^bot_craft_\d+$/i.test(String(state.accountName || ''))
            && Craft.isServiceCrafter(state) && Craft.canCraft(state, recipe)
            && !(state.stats?.equipmentPlan?.strategy === 'craft'
                && ['active', 'component_ready', 'ready_to_craft'].includes(state.stats.equipmentPlan.status));
        const book = () => actor.backpack?.fetchRecipeBook?.(actor, recipe.type) || [];
        const refusal = {};
        const ready = state => {
            const opportunity = require('./ColdWealthCraftService').recheck(state,
                { recipeId: Number(recipe.recipeId), batches: 1, scroll: [-1] }, book(), refusal);
            // Ready when the basket orders nothing: its owned rows already took the
            // free stock through the one quantity reader (remainingQuantity).
            if (opportunity && opportunity.basket.purchases.length) refusal.reason = 'owned_materials_changed';
            return opportunity && opportunity.basket.purchases.length === 0 ? opportunity : null;
        };
        // A craft refused at the act is not picked again until the next town look
        // (WealthCraftDecision.refusedMark), as a far bot's; short of MP is no fault
        // of the craft. Only a refusal of the decision the body still holds marks it: a
        // newer decision was built on newer facts. The mark is a body key: the near post
        // the rejection raised runs after this turn and carries it.
        const reject = state => {
            if (DecisionEvents.rejectSession(session, accepted, `wealth:${refusal.reason || 'source'}`)
                && refusal.reason !== 'mp_changed') DecisionEvents.replaceStats(session, { ...DecisionEvents.statsFor(session),
                wealthRefused: require('./WealthCraftDecision').refusedMark(state, recipe.recipeId) });
        };
        const packet = context.statsPacket || DecisionEvents.statsFor(session);
        const accepted = { characterId: Number(actor.fetchId()), stats: { decisionSeq: packet.decisionSeq, activityLeaf: packet.activityLeaf,
            wishFocus: packet.wishFocus, wishSections: packet.wishSections } };
        const retirePreparation = () => Economy.forget(Number(actor.fetchId()));
        let state = liveState();
        if (!permitted(state)) return { attempted: false };
        if (!ready(state)) {
            // A withdrawn bid or changed input rejects this accepted work.
            reject(state);
            retirePreparation();
            return { attempted: false };
        }
        let attempted = false;
        try {
            if (!book().some(row => Number(row.recipeId ?? row) === Number(recipe.recipeId))) {
                attempted = true;
                await invoke('GameServer/Bot/Economy/BotWarehouseService').learnActorRecipes(actor, state, session,
                    { recipeIds: [Number(recipe.recipeId)] });
                state = liveState();
                if (!permitted(state)) return { attempted, crafted: false };
                if (!ready(state)) { reject(state); return { attempted, crafted: false }; }
                if (!book().some(row => Number(row.recipeId ?? row) === Number(recipe.recipeId))) return { attempted, crafted: false };
            }
            attempted = true;
            const act = {};
            const crafted = await invoke('GameServer/Crafting/RecipeCrafting').craftSelf(session, Number(recipe.recipeId), Math.random, act);
            if (!crafted && act.refused) { refusal.reason = 'craft_refused'; reject(state); }
            return { attempted, crafted: !!crafted };
        } finally {
            if (attempted) {
                retirePreparation();
            }
        }
    }).finally(() => pending.delete(session));
    pending.set(session, work);
    return work;
}
module.exports = { review, canStart };
