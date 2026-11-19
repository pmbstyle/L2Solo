'use strict';

// A stub of the gnome trade, the maintainer's design for the model (ours, not C4's rule: in C4 any player buys the
// graded shots at an NPC; here the hidden store stands for the dwarf craft and resale a C4 server runs on).
// Gnomes are the mains of the dwarf lines (spoilers and crafters). Only they buy D+ shots, C+ gear and the weapon
// enchant scrolls from the hidden store (the configured stores' fixed_wts lines), at the wholesale price: share x
// the market price (no floor at the store's price: a gnome keeps 1 - share of the market even at its ref x1 floor;
// decision 490). Every other main buys those goods from a gnome at the
// market price in a town with gnome supply (a gnome whose last town chain or held spot is that town); without one
// where it stands it buys from the cheapest seller in reach: a gnome town by its fare, or for D+ shots only the
// hidden store at the safety valve (2 x ref); C+ gear and scrolls without a gnome in reach wait (decision 468). The gnome keeps market - wholesale per unit: the town's margin of an
// hour is split among the town's gnomes at the hour's close and credited at each gnome's next visit (the plane
// holds it until then). Scrolls come from a capped server stock per grade (refilled each hour, at most two hours'
// worth). Market prices float at each hour's close, 5 % up when the hour's demand exceeds the gnome supply, else
// 5 % down, between ref x1 and the ceiling: shots per (grade, town), gear and scrolls per grade. The gnome supply
// is a turnover capacity (decision 469): for shots of a grade in a town, the hour's shot need of SHOT_MAINS_PER_GNOME
// mains per gnome serving the town (units: shotsPerHour[grade], a main's shots per hunting hour at that grade); for
// gear of a grade, the wholesale value of GEAR_WEAPONS_PER_GNOME C weapons per gnome of the server (each grade's
// wholesale demand against it); for scrolls the hour's stock against the units wanted. Materials: another main
// sells the materials of the gnome goods' recipes to a gnome in its town at the gnome bid (between the NPC
// buy-back and the fixed buyer's 1.5 x the NPC buy-back, start 1.2 x), else to the NPC; the gnome sells them on to
// the fixed buyer (the faucet) and keeps the spread. The bid falls 5 % in an hour when the materials offered exceed
// the town's gnome turnover (GEAR_WEAPONS_PER_GNOME C weapons' value per gnome), else rises.
// Grade and tier gating (maintainer 475): a gnome resells, and buys from the hidden store, only the grades and tiers its
// level unlocks. A crafter line (its Create Item level grows past 1 in the skill tree) unlocks a piece at the level its
// Create Item level reaches the piece's recipe craft level, shots and scrolls of a grade at the grade's lowest gear or
// shot recipe level; a spoiler line a grade at SPOILER_FROM. Inside a grade a piece without a recipe (every piece for a
// spoiler) unlocks by its tier: its place on the gear table's ladders (entry, mid, late, top: quarters of the grade's
// pieces of a slot group, worst first; a piece on several ladders takes its highest tier, ours), the tiers spread evenly
// over the grade's level range (C 40-51: 40, 43, 46, 49). A buyer sees a gnome's offer of a piece in a town only when a
// gnome serving that town unlocks it: else it buys a lower kit piece that one sells or waits (gear, scrolls), or buys
// the shots at the safety valve.
// Gear purchase cap (maintainer, ours): each gnome buys C+ gear for resale from the hidden store up to an allowance in
// pieces of each grade, GEAR_PIECES_PER_GNOME an hour per grade (its own worn gear apart; shots and scrolls uncapped; one
// pool for every grade let the A sets drain it and left C and B mains no weapon offer), unused allowance kept at most
// STOCK_HOURS hours' worth. A town's gnome offer of a piece stands while its gnomes' allowance of the piece's grade
// holds a whole piece; a sale draws its pieces from them. A want no gnome in reach sells is the gear market's demand, so demand above the
// cap moves the price up.
// Crafter modes (maintainer 481, ours): a crafter line's gnome is a merchant by default: it does not hunt, stays in the
// town of the visit it turned merchant at and serves that town only, and stocks the goods from its own money (its wallet:
// its money and the margin held for it; the goods are bought as they sell, so the wallet gates the offer: no credit).
// At an hour's close, a merchant goes hunting when at least HUNT_WHEN of the non-gnome mains whose level lies in the span of
// its top unlocked (grade, tier) step on the spoiler ladder (SPOILER_FROM's tiers, the C4 grade bands: the step's level to
// the next step's minus one, the mains that wear that tier now; its own unlock levels lead the bands) wear a weapon of that
// tier or better, or when IDLE_HOURS hours in a row as a merchant passed in which its town sold no piece of its top tier
// (decision 490: a band's entry levels may never reach HUNT_WHEN), and hunts until its level unlocks its next tier; at
// its next visit it is a merchant again. A crafter whose wallet cannot cover the wholesale of the cheapest C+ gear piece it unlocks (no stock, no
// business; one that unlocks none stays) hunts too, from that close or the visit it would turn merchant, until a visit
// finds its wallet covers it or its level unlocks its next tier. Before its first unlock it hunts. A crafter's
// tiers unlock on the tier ladder (each grade's TIERS levels from its first gear recipe's level to the next grade's).
// Gnome wallet thermostat (maintainer 482, ours; spoilers too, decision 490): each gnome holds a material bid (x the NPC buy-back, BID.low to
// BID.high: the fixed buyer's 0.75 x the item price) and a margin share (0 to 1 of the market price over the wholesale).
// At each hour's close, its wallet over its target (THERMO.wallet x the median wallet of the non-gnome mains within
// THERMO.levels of its level, plus its stock cost: STOCK_HOURS of its piece allowance at its top tier grade's mean weapon
// wholesale) raises the bid and lowers the share THERMO.step; under it, the reverse. A town's gnome price is the
// wholesale plus the lowest share of the gnomes serving it of the margin; its bid the highest of the town's bid and its
// gnomes' bids.
// A gnome's own gear (a piece it wears) costs it the market price, not the wholesale (maintainer, ours).
// Shop time (maintainer, ours): a gnome spends part of its hours tending its shop instead of hunting, SHOP.base plus
// SHOP.busy x its load: its served turnover of the last closed hour (each town it serves: the town's gnome sales at the
// market price and materials bought, split evenly among the town's gnomes as the margin is) over one gnome's turnover
// capacity (GEAR_WEAPONS_PER_GNOME C weapons' value), at most 1. The plane reads it at a spoiler's visit (a crafter is a
// merchant or hunts): the shop hours it spends in town then. GNOME_SPOILER_SHOP, when set, is that share instead (a tuning lever).
const { GRADE_ORDER } = require('../gear');
const Engine = require('../engine');

const START = 1.3, STEP = Number(process.env.GNOME_STEP || 1.05), VALVE = 2, SCROLL_CEILING = 5;
// The market price's ceiling for shots and gear (x ref; shots without a gnome in reach are sold at VALVE).
const CEILING = Number(process.env.GNOME_CEILING || VALVE);
const BID = { low: 1, high: 1.5, start: 1.2, buyer: 1.5 };
const SCROLLS_PER_HOUR = Object.freeze({ C: 20, B: 10, A: 5 });
const STOCK_HOURS = 2;
const SHOP = Object.freeze({ base: 0.3, busy: 0.2 }), SPOILER_SHOP = process.env.GNOME_SPOILER_SHOP ? Number(process.env.GNOME_SPOILER_SHOP) : null;
const HUNT_WHEN = 0.7, IDLE_HOURS = 6;
const THERMO = Object.freeze({ wallet: Number(process.env.CRAFTER_WALLET || 1.2), levels: 2, step: 1.05 });
const SPOILER_FROM = Object.freeze({ D: 20, C: 40, B: 52, A: 61, S: 76 }), GRADES = ['D', 'C', 'B', 'A', 'S'], GEAR_GRADES = ['C', 'B', 'A', 'S'], TIERS = 4;
const SHOT_MAINS_PER_GNOME = Number(process.env.GNOME_SHOT_MAINS || 4), GEAR_WEAPONS_PER_GNOME = Number(process.env.GNOME_GEAR_WEAPONS || 0.3);
const GEAR_PIECES_PER_GNOME = Number(process.env.GNOME_GEAR_PIECES || 0.5);

// The tier of each graded piece on the gear table's ladders (ladders: snapshot.gearLadder.lines, each line's bands with
// rungs { group: [selfId] } best first; the last band holds every grade): id -> 0..TIERS-1, the highest it takes.
function tiersOf(view, ladders) {
    const tiers = new Map();
    for (const bands of Object.values(ladders || {})) {
        const top = bands[bands.length - 1];
        for (const rungs of Object.values(top?.rungs || {})) for (const grade of GRADES) {
            const ids = rungs.filter(id => String(view.items[id]?.grade || '').toUpperCase() === grade).reverse();
            ids.forEach((id, at) => tiers.set(id, Math.max(tiers.get(id) ?? 0, Math.floor(at * TIERS / ids.length))));
        }
    }
    return tiers;
}

// market({ view, gnomeLines, share, scrolls: { grade: scrollId }, recipes, shotsPerHour, craftLevels: { line: [Create
// Item level by character level] }, ladders }): the trade's state, mutated by the plane in event order (one run, one market).
function market({ view, gnomeLines, share, scrolls, recipes, shotsPerHour, craftLevels = {}, ladders = {} }) {
    const lines = new Set([...gnomeLines].map(String));
    const scrollGrade = new Map(Object.entries(scrolls).map(([grade, id]) => [Number(id), grade]));
    const shotGrade = new Map();
    view.shotFamilies?.ids.forEach(ids => ids.forEach((id, at) => { if ((GRADE_ORDER[view.shotFamilies.grades[at]] ?? 0) >= GRADE_ORDER.D) shotGrade.set(id, view.shotFamilies.grades[at]); }));
    const gradeOfItem = id => String(view.items[id]?.grade || 'NONE').toUpperCase();
    // What the trade covers of an item: { kind, grade } or null.
    const kindOf = id => {
        if (scrollGrade.has(id)) return { kind: 'scroll', grade: scrollGrade.get(id) };
        if (shotGrade.has(id)) return { kind: 'shot', grade: shotGrade.get(id) };
        if (Engine.isGear(view.items[id]) && (GRADE_ORDER[gradeOfItem(id)] ?? 0) >= GRADE_ORDER.C) return { kind: 'gear', grade: gradeOfItem(id) };
        return null;
    };
    const hidden = new Map(), ref = new Map();
    for (const [id, rows] of view.offers) {
        const own = rows.filter(row => row.channel === 'fixed_wts');
        // GNOME_REF_<grade> scales a grade's gear store price (the tuning lever on the reserve price; default 1).
        const what = kindOf(id), scale = what?.kind === 'gear' ? Number(process.env[`GNOME_REF_${what.grade}`] || 1) : 1;
        if (own.length && what) { hidden.set(id, own); ref.set(id, Math.round(scale * Math.min(...own.map(row => row.price)))); }
    }
    const cWeapons = [...ref].filter(([id]) => kindOf(id).kind === 'gear' && kindOf(id).grade === 'C' && Engine.isWeapon(view.items[id])).map(([, price]) => price);
    const cWeaponRef = cWeapons.length ? cWeapons.reduce((a, b) => a + b, 0) / cWeapons.length : 0;
    // The same mean at the configured store price (GNOME_REF_C apart): the materials' turnover is not a gear price.
    const cStore = [...hidden].filter(([id]) => kindOf(id).kind === 'gear' && kindOf(id).grade === 'C' && Engine.isWeapon(view.items[id])).map(([, rows]) => Math.min(...rows.map(row => row.price)));
    const cWeaponStore = cStore.length ? cStore.reduce((a, b) => a + b, 0) / cStore.length : 0;
    // The mean hidden-store price of each grade's weapons (a crafter's stock cost).
    const weaponRefs = new Map(GRADES.map(grade => {
        const prices = [...ref].filter(([id]) => kindOf(id).kind === 'gear' && kindOf(id).grade === grade && Engine.isWeapon(view.items[id])).map(([, price]) => price);
        return [grade, prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : 0];
    }));
    // The materials of the recipes of the goods the trade covers.
    const materials = new Set();
    for (const recipe of recipes || []) if (kindOf(Number(recipe.productId))) for (const m of recipe.materials) materials.add(Number(m.selfId));

    // The level a gnome line unlocks a trade good at (0 for any other item), cached per (line, id).
    const recipeLevel = new Map((recipes || []).map(recipe => [Number(recipe.productId), Number(recipe.level)]));
    const tiers = tiersOf(view, ladders), maxLevel = view.maxLevel || 80;
    // A line's grade bands from its grades' first levels: each grade up to the next grade's first level minus one.
    const toOfFrom = from => grade => Math.min(maxLevel, ...GRADES.slice(GRADES.indexOf(grade) + 1).map(next => from[next] - 1));
    // The tier ladder: each grade's tiers at their unlock levels, lowest first.
    const ladderOf = from => {
        const toOf = toOfFrom(from), ladder = [];
        for (const grade of GRADES) {
            const first = from[grade], to = toOf(grade);
            if (!Number.isFinite(first) || to < first) continue;
            for (let tier = 0; tier < TIERS; tier++) ladder.push({ level: first + Math.round(tier * (to + 1 - first) / TIERS), grade, tier });
        }
        return ladder.sort((a, b) => a.level - b.level || GRADE_ORDER[a.grade] - GRADE_ORDER[b.grade] || a.tier - b.tier);
    };
    // The levels of a (grade, tier) step on the spoiler ladder: [its level, the next step's level - 1] (null: no such step).
    const spoilerLadder = ladderOf(SPOILER_FROM);
    const spoilerSpan = (grade, tier) => {
        const at = spoilerLadder.findIndex(step => step.grade === grade && step.tier === tier);
        return at < 0 ? null : [spoilerLadder[at].level, (spoilerLadder[at + 1]?.level ?? maxLevel + 1) - 1];
    };
    const plans = new Map([...lines].map(line => {
        const craft = craftLevels[line] || [], crafter = craft.some(level => level > 1);
        const reach = need => { for (let level = 1; level <= maxLevel; level++) if ((craft[level] || 0) >= need) return level; return Infinity; };
        const lowest = kind => Object.fromEntries(GRADES.map(grade => [grade, Math.min(...(recipes || []).filter(recipe => {
            const what = kindOf(Number(recipe.productId));
            return what && what.kind === kind && what.grade === grade;
        }).map(recipe => Number(recipe.level)))]));
        const gearNeed = lowest('gear'), shotNeed = lowest('shot');
        const from = crafter ? Object.fromEntries(GRADES.map(grade => [grade, reach(gearNeed[grade])])) : SPOILER_FROM;
        const shotFrom = crafter ? Object.fromEntries(GRADES.map(grade => [grade, reach(shotNeed[grade])])) : SPOILER_FROM;
        return [line, { crafter, from, shotFrom, toOf: toOfFrom(from), reach, ladder: ladderOf(from), cache: new Map() }];
    }));
    const unlockLevel = (line, id) => {
        const plan = plans.get(String(line));
        if (plan.cache.has(id)) return plan.cache.get(id);
        const what = kindOf(id);
        let level = 0;
        if (what?.kind === 'shot') level = plan.shotFrom[what.grade];
        else if (what?.kind === 'scroll') level = plan.from[what.grade];
        else if (what?.kind === 'gear') {
            if (plan.crafter && recipeLevel.has(id)) level = plan.reach(recipeLevel.get(id));
            else { const from = plan.from[what.grade], to = plan.toOf(what.grade); level = from + Math.round((tiers.get(id) || 0) * (to + 1 - from) / TIERS); }
        }
        plan.cache.set(id, level ?? Infinity);
        return plan.cache.get(id);
    };
    const unlocks = (line, level, id) => level >= unlockLevel(line, id);
    // A line's top unlocked tier at a level and its next one (null: none).
    const topTier = (line, level) => plans.get(String(line)).ladder.filter(step => step.level <= level).pop() || null;
    const nextTier = (line, level) => plans.get(String(line)).ladder.find(step => step.level > level) || null;
    const isCrafter = main => plans.get(String(main.line))?.crafter === true;
    // The C+ gear pieces a line unlocks at a level (cached per (line, level)); a wallet covers its stock when it holds the
    // wholesale of the cheapest of them at today's price (true when it unlocks none).
    const gearIds = [...ref.keys()].filter(id => kindOf(id).kind === 'gear'), unlockedGear = new Map();
    const stocked = (line, level, money) => {
        const key = `${line}|${level}`;
        if (!unlockedGear.has(key)) unlockedGear.set(key, gearIds.filter(id => unlocks(line, level, id)));
        const ids = unlockedGear.get(key);
        return !ids.length || ids.some(id => money >= gearWholesale(id));
    };
    const modes = new Map(), merchant = index => modes.get(index)?.mode === 'merchant';
    // The merchants whose town sold a piece of their top tier in the open hour.
    const topSold = new Set();

    const isGnome = main => lines.has(String(main.line));
    const mult = new Map(), keyOf = (kind, grade, town) => (kind === 'shot' ? `shot|${grade}|${town}` : `${kind}|${grade}`);
    const multOf = key => mult.get(key) ?? START;
    const bids = new Map(), bidOf = town => bids.get(town) ?? BID.start;
    const stock = Object.fromEntries(Object.entries(SCROLLS_PER_HOUR).map(([grade, n]) => [grade, n]));
    const townsOf = new Map(), latest = new Map(), pending = new Map(), pool = new Map(), shops = new Map(), allowance = new Map(), townAllowance = new Map();
    let served = null, tops = null, merchants = null, townThermo = null;
    const thermo = new Map(), thermoOf = index => thermo.get(index) || { bid: BID.start, share: 1 };
    const servedTowns = () => {
        if (served) return served;
        served = new Map();
        townAllowance.clear();
        tops = new Map();
        merchants = new Map();
        townThermo = new Map();
        for (const [index, towns] of townsOf) for (const town of towns) {
            if (!served.has(town)) { served.set(town, []); tops.set(town, new Map()); merchants.set(town, []); }
            served.get(town).push(index);
            const own = thermoOf(index), held = townThermo.get(town) || { bid: 0, share: 1 };
            townThermo.set(town, { bid: Math.max(held.bid, own.bid), share: Math.min(held.share, own.share) });
            if (merchant(index)) { merchants.get(town).push(index); continue; }
            const { line, level } = latest.get(index), top = tops.get(town);
            top.set(line, Math.max(top.get(line) || 0, level));
        }
        return served;
    };
    const wallet = index => (latest.get(index)?.money || 0) + (pending.get(index) || 0);
    // Does a gnome serving the town unlock the item (its highest level per gnome line there; a merchant also needs the
    // item's wholesale in its wallet)?
    const unlockedIn = (town, id) => {
        servedTowns();
        for (const [line, level] of tops.get(town) || []) if (unlocks(line, level, id)) return true;
        const sellers = merchants.get(town) || [];
        if (!sellers.length) return false;
        const what = kindOf(id), wholesale = priceAt(id, wholesaleMult(multOf(keyOf(what.kind, what.grade, town))));
        return sellers.some(index => { const row = latest.get(index); return unlocks(row.line, row.level, id) && wallet(index) >= wholesale; });
    };
    // The gear allowance of a grade of a town's gnomes (cached until a sale, an hour's close or a change of the towns served).
    const allowanceIn = (town, grade) => {
        const key = `${town}|${grade}`;
        if (!townAllowance.has(key)) townAllowance.set(key, (servedTowns().get(town) || []).reduce((sum, index) => sum + (allowance.get(`${index}|${grade}`) || 0), 0));
        return townAllowance.get(key);
    };
    // A gnome gear sale in a town draws its pieces from the town's gnomes' allowance of the grade, in their order.
    const draw = (town, grade, value) => {
        for (const index of servedTowns().get(town) || []) {
            if (value <= 0) break;
            const key = `${index}|${grade}`, take = Math.min(value, allowance.get(key) || 0);
            allowance.set(key, (allowance.get(key) || 0) - take);
            value -= take;
        }
        townAllowance.clear();
    };
    const gearWholesale = id => priceAt(id, wholesaleMult(multOf(keyOf('gear', gradeOfItem(id)))));
    // The hour's books: demand and supply by market key, the margin by town.
    let hour = { demand: new Map(), offered: new Map(), sold: new Map(), stock: { ...stock } };
    const crafterStats = { merchantHours: 0, huntHours: 0, levels: {}, switches: 0 };
    const stats = { crafter: crafterStats, shotUnits: { gnome: 0, valve: 0, own: 0 }, gearPieces: { gnome: 0, valve: 0, own: 0 }, scrolls: { supplied: 0, bought: 0, refused: 0, dropUsed: 0 },
        gearWait: { started: 0, ended: [], open: new Map() }, margin: 0, spread: 0, hiddenSpend: { gnomeWholesale: 0, valve: 0, gnomeOwn: 0 }, credited: 0, index: {}, money: {}, shotsPerHour, shop: { reads: 0, sum: 0 }, gearWanted: 0 };
    const add = (map, key, value) => map.set(key, (map.get(key) || 0) + value);
    const priceAt = (id, m) => Math.round(ref.get(id) * m);
    const wholesaleMult = m => share * m;

    // The offers a main reads (a view for Engine.sellerOf): the trade's goods re-priced for a gnome (gnome: { line,
    // level }: the hidden store's rows of what its level unlocks) or another main (null: the gnome rows of the towns
    // where a serving gnome unlocks it; for shots the valve where none does).
    const rowsFor = (gnome, id) => {
        const base = view.offers.get(id);
        const what = hidden.has(id) ? kindOf(id) : null;
        if (!what) return base;
        const others = base.filter(row => row.channel !== 'fixed_wts');
        if (gnome) {
            if (!unlocks(gnome.line, gnome.level, id)) return others;
            // Its own gear at the market price (maintainer, ours: it gears no earlier than another main); shots and scrolls at the wholesale.
            const own = m => (what.kind === 'gear' ? m : wholesaleMult(m));
            return [...others, ...hidden.get(id).map(row => ({ ...row, price: priceAt(id, own(multOf(keyOf(what.kind, what.grade, row.town)))) }))];
        }
        const towns = [...servedTowns().keys()].filter(town => unlockedIn(town, id) && (what.kind !== 'gear' || allowanceIn(town, what.grade) >= 1));
        const gnomeRows = towns.map(town => {
            const m = multOf(keyOf(what.kind, what.grade, town)), cut = townThermo.get(town)?.share ?? 1;
            return { town, price: priceAt(id, wholesaleMult(m) + cut * (m - wholesaleMult(m))), channel: 'gnome' };
        });
        const valve = what.kind !== 'shot' ? [] : hidden.get(id).filter(row => !towns.includes(row.town)).map(row => ({ ...row, price: Math.round(ref.get(id) * VALVE) }));
        return [...others, ...gnomeRows, ...valve];
    };
    const otherView = { ...view, offers: { get: id => rowsFor(null, Number(id)) } }, gnomeViews = new Map();
    const viewOf = main => {
        if (!isGnome(main)) return otherView;
        const key = `${main.line}|${main.level}`;
        if (!gnomeViews.has(key)) { const gnome = { line: String(main.line), level: main.level }; gnomeViews.set(key, { ...view, offers: { get: id => rowsFor(gnome, Number(id)) } }); }
        return gnomeViews.get(key);
    };

    return {
        isGnome,
        priced: viewOf,
        kindOf,
        scrollStock: grade => stock[grade] || 0,
        // A main heard at a hook: its money (the KPI's snapshots, a gnome's wallet for the supply); a gnome's towns.
        seen(main, towns = null) {
            const before = latest.get(main.index);
            latest.set(main.index, { money: main.money, level: main.level, gnome: isGnome(main), line: String(main.line), weapon: main.weapon });
            if (towns && isGnome(main)) { townsOf.set(main.index, [...new Set(towns.filter(Boolean))]); served = null; }
            else if (isGnome(main) && before && before.level !== main.level && townsOf.has(main.index)) served = null;
        },
        unlockLevel,
        isCrafter,
        merchant,
        // A crafter's mode at its visit (birth included): hunting until its level reaches the tier it hunts for, else a
        // merchant; before its first unlock it hunts for it. null for any other main.
        modeAt(main) {
            if (!isCrafter(main)) return null;
            const held = modes.get(main.index), money = main.money + (pending.get(main.index) || 0);
            if (held?.mode === 'merchant' || (held?.mode === 'hunt' && main.level < held.until && !(held.broke && stocked(main.line, main.level, money)))) return held.mode;
            const first = !topTier(main.line, main.level) ? nextTier(main.line, main.level) : null;
            const broke = !first && !stocked(main.line, main.level, money);
            modes.set(main.index, first ? { mode: 'hunt', until: first.level } : broke ? { mode: 'hunt', until: nextTier(main.line, main.level)?.level ?? Infinity, broke: true } : { mode: 'merchant', until: null });
            if (held) crafterStats.switches++;
            served = null;
            return modes.get(main.index).mode;
        },
        // A gnome's share of its hours spent tending its shop (SHOP), from the last closed hour.
        shopShare(index) { const share = SPOILER_SHOP ?? shops.get(index) ?? SHOP.base; stats.shop.reads++; stats.shop.sum += share; return share; },
        // The gnome bid for a main's material sale in a town, or null (a gnome main, no gnome there, not a material).
        bid(main, town, id) {
            if (isGnome(main) || !town || !materials.has(Number(id)) || !servedTowns().has(town)) return null;
            return Math.round((view.items[id]?.npcBuy || 0) * Math.max(bidOf(town), townThermo.get(town)?.bid || 0));
        },
        // A sale to the gnome (an executed NPC sale re-booked): the seller got count x bid; the fixed buyer pays the
        // faucet, the spread goes to the town's margin.
        soldToGnome(delta, town, action) {
            const value = action.count * action.price, buyer = action.count * Math.round((view.items[action.id]?.npcBuy || 0) * BID.buyer);
            delta.flows.npcSales -= value;
            delta.flows.fixedBuyers += buyer;
            add(pool, town, buyer - value);
            stats.spread += buyer - value;
            add(hour.offered, town, value);
        },
        // The purchases a chain made at town: gnome channel entries ({ id, count, price }) get their wholesale sink and margin;
        // a gnome's or a valve purchase from the hidden store is counted.
        settle(main, delta, town) {
            for (const entry of delta.gnome.splice(0)) {
                const what = kindOf(entry.id), m = multOf(keyOf(what.kind, what.grade, town)), wholesale = priceAt(entry.id, wholesaleMult(m));
                delta.flows.fixedSellers -= entry.count * wholesale;
                add(pool, town, entry.count * (entry.price - wholesale));
                stats.margin += entry.count * (entry.price - wholesale);
                add(hour.sold, town, entry.count * entry.price);
                stats.hiddenSpend.gnomeWholesale += entry.count * wholesale;
                add(hour.demand, keyOf(what.kind, what.grade, town), entry.count * (what.kind === 'gear' ? wholesale : 1));
                if (what.kind === 'gear') {
                    draw(town, what.grade, entry.count);
                    for (const index of merchants.get(town) || []) {
                        const row = latest.get(index), top = topTier(row.line, row.level);
                        if (top && top.grade === what.grade && top.tier === (tiers.get(entry.id) ?? 0)) topSold.add(index);
                    }
                }
                if (what.kind === 'shot') stats.shotUnits.gnome += entry.count; else if (what.kind === 'gear') stats.gearPieces.gnome += entry.count;
                else { stats.scrolls.bought += entry.count; stock[what.grade] -= entry.count; }
            }
            for (const entry of delta.hidden.splice(0)) {
                const what = hidden.has(entry.id) ? kindOf(entry.id) : null, own = isGnome(main);
                if (!what) continue;
                stats.hiddenSpend[own ? 'gnomeOwn' : 'valve'] += entry.count * entry.price;
                const book = what.kind === 'shot' ? stats.shotUnits : what.kind === 'gear' ? stats.gearPieces : null;
                if (book) book[own ? 'own' : 'valve'] += entry.count;
                else { stats.scrolls.bought += entry.count; stock[what.grade] -= entry.count; add(hour.demand, keyOf('scroll', what.grade), entry.count); }
            }
        },
        // A scroll try refused for an empty stock: the units wanted the market reads.
        refused(grade) { stats.scrolls.refused++; add(hour.demand, keyOf('scroll', grade), 1); },
        // A non-gnome's C+ gear purchase (id) the hidden store would fund but no gnome in reach sells: its wait starts (once);
        // its wholesale value is the hour's gear demand.
        gearWaits(main, now, id) {
            if (!stats.gearWait.open.has(main.index)) { stats.gearWait.open.set(main.index, now); stats.gearWait.started++; }
            const what = kindOf(id);
            if (what?.kind === 'gear') { add(hour.demand, keyOf('gear', what.grade), gearWholesale(id)); stats.gearWanted++; }
        },
        // A gear piece bought from a gnome ends its wait.
        gearBought(main, now) { const at = stats.gearWait.open.get(main.index); if (at !== undefined) { stats.gearWait.ended.push(now - at); stats.gearWait.open.delete(main.index); } },
        droppedScrollUsed() { stats.scrolls.dropUsed++; },
        // The hour's close: the margins split among each town's gnomes, the prices' drift, the scroll stock's refill.
        close(at) {
            const towns = servedTowns();
            for (const [town, amount] of pool) {
                const gnomes = towns.get(town);
                if (!gnomes?.length || amount <= 0) continue;
                const each = Math.floor(amount / gnomes.length);
                for (const index of gnomes) pending.set(index, (pending.get(index) || 0) + each);
                pool.set(town, amount - each * gnomes.length);
            }
            // The materials a town's gnomes take in an hour: the same turnover, GEAR_WEAPONS_PER_GNOME C weapons' value each.
            const materialCapacity = town => (towns.get(town)?.length || 0) * GEAR_WEAPONS_PER_GNOME * cWeaponStore;
            const gearCapacity = townsOf.size * GEAR_WEAPONS_PER_GNOME * cWeaponRef * wholesaleMult(multOf(keyOf('gear', 'C')));
            // Each gnome's gear allowance in pieces of each grade: an hour's worth more, at most STOCK_HOURS hours' worth.
            for (const index of townsOf.keys()) for (const grade of GEAR_GRADES) {
                const key = `${index}|${grade}`;
                allowance.set(key, Math.min(STOCK_HOURS * GEAR_PIECES_PER_GNOME, (allowance.get(key) || 0) + GEAR_PIECES_PER_GNOME));
            }
            townAllowance.clear();
            const shotCapacity = (grade, town) => (towns.get(town)?.length || 0) * SHOT_MAINS_PER_GNOME * (shotsPerHour[grade] || 0);
            const keys = new Set([...mult.keys(), ...hour.demand.keys()]);
            for (const key of keys) {
                const [kind, grade, town] = key.split('|');
                const supply = kind === 'shot' ? shotCapacity(grade, town) : kind === 'gear' ? gearCapacity : hour.stock[grade];
                const ceiling = kind === 'scroll' ? SCROLL_CEILING : CEILING;
                mult.set(key, Math.min(ceiling, Math.max(1, multOf(key) * ((hour.demand.get(key) || 0) > supply ? STEP : 1 / STEP))));
            }
            for (const town of new Set([...bids.keys(), ...hour.offered.keys()])) {
                bids.set(town, Math.min(BID.high, Math.max(BID.low, bidOf(town) * ((hour.offered.get(town) || 0) > materialCapacity(town) ? 1 / STEP : STEP))));
            }
            // Each gnome's shop share for its next visits: its served turnover of the hour over one gnome's capacity.
            const served = new Map(), capacity = GEAR_WEAPONS_PER_GNOME * cWeaponRef;
            for (const [town, gnomes] of towns) {
                const each = ((hour.sold.get(town) || 0) + (hour.offered.get(town) || 0)) / gnomes.length;
                for (const index of gnomes) served.set(index, (served.get(index) || 0) + each);
            }
            shops.clear();
            for (const [index, value] of served) shops.set(index, SHOP.base + SHOP.busy * (capacity > 0 ? Math.min(1, value / capacity) : 0));
            for (const [grade, n] of Object.entries(SCROLLS_PER_HOUR)) { stock[grade] = Math.min(STOCK_HOURS * n, stock[grade] + n); stats.scrolls.supplied += n; }
            hour = { demand: new Map(), offered: new Map(), sold: new Map(), stock: { ...stock } };
            if (at === 20 || at === 50 || at === 100) this.snapshot(at);
            return this.crafters(at);
        },
        // The crafters' modes at an hour's close: its hours by mode, and the merchants that go hunting (their indexes): a
        // wallet short of its cheapest piece, or the non-gnome mains of its top tier's spoiler-ladder span wearing that tier or better.
        crafters(at) {
            let ranks = null;
            const rankOf = (grade, tier) => (GRADE_ORDER[grade] ?? 0) * TIERS + tier;
            const released = [];
            // The thermostat: the non-gnome wallets by level, each gnome's target and step (the KPI's p50s: crafters).
            const byLevel = new Map();
            for (const [index, row] of latest) if (!row.gnome) { if (!byLevel.has(row.level)) byLevel.set(row.level, []); byLevel.get(row.level).push(wallet(index)); }
            const ratios = [], spoilerRatios = [];
            for (const [index, row] of latest) {
                if (!row.gnome) continue;
                const near = [];
                for (let level = row.level - THERMO.levels; level <= row.level + THERMO.levels; level++) near.push(...(byLevel.get(level) || []));
                near.sort((a, b) => a - b);
                const top = topTier(row.line, row.level), weapons = top ? weaponRefs.get(top.grade) : null;
                const stockCost = weapons ? weapons * wholesaleMult(multOf(keyOf('gear', top.grade))) * STOCK_HOURS * GEAR_PIECES_PER_GNOME : 0;
                const target = THERMO.wallet * (near.length ? near[Math.floor(near.length / 2)] : 0) + stockCost, own = thermoOf(index), rich = wallet(index) > target;
                thermo.set(index, rich ? { bid: Math.min(BID.high, own.bid * THERMO.step), share: Math.max(0, own.share / THERMO.step) }
                    : { bid: Math.max(BID.low, own.bid / THERMO.step), share: Math.min(1, own.share * THERMO.step) });
                (modes.has(index) ? ratios : spoilerRatios).push(target > 0 ? wallet(index) / target : 0);
            }
            served = null;
            if (at === 10 || at === 50 || at === 100) {
                const p50 = values => { const v = [...values].sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
                const fix = v => (v === null ? '-' : v.toFixed(2));
                (crafterStats.wallet ||= {})[at] = fix(p50(ratios));
                const crafterThermo = [...modes.keys()].map(thermoOf);
                (crafterStats.bid ||= {})[at] = fix(p50(crafterThermo.map(t => t.bid)));
                (crafterStats.margin ||= {})[at] = fix(p50(crafterThermo.map(t => t.share)));
                (crafterStats.spoilerWallet ||= {})[at] = fix(p50(spoilerRatios));
                (crafterStats.spoilerMargin ||= {})[at] = fix(p50([...latest].filter(([index, row]) => row.gnome && !modes.has(index)).map(([index]) => thermoOf(index).share)));
            }
            for (const [index, held] of modes) {
                crafterStats[held.mode === 'merchant' ? 'merchantHours' : 'huntHours']++;
                if (held.mode !== 'merchant') continue;
                const row = latest.get(index), top = topTier(row.line, row.level), next = nextTier(row.line, row.level);
                const idle = topSold.has(index) ? 0 : (held.idle || 0) + 1;
                modes.set(index, { ...held, idle });
                if (!stocked(row.line, row.level, wallet(index))) {
                    modes.set(index, { mode: 'hunt', until: next ? next.level : Infinity, broke: true });
                    crafterStats.switches++;
                    crafterStats.broke = (crafterStats.broke || 0) + 1;
                    served = null;
                    released.push(index);
                    continue;
                }
                if (!top || !next) continue;
                // The non-gnome mains' weapon ranks by level (once per close).
                if (!ranks) {
                    ranks = new Map();
                    for (const other of latest.values()) {
                        if (other.gnome) continue;
                        if (!ranks.has(other.level)) ranks.set(other.level, []);
                        ranks.get(other.level).push(rankOf(gradeOfItem(other.weapon), tiers.get(other.weapon) ?? 0));
                    }
                }
                const need = rankOf(top.grade, top.tier), span = [], [low, high] = spoilerSpan(top.grade, top.tier) || [1, 0];
                for (let level = low; level <= high; level++) span.push(...(ranks.get(level) || []));
                const worn = span.length && span.filter(rank => rank >= need).length >= HUNT_WHEN * span.length;
                if (worn || idle >= IDLE_HOURS) {
                    modes.set(index, { mode: 'hunt', until: next.level });
                    if (!worn) crafterStats.idle = (crafterStats.idle || 0) + 1;
                    crafterStats.switches++;
                    served = null;
                    released.push(index);
                }
            }
            topSold.clear();
            if (at === 10 || at === 50 || at === 100) {
                const levels = [...modes.keys()].map(index => latest.get(index).level).sort((a, b) => a - b);
                crafterStats.levels[at] = levels.length ? levels[Math.floor(levels.length / 2)] : null;
            }
            return released;
        },
        // The KPI at an hour: the price index per grade (shots: the mean over the towns priced) and the money per main by band.
        snapshot(at) {
            const index = {};
            for (const [key, m] of mult) {
                const [kind, grade] = key.split('|'), name = `${kind} ${grade}`;
                (index[name] ||= []).push(m);
            }
            stats.index[at] = Object.fromEntries(Object.entries(index).map(([name, ms]) => [name, ms.reduce((a, b) => a + b, 0) / ms.length]));
            const bands = {};
            for (const [index, row] of latest) {
                const band = row.level <= 19 ? '1-19' : row.level <= 39 ? '20-39' : row.level <= 59 ? '40-59' : '60+';
                const book = bands[band] ||= { gnome: [0, 0], other: [0, 0] }, side = book[row.gnome ? 'gnome' : 'other'];
                side[0] += row.money + (pending.get(index) || 0);
                side[1]++;
            }
            stats.money[at] = bands;
        },
        // A gnome's credited margin at its visit (taken from the plane's holding).
        credit(index) { const amount = pending.get(index) || 0; pending.delete(index); stats.credited += amount; return amount; },
        held: () => [...pool.values(), ...pending.values()].reduce((a, b) => a + b, 0),
        // The margin held for a gnome until its next visit (the KPI's money per line).
        owed: index => pending.get(index) || 0,
        stats
    };
}

module.exports = { market, tiersOf, SCROLLS_PER_HOUR, SPOILER_FROM, SHOP };
