'use strict';

const { offerFields } = require('../../AfkTrade/BoardIndex');
const SHOT_RECIPES = Object.freeze([20, 21, 22, 23, 24, 317, 318, 319, 320, 321, 323, 324, 325, 326, 327]);
const CRYSTALS = Object.freeze({ d: 1458, c: 1459, b: 1460, a: 1461, s: 1462 });
const positive = value => Math.max(0, Number(value) || 0);

// Only public indexed lines enter a seller's view. Lifecycle updates need
// no second foreign inventory/wish/level/wallet store or sorted holder vector.
class ShotMarketIndex {
    constructor(options = {}) {
        this.itemTemplates = options.itemTemplates instanceof Map ? options.itemTemplates
            : new Map((options.itemTemplates || []).map(item => [Number(item.selfId), item]));
        this.shotIds = [...new Set((options.shotProductIds || []).map(Number))];
        this.recipeIds = [...new Set((options.shotRecipeItemIds || []).map(Number))];
        this.board = options.board || (() => null);
        this.npcOffers = options.npcOffers || (() => []);
        this.stockFor = options.stockFor || (() => ({}));
        this.shotDemand = new Map(this.shotIds.map(id => [id, []]));
        this.recipeHolders = new Map(this.recipeIds.map(id => [id, []]));
        this.shotSupply = new Map(); this.shotMinPrice = new Map(); this.recipeStock = new Map();
        this.npcPrice = new Map(); this.npcSources = new Map(); this.gear = new Map(); this.boardCache = new Map();
        this.npcSource = null; this.activeBoard = null;
        this.gearIds = [];
        for (const [id, item] of this.itemTemplates) {
            if (CRYSTALS[String(item?.etc?.rank || '').toLowerCase()] && Number(item?.etc?.cristals) > 0
                && /^(Weapon|Armor)\./.test(String(item?.template?.kind || ''))) this.gearIds.push(id);
        }
        this.gearSet = new Set(this.gearIds);
        this.watched = [...new Set([...this.gearIds, ...this.shotIds, ...this.recipeIds])];
    }
    configure(options = {}) {
        if (options.board) this.board = options.board;
        if (options.npcOffers) { this.npcOffers = options.npcOffers; this.npcSource = null; }
        if (options.stockFor) this.stockFor = options.stockFor;
    }
    update() {}
    remove() {}
    size() { return { spare: 0, demand: 0, recipeStock: 0, recipeHolders: 0 }; }
    refreshNpc() {
        const offers = this.npcOffers();
        if (offers === this.npcSource) return false;
        this.npcSource = offers; this.npcPrice.clear(); this.npcSources.clear();
        for (const row of offers || []) {
            const id = Number(row.selfId), price = Number(row.price ?? this.itemTemplates.get(id)?.template?.price);
            if (price > 0 && Number.isFinite(price) && price < (this.npcPrice.get(id) || Infinity)) {
                this.npcPrice.set(id, price); this.npcSources.set(id, row);
            }
        }
        return true;
    }
    gearLine(id, price, source, count = 1, ownerId = 0, enchant = 0, quote = null) {
        if (!(price > 0) || !Number.isFinite(price) || Number(enchant) > 0) return null;
        return { ...(quote || {}), selfId: id, price, crystals: Number(this.itemTemplates.get(id).etc.cristals),
            source, count, ownerId, town: quote?.town || null,
            authority: source === 'afk' ? { recordId: quote?.recordId, lineId: quote?.lineId,
                revision: quote?.expectedRevision ?? null } : { npcId: quote?.npcId ?? quote?.sourceId ?? null,
                shopId: quote?.shopId ?? quote?.listId ?? null } };
    }
    refreshItem(id, board, token, now) {
        const gear = [];
        if (this.gearSet.has(id)) {
            const npc = this.gearLine(id, Number(this.npcPrice.get(id)), 'npc', 1, 0, 0, this.npcSources.get(id));
            if (npc) gear.push(npc);
        }
        const holders = [];
        let amount = 0, minimum = Infinity;
        for (const line of board?.list(id, 1) || []) {
            amount += Number(line.count); minimum = Math.min(minimum, Number(line.price));
            if (this.gearSet.has(id)) {
                const row = this.gearLine(id, line.price, 'afk', line.count, line.ownerId, line.enchant, offerFields(line));
                if (row) gear.push(row);
            }
            if (this.recipeHolders.has(id)) holders.push({ ...offerFields(line), characterId: Number(line.ownerId),
                amount: Number(line.count), origin: 'public_ask', observedAt: now,
                authority: { recordId: line.recordId, lineId: line.lineId, revision: line.revision },
                availability: { from: now, until: now }, scope: 'board' });
        }
        this.boardCache.set(id, { token, gear });
        if (this.shotDemand.has(id)) {
            this.shotSupply.set(id, amount); this.shotMinPrice.set(id, minimum);
            const rows = [];
            for (const line of board?.list(id, 3) || []) {
                if (Number(line.enchant || 0) || !(line.price > 0) || !Number.isSafeInteger(line.count)) continue;
                rows.push({ ...offerFields(line), characterId: Number(line.ownerId), amount: Number(line.count),
                    // Compatibility scalar: public quoted value, never a wallet/escrow observation.
                    budget: Number(line.count) * Number(line.price), maxPrice: Number(line.price),
                    origin: 'public_bid', needId: `bid:${line.recordId}:${line.lineId}`, observedAt: now,
                    authority: { recordId: line.recordId, lineId: line.lineId, revision: line.revision },
                    sourceRevision: token, availability: { from: now, until: now }, scope: 'board',
                    quoted: true, exclusive: false, guaranteed: false, repeatable: false });
            }
            this.shotDemand.set(id, rows);
        }
        if (this.recipeHolders.has(id)) {
            this.recipeStock.set(id, amount); this.recipeHolders.set(id, holders);
        }
    }
    offersFor(itemId, side = 1, excludedOwner = 0) {
        const result = [];
        for (const line of this.board()?.list(Number(itemId), Number(side)) || []) {
            if (!excludedOwner || Number(line.ownerId) !== Number(excludedOwner)) result.push(offerFields(line));
        }
        return result;
    }
    marketSnapshot(now = Date.now(), projectedOwnState = null) {
        const board = this.board(), npcChanged = this.refreshNpc(), newBoard = board !== this.activeBoard;
        let gearChanged = npcChanged || newBoard;
        this.activeBoard = board;
        for (const id of this.watched) {
            const token = board?.itemRevision(id) ?? 'no-board';
            if (newBoard || npcChanged || this.boardCache.get(id)?.token !== token) {
                this.refreshItem(id, board, token, now);
                if (this.gearSet.has(id)) gearChanged = true;
            }
        }
        if (gearChanged) {
            this.gear.clear();
            for (const id of this.gearIds) {
                const rank = String(this.itemTemplates.get(id).etc.rank).toLowerCase();
                const rows = this.gear.get(rank) || [];
                for (const row of this.boardCache.get(id)?.gear || []) rows.push(row);
                if (rows.length) this.gear.set(rank, rows);
            }
        }
        // ARCH-NOTE: former global unlisted supply and recipe-holder vectors
        // revealed foreign bags/level/private pricing. Public quotes replace
        // them. The optional claimed owner's own reserve is the sole private
        // projection; there is no fallback foreign-state read.
        const unlistedSupply = new Map(), ownRecipeStock = new Map();
        if (projectedOwnState) {
            const stock = this.stockFor(projectedOwnState, 'shots', now);
            for (const id of this.shotIds) {
                const keep = Number(stock?.itemId) === id ? positive(stock.target) : positive(stock?.[id]);
                unlistedSupply.set(id, Math.max(0, positive(projectedOwnState.inventory?.[id]?.amount) - keep
                    - positive(projectedOwnState.stats?.clanMaterialDemand?.[id])));
            }
            for (const id of this.recipeIds) ownRecipeStock.set(id, positive(projectedOwnState.inventory?.[id]?.amount));
        }
        return { at: now, itemTemplates: this.itemTemplates, npcPrice: this.npcPrice, npcSources: this.npcSources, gear: this.gear,
            shotSupply: this.shotSupply, shotMinPrice: this.shotMinPrice, shotDemand: this.shotDemand,
            recipeStock: this.recipeStock, recipeHolders: this.recipeHolders, unlistedSupply, ownRecipeStock,
            demandKnown: false, lifetimeKnown: false, repeatable: false,
            offersFor: (id, side, ownerId) => this.offersFor(id, side, ownerId) };
    }
}

let instance = null, configured = {};
function configure(options = {}) { configured = { ...configured, ...options }; instance?.configure(options); }
function native() {
    if (instance) return instance;
    const recipes = invoke('GameServer/Items/C4RecipeItems');
    const catalogue = SHOT_RECIPES.map(id => recipes.resolveByRecipeId(id)).filter(Boolean);
    let npcRows = null, npcKey = null;
    instance = new ShotMarketIndex({
        itemTemplates: invoke('GameServer/DataCache').items,
        shotProductIds: catalogue.map(recipe => Number(recipe.productId)),
        shotRecipeItemIds: catalogue.map(recipe => Number(recipe.recipeItemId)),
        board: () => invoke('GameServer/AfkTrade/AfkTradeService').boardIndex(),
        npcOffers: () => {
            const key = `${invoke('GameServer/ProgressionRates').profile().multiplier}:${require('./ProductionPolicy').shotsDisabled()}`;
            if (npcKey !== key) {
                npcKey = key; npcRows = invoke('GameServer/World/Generics/NpcShopBuyLists').allOffers();
            }
            return npcRows;
        },
        stockFor: (state, _kind, now) => invoke('GameServer/Bot/Economy/EconomyContext').basics(state,{timestamp:now}).stock('shots'),
        ...configured
    });
    return instance;
}

module.exports = { ShotMarketIndex, native, configure, SHOT_RECIPES };
