'use strict';

const { offerFields } = require('../../AfkTrade/BoardIndex');
const SHOT_RECIPES = Object.freeze([20, 21, 22, 23, 24, 317, 318, 319, 320, 321, 323, 324, 325, 326, 327]);
const CRYSTALS = Object.freeze({ d: 1458, c: 1459, b: 1460, a: 1461, s: 1462 });
const SLOT = Symbol('shot-demand-slot');
const positive = value => Math.max(0, Number(value) || 0);

class ShotMarketIndex {
    constructor(options = {}) {
        this.itemTemplates = options.itemTemplates instanceof Map ? options.itemTemplates
            : new Map((options.itemTemplates || []).map(item => [Number(item.selfId), item]));
        this.shotIds = [...new Set((options.shotProductIds || []).map(Number))];
        this.recipeIds = [...new Set((options.shotRecipeItemIds || []).map(Number))];
        this.board = options.board || (() => null);
        this.npcOffers = options.npcOffers || (() => []);
        this.stockFor = options.stockFor || (() => ({}));
        this.stateFor = options.stateFor || (() => null);
        this.demandSignal = options.demandSignal || (() => null);
        this.priceFor = options.priceFor || ((_state, _item, template) => positive(template?.template?.price));
        this.keeps = new WeakMap();
        this.keepers = 0;
        this.demand = new Map();
        this.recipeOwners = new Map();
        this.shotDemand = new Map(this.shotIds.map(id => [id, []]));
        this.recipeHolders = new Map(this.recipeIds.map(id => [id, []]));
        this.unlistedSupply = new Map(this.shotIds.map(id => [id, 0]));
        this.recipeTotals = new Map(this.recipeIds.map(id => [id, 0]));
        this.shotSupply = new Map();
        this.shotMinPrice = new Map();
        this.recipeStock = new Map();
        this.npcPrice = new Map();
        this.gear = new Map();
        this.boardCache = new Map();
        this.boardBuys = new Map();
        this.boardBuyOwners = new Map();
        this.npcSource = null;
        this.activeBoard = null;
        this.gearIds = [...this.itemTemplates].filter(([, item]) => CRYSTALS[String(item?.etc?.rank || '').toLowerCase()]
            && Number(item?.etc?.cristals) > 0 && /^(Weapon|Armor)\./.test(String(item?.template?.kind || ''))).map(([id]) => id);
        this.gearSet = new Set(this.gearIds);
        this.watched = [...new Set([...this.gearIds, ...this.shotIds, ...this.recipeIds])];
    }

    configure(options = {}) {
        if (options.board) this.board = options.board;
        if (options.stateFor) this.stateFor = options.stateFor;
        if (options.npcOffers) { this.npcOffers = options.npcOffers; this.npcSource = null; }
    }

    cachedKeep(state, id) {
        const value = state ? this.keeps.get(state) : undefined;
        if (value === undefined) return 0;
        if (typeof value === 'number') return this.shotIds[value % 16] === id ? Math.floor(value / 16) : 0;
        return Number(value[0]) === id ? value[1] : 0;
    }

    keep(stock, id) {
        return Number(stock?.itemId) === id ? positive(stock.target) : positive(stock?.[id]);
    }

    spareOf(state, id, keep) {
        return state?.phase === 'cold' && state.stats?.shotCraft
            ? Math.max(0, positive(state.inventory?.[id]?.amount) - keep) : 0;
    }

    recipeAmount(state, id) {
        return state?.phase === 'cold' && state.activity !== 'merchant' ? positive(state.inventory?.[id]?.amount) : 0;
    }

    retireKeep(state) {
        if (state && this.keeps.delete(state)) this.keepers--;
    }

    addSignal(id, signal) {
        const rows = this.shotDemand.get(id);
        Object.defineProperty(signal, SLOT, { value: rows.length, writable: true });
        rows.push(signal);
    }

    dropSignal(id, signal) {
        const rows = this.shotDemand.get(id), slot = signal[SLOT];
        if (slot === undefined || rows[slot] !== signal) return;
        const last = rows.pop();
        if (slot < rows.length) { rows[slot] = last; last[SLOT] = slot; }
        signal[SLOT] = -1;
    }

    setDemand(id, ownerId, signal) {
        let owners = this.demand.get(id);
        const previous = owners?.get(ownerId);
        if (previous) this.dropSignal(id, previous);
        if (signal) {
            if (!owners) this.demand.set(id, owners = new Map());
            owners.set(ownerId, signal);
            for (const boardSignal of this.boardBuyOwners.get(id)?.get(ownerId) || []) this.dropSignal(id, boardSignal);
            this.addSignal(id, signal);
        } else if (previous) {
            owners.delete(ownerId);
            if (!owners.size) this.demand.delete(id);
            for (const boardSignal of this.boardBuyOwners.get(id)?.get(ownerId) || []) this.addSignal(id, boardSignal);
        }
    }

    setRecipe(id, ownerId, price) {
        let owners = this.recipeOwners.get(id);
        const previous = owners?.get(ownerId), rows = this.recipeHolders.get(id);
        if (previous && previous.price === price) return;
        // ARCH-NOTE: the public snapshot keeps the native ascending-price array.
        // Its splice moves the affected recipe's rows on holder changes only;
        // snapshots never enumerate holders or recompute a holder's price/keep.
        if (previous) rows.splice(rows.indexOf(previous), 1);
        if (price !== null) {
            if (!owners) this.recipeOwners.set(id, owners = new Map());
            const row = { characterId: ownerId, price };
            let low = 0, high = rows.length;
            while (low < high) { const mid = (low + high) >>> 1; if (rows[mid].price <= price) low = mid + 1; else high = mid; }
            rows.splice(low, 0, row); owners.set(ownerId, row);
        } else if (owners) {
            owners.delete(ownerId);
            if (!owners.size) this.recipeOwners.delete(id);
        }
    }

    update(state, now = Date.now()) {
        const ownerId = Number(state?.characterId);
        if (!(ownerId > 0)) return;
        if (state.phase !== 'cold') { this.remove(ownerId); return; }
        const canonical = this.stateFor(ownerId);
        const previous = canonical && this.keeps.has(canonical) ? canonical : null;
        const stock = state.stats?.shotCraft ? this.stockFor(state, 'shots', now) : null;
        for (const id of this.shotIds) {
            this.unlistedSupply.set(id, this.unlistedSupply.get(id) + this.spareOf(state,id,this.keep(stock,id))
                - this.spareOf(previous,id,this.cachedKeep(previous,id)));
            const holds = positive(state.inventory?.[id]?.amount) > 0 || Number(state.stats?.shotDemand?.itemId) === id;
            const signal = holds ? this.demandSignal(state, id, now) : null;
            this.setDemand(id, ownerId, signal?.source === 'shots' && signal.budget > 0 ? signal : null);
        }
        this.retireKeep(previous);
        if (stock && this.shotIds.some(id=>positive(state.inventory?.[id]?.amount)>0)
            || this.recipeIds.some(id=>this.recipeAmount(state,id)>0)) {
            const itemId=Number(stock?.itemId), at=this.shotIds.indexOf(itemId), target=positive(stock?.target);
            // ARCH-NOTE: producers call update before canonical publication.
            // The weak value records the exact keep computed at the prior
            // price/time, never a retained state copy or fifteen owner maps.
            // Native integral targets fit one scalar; exceptional targets
            // retain an exact pair rather than rounding a keep amount.
            const packed=target*16+at;
            this.keeps.set(state,at<0 ? -1 : Number.isSafeInteger(packed) ? packed : [itemId,target]);
            this.keepers++;
        }
        // ARCH-NOTE: the native catalogue contains fifteen shot products and
        // fifteen recipe items (the task's four-id description was outdated).
        // Only scalar quantities/signals are kept; no canonical state copy.
        for (const id of this.recipeIds) {
            const amount = this.recipeAmount(state,id);
            this.recipeTotals.set(id,this.recipeTotals.get(id)+amount-this.recipeAmount(previous,id));
            this.setRecipe(id, ownerId, amount > 0 && Number(state.level) >= 10
                ? this.priceFor(state, state.inventory[id], this.itemTemplates.get(id)) : null);
            const listed = this.boardCache.get(id)?.recipeAmount || 0;
            this.recipeStock.set(id, (this.recipeTotals.get(id) || 0) + listed);
        }
    }

    remove(ownerId) {
        ownerId = Number(ownerId);
        const canonical=this.stateFor(ownerId);
        const previous=canonical && this.keeps.has(canonical) ? canonical : null;
        for (const id of this.shotIds) {
            this.unlistedSupply.set(id,this.unlistedSupply.get(id)-this.spareOf(previous,id,this.cachedKeep(previous,id)));
            this.setDemand(id, ownerId, null);
        }
        for (const id of this.recipeIds) {
            this.recipeTotals.set(id,this.recipeTotals.get(id)-this.recipeAmount(previous,id));
            this.setRecipe(id, ownerId, null);
            this.recipeStock.set(id, (this.recipeTotals.get(id) || 0) + (this.boardCache.get(id)?.recipeAmount || 0));
        }
        this.retireKeep(previous);
    }

    size() {
        const sum = map => [...map.values()].reduce((total, rows) => total + rows.size, 0);
        return { spare: this.keepers, demand: sum(this.demand), recipeStock: 0, recipeHolders: sum(this.recipeOwners) };
    }

    refreshNpc() {
        const offers = this.npcOffers();
        if (offers === this.npcSource) return false;
        this.npcSource = offers;
        this.npcPrice.clear();
        for (const row of offers || []) {
            const id = Number(row.selfId), price = Number(row.price ?? this.itemTemplates.get(id)?.template?.price);
            if (price > 0 && Number.isFinite(price)) this.npcPrice.set(id, Math.min(this.npcPrice.get(id) || Infinity, price));
        }
        return true;
    }

    gearLine(id, price, source, count = 1, ownerId = 0, enchant = 0) {
        if (!(price > 0) || !Number.isFinite(price) || Number(enchant) > 0) return null;
        const item = this.itemTemplates.get(id);
        return { selfId: id, price, crystals: Number(item.etc.cristals), source, count, ownerId };
    }

    refreshItem(id, board, token) {
        const sells = board ? board.list(id, 1).map(line => offerFields(line)) : [];
        const gear = [];
        if (this.gearSet.has(id)) {
            const npc = this.gearLine(id, Number(this.npcPrice.get(id)), 'npc');
            if (npc) gear.push(npc);
            for (const offer of sells) {
                const row = this.gearLine(id, offer.price, 'afk', offer.count, offer.sourceId, offer.enchant);
                if (row) gear.push(row);
            }
        }
        const recipeAmount = sells.reduce((sum, offer) => sum + Number(offer.count), 0);
        this.boardCache.set(id, { token, gear, recipeAmount });
        if (this.shotDemand.has(id)) {
            this.shotSupply.set(id, recipeAmount);
            this.shotMinPrice.set(id, sells.reduce((price, offer) => Math.min(price, Number(offer.price)), Infinity));
            for (const signal of this.boardBuys.get(id) || []) this.dropSignal(id, signal);
            const rows = [], owners = new Map();
            for (const offer of board ? board.list(id, 3).map(line => offerFields(line)) : []) {
                const ownerId = Number(offer.sourceId);
                const signal = { characterId: ownerId, amount: Number(offer.count),
                    budget: Number(offer.count) * Number(offer.price), maxPrice: Number(offer.price) };
                rows.push(signal);
                const own = owners.get(ownerId) || []; own.push(signal); owners.set(ownerId, own);
                if (!this.demand.get(id)?.has(ownerId)) this.addSignal(id, signal);
            }
            this.boardBuys.set(id, rows); this.boardBuyOwners.set(id, owners);
        }
        if (this.recipeHolders.has(id)) this.recipeStock.set(id, (this.recipeTotals.get(id) || 0) + recipeAmount);
    }

    offersFor(itemId, side = 1, excludedOwner = 0) {
        return (this.board()?.list(Number(itemId), Number(side)) || [])
            .filter(line => !excludedOwner || Number(line.ownerId) !== Number(excludedOwner))
            .map(line => offerFields(line));
    }

    marketSnapshot(now = Date.now(), projectedOwnState = null) {
        const board = this.board(), npcChanged = this.refreshNpc();
        let gearChanged = npcChanged || board !== this.activeBoard;
        const newBoard = board !== this.activeBoard; this.activeBoard = board;
        for (const id of this.watched) {
            const token = board?.itemRevision(id) ?? 'no-board';
            if (newBoard || npcChanged || this.boardCache.get(id)?.token !== token) {
                this.refreshItem(id, board, token);
                if (this.gearSet.has(id)) gearChanged = true;
            }
        }
        if (gearChanged) {
            this.gear.clear();
            for (const id of this.gearIds) {
                const rank = String(this.itemTemplates.get(id).etc.rank).toLowerCase();
                const rows = this.gear.get(rank) || [];
                rows.push(...(this.boardCache.get(id)?.gear || []));
                if (rows.length) this.gear.set(rank, rows);
            }
            for (const rows of this.gear.values()) rows.sort((a, b) => a.price / a.crystals - b.price / b.crystals || a.price - b.price);
        }
        let unlistedSupply=this.unlistedSupply, recipeStock=this.recipeStock;
        if (projectedOwnState) {
            const canonical=this.stateFor(Number(projectedOwnState.characterId));
            const previous=canonical && this.keeps.has(canonical) ? canonical : null;
            const stock=projectedOwnState.stats?.shotCraft ? this.stockFor(projectedOwnState,'shots',now) : null;
            // Forecast only this claimed owner's contribution. Publishing a
            // speculative bag globally would double its delta on ACK/rejection
            // and retain a second full state. Canonical publication owns totals.
            unlistedSupply=new Map(this.unlistedSupply);recipeStock=new Map(this.recipeStock);
            for(const id of this.shotIds)unlistedSupply.set(id,unlistedSupply.get(id)
                +this.spareOf(projectedOwnState,id,this.keep(stock,id))-this.spareOf(previous,id,this.cachedKeep(previous,id)));
            for(const id of this.recipeIds)recipeStock.set(id,recipeStock.get(id)
                +this.recipeAmount(projectedOwnState,id)-this.recipeAmount(previous,id));
        }
        return { at: now, itemTemplates: this.itemTemplates, npcPrice: this.npcPrice, gear: this.gear,
            shotSupply: this.shotSupply, shotMinPrice: this.shotMinPrice, shotDemand: this.shotDemand,
            recipeStock, recipeHolders: this.recipeHolders, unlistedSupply };
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
        stateFor: id => require('./CraftWorkshopService').inputStateFor(id),
        demandSignal: (state, id, now) => require('./MarketDemandIndex').demandSignal(state, id, now),
        priceFor: (state, item, template) => require('./ItemDisposition').priceFor(state, item, template),
        ...configured
    });
    return instance;
}

module.exports = { ShotMarketIndex, native, configure, SHOT_RECIPES };
