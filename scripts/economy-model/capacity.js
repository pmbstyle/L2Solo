'use strict';

// Crafter capacity from game data alone: the shots a cohort fires per hour at
// its best spots, against the seated MP of its crafter twins and the
// materials (ore at the NPC price, crystals through NPC gear). Answers how
// many twins keep shots supplied, and what the inputs cost, before any market
// runs. No World, no database, no market: a static read per band.
//
//   node scripts/economy-model/capacity.js [--preset x1,x10,x50]
//        [--bands 20-29:1123,30-39:573] [--hunt-share 0.2]
//
// Bands default to the level bands of the 1700-bot save of the x50 run s7b
// (1123 bots at 20-29, 573 at 30-39, none above): a fact of today's world the
// model stands on until the first-version world has its own. The hunting
// share is the part of a bot's hour spent hunting; 0.2 is today's: s7b's hunt
// adena per bot-hour over the class-weighted best-spot hour at x50.

const Boot = require('./boot');
const Weights = require('./weights');
const KitHours = require('./kit-hours');

const DEFAULT_BANDS = '20-29:1123,30-39:573,40-51:0,52-60:0,61-75:0';
const DEFAULT_HUNT_SHARE = 0.2;

function parseBands(text) {
    return String(text).split(',').filter(Boolean).map(part => {
        const match = /^(\d+)-(\d+):(\d+(?:\.\d+)?)$/.exec(part.trim());
        if (!match) throw new Error(`band "${part}": expected lo-hi:population`);
        const [lo, hi, population] = match.slice(1).map(Number);
        if (hi < lo) throw new Error(`band "${part}": hi under lo`);
        return { lo, hi, population };
    });
}

// One band's demand and twin supply. Pure: world gives
//   hour(line, level)  -> { shotId, shots } one bot's shots per hunting hour at its best spot, or null
//   recipe(shotId)     -> { productCount, mpCost, level, materials: [{ selfId, amount }] } or null
//   twin(level)        -> { classId, mp, createItem } a twin's seated MP per hour and Create Item level
//   crystalIds         -> Set of the crystal item ids
// Bots spread evenly over the band's levels and by weight over the lines; a
// twin sits at its main's level and serves the band only if its Create Item
// level reaches every recipe the band needs.
function bandDemand(band, weights, twinShare, world, huntShare = 1) {
    const { lo, hi, population } = band;
    const levels = hi - lo + 1, perLevel = population / levels, sum = Weights.weightSum(weights);
    const units = new Map();
    let noRow = 0, noShot = 0;
    for (let level = lo; level <= hi; level++) {
        for (const [line, weight] of Object.entries(weights)) {
            if (!(weight > 0)) continue;
            const bots = perLevel * weight / sum;
            const hour = world.hour(line, level);
            if (!hour) { noRow += bots; continue; }
            if (!hour.shotId) { noShot += bots; continue; }
            units.set(hour.shotId, (units.get(hour.shotId) || 0) + bots * hour.shots * huntShare);
        }
    }
    const products = [], noRecipe = [], ores = new Map(), crystals = new Map();
    let mp = 0, recipeLevel = 0;
    for (const [shotId, count] of [...units].sort((a, b) => a[0] - b[0])) {
        const recipe = world.recipe(shotId);
        if (!recipe) { noRecipe.push({ shotId, units: count }); continue; }
        const crafts = count / recipe.productCount;
        products.push({ shotId, units: count, crafts, mp: crafts * recipe.mpCost, recipeLevel: recipe.level, recipe });
        mp += crafts * recipe.mpCost;
        recipeLevel = Math.max(recipeLevel, recipe.level);
        for (const { selfId, amount } of recipe.materials) {
            const into = world.crystalIds.has(selfId) ? crystals : ores;
            into.set(selfId, (into.get(selfId) || 0) + crafts * amount);
        }
    }
    let twins = 0, twinsAble = 0, mpHeld = 0, mpSum = 0;
    for (let level = lo; level <= hi; level++) {
        const twin = world.twin(level), count = perLevel * twinShare;
        twins += count;
        mpSum += twin.mp;
        if (twin.createItem >= recipeLevel) { twinsAble += count; mpHeld += count * twin.mp; }
    }
    const meanTwinMp = mpSum / levels;
    return {
        band, huntShare, bots: population, noRow, noShot, products, noRecipe, ores, crystals, mp,
        crafts: products.reduce((total, row) => total + row.crafts, 0),
        twins, twinsAble, mpHeld, meanTwinMp, recipeLevel,
        twinsNeeded: mp / meanTwinMp,
        coverage: mp > 0 ? Math.min(1, mpHeld / mp) : null,
        // The share of the band's accounts that would need a twin crafting nonstop.
        twinShareForFull: population > 0 ? mp / meanTwinMp / population : null
    };
}

// The cheapest crystal of each grade through gear an NPC sells, crystallized:
// [{ itemId, price, ref, crystalId, crystals }] -> crystalId -> { taxed, untaxed }
// each { perCrystal, itemId }. Taxed reads the NPC's price (the shop tax is in
// the buylist data); untaxed the item's reference price.
function crystalRoutes(offers) {
    const routes = new Map();
    for (const offer of offers) {
        if (!(offer.crystals > 0) || !offer.crystalId) continue;
        const held = routes.get(offer.crystalId) || {};
        for (const [kind, price] of [['taxed', offer.price], ['untaxed', offer.ref]]) {
            const perCrystal = price / offer.crystals;
            if (price > 0 && (!held[kind] || perCrystal < held[kind].perCrystal)) held[kind] = { perCrystal, itemId: offer.itemId };
        }
        routes.set(offer.crystalId, held);
    }
    return routes;
}

// What a band's inputs cost: ore at the NPC price, crystals by the cheapest
// gear route (null where no NPC sells gear of that grade), and each shot's
// craft cost against its reference price. prices: { npc(id), ref(id), routes }.
function bandCosts(demand, prices) {
    const oreAdena = [...demand.ores].reduce((sum, [id, count]) => sum + count * (prices.npc(id) || 0), 0);
    const crystalAdena = { taxed: 0, untaxed: 0, unpriced: 0 };
    for (const [id, count] of demand.crystals) {
        const route = prices.routes.get(id);
        if (!route?.taxed) { crystalAdena.unpriced += count; continue; }
        crystalAdena.taxed += count * route.taxed.perCrystal;
        crystalAdena.untaxed += count * route.untaxed.perCrystal;
    }
    const perShot = demand.products.map(({ shotId, recipe }) => {
        const cost = { taxed: 0, untaxed: 0, complete: true };
        for (const { selfId, amount } of recipe.materials) {
            const route = prices.routes.get(selfId);
            if (route) {
                if (!route.taxed) { cost.complete = false; continue; }
                cost.taxed += amount * route.taxed.perCrystal;
                cost.untaxed += amount * route.untaxed.perCrystal;
            } else {
                const npc = prices.npc(selfId);
                if (!npc) cost.complete = false;
                cost.taxed += amount * (npc || 0);
                cost.untaxed += amount * (npc || 0);
            }
        }
        return { shotId, taxed: cost.taxed / recipe.productCount, untaxed: cost.untaxed / recipe.productCount,
            complete: cost.complete, ref: prices.ref(shotId) };
    });
    return { oreAdena, crystalAdena, perShot };
}

// The game-data reads of bandDemand and bandCosts, after Boot.boot().
function gameWorld() {
    const Data = invoke('GameServer/DataCache');
    const Table = invoke('GameServer/Bot/AI/SpotValueTable');
    const ColdRest = invoke('GameServer/Bot/Population/ColdRest');
    const Craft = invoke('GameServer/Bot/Economy/CraftEligibility');
    const Recipes = invoke('GameServer/Items/C4RecipeItems');
    const Enchant = invoke('GameServer/Items/C4EnchantRules');
    const Formulas = invoke('GameServer/Formulas');
    const Index = require('../../src/GameServer/Item/ItemTemplateIndex');
    const item = id => Index.find(Data.items, id);
    const ticksPerHour = 3600000 / Formulas.REGEN_TICK_MS;
    const crystalIds = new Set(Object.values(Enchant.CRYSTAL_IDS));
    return {
        crystalIds,
        name: id => item(id)?.template?.name || `#${id}`,
        ref: id => Number(item(id)?.template?.price || 0),
        // The reference bot of the line at the level (the author's kit), its
        // shot from the kit's weapon, and its shots at the best income spot.
        hour(line, level) {
            const row = Table.best(line, level, true, 'income');
            if (!row) return null;
            const classId = Table.roleClass(line, level);
            return { shotId: KitHours.referenceShot(classId, level, line), shots: row.shots };
        },
        recipe: id => Recipes.resolveByProductId(id),
        // A twin's seated MP per hour, Create Item level and the highest
        // grade it crystallizes (null below D), from its class's skill tree.
        twin(level, classId = Weights.twinClass(level)) {
            const tick = ColdRest.coldRestRegenPerTick({ level, stats: { classId } }, { timestamp: 0 });
            const crystallize = [...'sabcd'].find(rank => Craft.canCrystallize({ classId, level }, rank)) || null;
            return { classId, mp: tick.mp * ticksPerHour, createItem: Craft.craftLevelFor({ classId, level }), crystallize };
        },
        // The NPC offers of gear that crystallizes, at the current rate's NPC prices.
        gearOffers() {
            const offers = [];
            for (const [itemId, price] of invoke('GameServer/World/Generics/NpcShopBuyLists').townPrices()) {
                const etc = item(itemId)?.etc;
                const crystals = Enchant.crystalCount(etc);
                if (crystals > 0) offers.push({ itemId, price, ref: Number(item(itemId).template.price || 0),
                    crystalId: Enchant.CRYSTAL_IDS[Enchant.gradeOf(etc)], crystals });
            }
            return offers;
        },
        npcPrices: () => new Map(invoke('GameServer/World/Generics/NpcShopBuyLists').townPrices())
    };
}

function fmt(value) {
    if (value === null || value === undefined || !Number.isFinite(value)) return '-';
    const abs = Math.abs(value);
    if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
    if (abs >= 1e4) return `${(value / 1e3).toFixed(1)}k`;
    if (abs >= 100) return `${Math.round(value)}`;
    return `${+value.toFixed(abs >= 10 ? 1 : abs >= 1 ? 2 : 3)}`;
}

function pair(full, shared, format = fmt) {
    return `${format(full)} | ${format(shared)}`;
}

function printBand(preset, full, shared, costFull, costShared, world, prices) {
    const { lo, hi } = full.band;
    const head = `[${preset}] band ${lo}-${hi}: ${fmt(full.bots)} bots`;
    if (!(full.bots > 0)) { console.log(`${head} (pass --bands ${lo}-${hi}:<bots>)`); return; }
    console.log(`${head} (no spot row ${fmt(full.noRow)}, no shot ${fmt(full.noShot)}); hunting share 1 | ${shared.huntShare}`);
    for (let i = 0; i < full.products.length; i++) {
        const row = full.products[i], cost = costFull.perShot[i];
        console.log(`  ${world.name(row.shotId)} (${row.shotId}): ${pair(row.units, shared.products[i].units)} /h, `
            + `${pair(row.crafts, shared.products[i].crafts)} crafts, ${pair(row.mp, shared.products[i].mp)} MP; craft cost per shot `
            + (cost.complete ? `${fmt(cost.taxed)} taxed, ${fmt(cost.untaxed)} untaxed` : `- (an input without an NPC route; the rest ${fmt(cost.taxed)})`)
            + ` against ref ${fmt(cost.ref)}`);
    }
    for (const row of full.noRecipe) console.log(`  ${world.name(row.shotId)} (${row.shotId}): ${fmt(row.units)} /h at share 1, no recipe (an NPC-sold grade)`);
    console.log(`  MP/h ${pair(full.mp, shared.mp)}; crafts/h ${pair(full.crafts, shared.crafts)}`);
    const [loClass, hiClass] = [lo, hi].map(Weights.twinClass);
    const twinName = loClass !== hiClass ? 'Artisan/Warsmith' : loClass === Weights.ARTISAN ? 'Artisan' : 'Warsmith';
    console.log(`  twins by the weights ${fmt(full.twins)} (${twinName}, mean seated MP/h ${fmt(full.meanTwinMp)}, `
        + `${fmt(full.twinsAble)} with Create Item >= ${full.recipeLevel}); nonstop twins needed ${pair(full.twinsNeeded, shared.twinsNeeded)}; `
        + `coverage ${pair(full.coverage, shared.coverage)}; twin share for full coverage ${pair(full.twinShareForFull * 100, shared.twinShareForFull * 100)} %`);
    const ores = [...full.ores].map(([id, count]) => `${world.name(id)} ${pair(count, shared.ores.get(id))} at ${fmt(prices.npc(id))}`);
    console.log(`  ore/h: ${ores.join('; ') || 'none'}; NPC adena/h ${pair(costFull.oreAdena, costShared.oreAdena)}`);
    const crystals = [...full.crystals].map(([id, count]) => {
        const route = prices.routes.get(id);
        const at = route?.taxed ? ` at ${fmt(route.taxed.perCrystal)} taxed (${world.name(route.taxed.itemId)}), ${fmt(route.untaxed.perCrystal)} untaxed`
            : ' (no NPC gear route)';
        return `${world.name(id)} ${pair(count, shared.crystals.get(id))}${at}`;
    });
    const adena = costFull.crystalAdena.taxed > 0 ? `; adena/h ${pair(costFull.crystalAdena.taxed, costShared.crystalAdena.taxed)} taxed, `
        + `${pair(costFull.crystalAdena.untaxed, costShared.crystalAdena.untaxed)} untaxed` : '';
    console.log(`  crystals/h: ${crystals.join('; ') || 'none'}${adena}`);
}

function main(argv) {
    const presets = Boot.presetsOption(argv);
    const bands = parseBands(Boot.option(argv, 'bands', DEFAULT_BANDS));
    const huntShare = Number(Boot.option(argv, 'hunt-share', DEFAULT_HUNT_SHARE));
    if (!(huntShare > 0 && huntShare <= 1)) throw new Error('--hunt-share must be in (0, 1]');
    Boot.boot('x1');
    const world = gameWorld();
    // The design keeps NPC prices at x1 at every preset: read them once at x1.
    const npc = world.npcPrices();
    const prices = { npc: id => npc.get(Number(id)) || 0, ref: world.ref, routes: crystalRoutes(world.gearOffers()) };
    const weights = Weights.CLASS_WEIGHTS, share = Weights.twinShare(weights);
    console.log(`twin share ${fmt(share * 100)} % of accounts; NPC prices at x1 (cheapest NPC); `
        + 'demand at each preset\'s best income spots (today\'s rates, the spot table)');
    for (const preset of presets) {
        Boot.usePreset(preset);
        const total = { mp: 0, mpShared: 0, twins: 0, needed: 0, neededShared: 0, crystals: 0, crystalAdena: 0 };
        for (const band of bands) {
            const full = bandDemand(band, weights, share, world, 1);
            const shared = bandDemand(band, weights, share, world, huntShare);
            const costFull = bandCosts(full, prices), costShared = bandCosts(shared, prices);
            printBand(preset, full, shared, costFull, costShared, world, prices);
            total.mp += full.mp; total.mpShared += shared.mp; total.twins += full.twins;
            if (full.mp > 0) { total.needed += full.twinsNeeded; total.neededShared += shared.twinsNeeded; }
            total.crystals += [...full.crystals.values()].reduce((sum, count) => sum + count, 0);
            total.crystalAdena += costFull.crystalAdena.taxed;
        }
        console.log(`[${preset}] total: MP/h ${pair(total.mp, total.mpShared)}; nonstop twins needed ${pair(total.needed, total.neededShared)} `
            + `of ${fmt(total.twins)} twins; crystals/h ${fmt(total.crystals)} at share 1, ${fmt(total.crystalAdena)} adena/h taxed`);
    }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { bandDemand, bandCosts, crystalRoutes, gameWorld, fmt };
