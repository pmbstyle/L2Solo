'use strict';

// The design bot's gear purchase at a town visit, by the game's rule for an
// NPC world (GearAcquisitionPlanner.staticNpcUpgradePlan, the first source
// the game's gear plan tries): nothing below the gear focus level; the
// adequate kit first, slot by slot in the game's order, the cheapest
// suitable NPC piece at the highest grade the level takes (D from 20), an
// unfunded weapon not blocking affordable armour; then, at no-grade and D
// levels, improvements by gain over price. It reads the main's worn kit and
// wallet through the game's reference body of its line and level; the
// money it keeps is the reserve the caller names (the game's refill reserve
// in the money packet). Called by the design plane in a town chain after its
// sales. Needs Boot.boot() (the game's catalog and planner).
const Engine = require('./engine');
const KitHours = require('./kit-hours');

// npcGear({ snapshot, view }) -> { next(main, town, reserve) }: the piece the
// game's rule buys next for the main standing in town, among the NPCs of every
// town (the game's gear errand reads all towns' NPC offers): its seller is the
// NPC of the town it stands in when that town sells the piece, else the first
// of the other towns by price plus the fare to its town (Engine.sellerOf; the NPCs sell gear
// up to D, the configured stores their shots and the bot-only C/B/A reserve). Funded now
// from the adena above reserve, the fare to the seller's town included (our
// choice: the teleport is paid from the same wallet), or null:
// { selfId, slot, price, weapon, town, fare, channel }. The answer reads the wallet, so
// it is not cached; the line's reference body of a level is (it reads only the
// class, level and line).
function npcGear({ snapshot, view }) {
    const Table = invoke('GameServer/Bot/AI/SpotValueTable'), HuntCycle = invoke('GameServer/Bot/AI/HuntCycle');
    const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner'), PurchaseFunding = invoke('GameServer/Bot/Economy/PurchaseFunding');
    const StatsPacket = invoke('GameServer/Bot/Economy/StatsPacket');
    const Templates = invoke('GameServer/Item/ItemTemplateIndex'), DataCache = invoke('GameServer/DataCache');
    const bodies = new Map();
    const bodyOf = (classId, level, line) => {
        const key = `${classId}:${level}:${line}`;
        if (!bodies.has(key)) bodies.set(key, HuntCycle.referenceState(classId, level, { line }));
        return bodies.get(key);
    };
    return {
        next(main, town, reserve, priced = view) {
            const classId = Table.roleClass(main.line, main.level), body = bodyOf(classId, main.level, Number(main.line));
            const pieces = Object.entries(KitHours.kitInHand(snapshot, main)).filter(([, selfId]) => selfId > 0)
                .map(([slot, selfId]) => ({ slot: Number(slot), selfId: Number(selfId) }));
            const state = { ...body, adena: main.money, inventory: { ...KitHours.inventoryOf(pieces), 57: { selfId: 57, amount: main.money } },
                stats: { ...body.stats, money: StatsPacket.money({ hourAdena: 0, moneyPrice: 0, refillReserve: Math.round(reserve), firstUnfundedPrice: 0 }) } };
            // The NPC that sells the piece: this town's, else the first elsewhere by price and fare.
            const sellers = new Map();
            const findNpcOffer = target => {
                const seller = Engine.sellerOf(priced, target.selfId, town);
                if (!seller) return null;
                sellers.set(Number(target.selfId), seller);
                return { sourceType: 'npc', price: seller.price, town: seller.town };
            };
            const plan = Planner.staticNpcUpgradePlan(state, { findNpcOffer, buyOrderEscrow: 0 });
            // A dual-only class without a dual sword (the game's dual-sword bridge: two NPC blades combined at the
            // blacksmith): the model buys the combination's product at the bridge's cost (its blades' prices) from the
            // first blade's seller (ours: the bag between the two blades and the combine are not modelled; bought as the
            // blade it would wear, each visit replaced the other blade and the line never held a dual).
            if (plan?.weaponBridge && plan.combine) {
                const blade = sellers.get(Number(plan.target.selfId)), selfId = Number(plan.combine.resultId), price = Number(plan.bridgeCost);
                if (!blade || !(price + blade.fare <= PurchaseFunding.spendable(state, 0, { upperBound: true }))) return null;
                const slot = Number(Templates.find(DataCache.items, selfId)?.etc?.slot || 14);
                return { selfId, slot, price, weapon: true, town: blade.town, fare: blade.fare, channel: blade.channel };
            }
            // Funded in the game's terms (npcPurchaseBudget): the price, and here the fare, within the wallet above the reserve.
            const seller = plan?.market ? sellers.get(Number(plan.target.selfId)) : null;
            if (!seller || !(Number(plan.market.price) + seller.fare <= PurchaseFunding.spendable(state, 0, { upperBound: true }))) return null;
            // The plan names the weapon slot (7) for any weapon; a weapon is worn in its own slot (a two-handed one in 14).
            const selfId = Number(plan.target.selfId), weapon = Engine.isWeapon(view.items[selfId]);
            const slot = weapon ? Number(Templates.find(DataCache.items, selfId)?.etc?.slot || plan.target.slot) : Number(plan.target.slot);
            return { selfId, slot, price: Number(plan.market.price), weapon, town: seller.town, fare: seller.fare, channel: seller.channel };
        }
    };
}

// kitReserve({ snapshot, view }) -> { next(main, town, reserve) }: a stub of the
// game's C/B/A gear purchase (the full planner is not modelled): the piece of the
// line's reference kit at the main's level (view.kits) of grade C, B or A that the
// main wears at a lower grade, weapon first, then armour, then jewels, bought from
// the cheapest reserve offer (Engine.sellerOf, a configured store's gear line) when
// the wallet above reserve pays its price and the fare to its town. The weapon steps
// by grade: the kit weapons of the levels below count too while above the worn grade
// (a C before the B), and a weapon none of them pays is saved for (nothing else of the
// kit is bought: null). null when there is none. Same answer shape as npcGear's next.
const GRADE_ORDER = { NONE: 0, D: 1, C: 2, B: 3, A: 4, S: 5 };
const KIT_ORDER = slot => (slot >= 1 && slot <= 5 ? 2 : 1);
function kitReserve({ snapshot, view }) {
    const Templates = invoke('GameServer/Item/ItemTemplateIndex'), DataCache = invoke('GameServer/DataCache');
    const gradeOf = id => GRADE_ORDER[String(view.items[id]?.grade || 'NONE').toUpperCase()] ?? 0;
    return {
        next(main, town, reserve, priced = view) {
            const rows = view.kits?.[main.line]?.[main.level];
            if (!rows) return null;
            const worn = KitHours.kitInHand(snapshot, main);
            const buyOf = (row, weapon, seller) => {
                const slot = weapon ? Number(Templates.find(DataCache.items, row.selfId)?.etc?.slot || row.slot) : Number(row.slot);
                return { selfId: Number(row.selfId), slot, price: seller.price, weapon, town: seller.town, fare: seller.fare, channel: seller.channel };
            };
            const reserveSeller = id => { const seller = Engine.sellerOf(priced, id, town); return seller?.channel === 'fixed_wts' || seller?.channel === 'gnome' ? seller : null; };
            const funded = seller => seller.price + seller.fare <= main.money - reserve;
            // The weapon: the kit's weapon of this level, then those of the levels below it while they are above the worn
            // grade (the grade below the kit's first: a C before the B), the highest funded one bought; none funded: it
            // saves for the best of them that has a seller (nothing else of the kit is bought).
            const isWeaponRow = row => Engine.isWeapon(view.items[row.selfId]);
            const above = row => gradeOf(row.selfId) >= GRADE_ORDER.C && gradeOf(row.selfId) > gradeOf(main.weapon);
            const seen = new Set();
            let saving = false;
            for (let level = main.level; level >= 1; level--) {
                const found = (view.kits?.[main.line]?.[level] || []).filter(row => isWeaponRow(row) && above(row));
                if (!found.length) break;
                for (const row of found) {
                    if (seen.has(row.selfId)) continue;
                    seen.add(row.selfId);
                    const seller = reserveSeller(row.selfId);
                    if (!seller) continue;
                    if (funded(seller)) return buyOf(row, true, seller);
                    saving = true;
                }
            }
            if (saving) return null;
            const wanted = rows.filter(row => !isWeaponRow(row) && gradeOf(row.selfId) >= GRADE_ORDER.C && gradeOf(row.selfId) > gradeOf(worn[row.slot]))
                .sort((x, y) => KIT_ORDER(x.slot) - KIT_ORDER(y.slot));
            for (const row of wanted) {
                const seller = reserveSeller(row.selfId);
                if (seller && funded(seller)) return buyOf(row, false, seller);
            }
            return null;
        }
    };
}

// The normal weapon enchant scrolls by grade (C4EnchantScrolls): { grade: scrollId }.
function weaponScrolls() {
    const Scrolls = invoke('GameServer/Items/C4EnchantScrolls'), scrollOf = {};
    for (const [id, row] of Object.entries(Scrolls.ENCHANT_SCROLLS)) if (row.target === 'weapon' && row.scrollType === 'normal') scrollOf[row.grade] = Number(id);
    return scrollOf;
}

// kitWeaponGrade(view, line, level): the GRADE_ORDER of the line's kit weapon at the
// level, at most A (no store sells an S weapon: the A weapon is the S levels' grade weapon).
function kitWeaponGrade(view, line, level) {
    let grade = 0;
    for (const row of view.kits?.[line]?.[level] || []) {
        if (Engine.isWeapon(view.items[row.selfId])) grade = Math.max(grade, GRADE_ORDER[String(view.items[row.selfId]?.grade || 'NONE').toUpperCase()] ?? 0);
    }
    return Math.min(grade, GRADE_ORDER.A);
}

// weaponEnchant({ view }) -> { next(main, town, reserve) }: a stub of a C4 player's
// weapon enchanting, our cheat for the economy (the money sink: the hunt reads no
// enchant). A main wearing a weapon of its level's kit weapon grade (C, B or A)
// enchants it toward its target: the game's safe level (C4EnchantRules safeMax, +3),
// +6 for an ambitious persona (ambition at the cohort's high trait, 0.62: ours).
// Each try is one Scroll: Enchant Weapon of the weapon's grade (C4EnchantScrolls,
// normal) from its cheapest seller (Engine.sellerOf: the reserve store, no C4 NPC
// sells it), bought while the wallet above the reserve keeps more than
// ENCHANT_WALLET_WEAPONS times the weapon's price after the scroll and its fare.
// A try below the safe level succeeds, past it at the game's weapon chance (68 %);
// a failure breaks the weapon (Enchant.enchant 'break'; its crystals are not modelled).
// The next try, or null: { scrollId, price, town, fare, channel, chance }.
const ENCHANT_WALLET_WEAPONS = 3;
const AMBITIOUS_TRAIT = 0.62;
const ENCHANT_AMBITIOUS_TARGET = 6;
function weaponEnchant({ view, personas }) {
    const Rules = invoke('GameServer/Items/C4EnchantRules');
    const config = Rules.configWith(globalThis.options?.default?.Enchant || {});
    const scrollOf = weaponScrolls();
    const gradeName = id => String(view.items[id]?.grade || 'NONE').toUpperCase();
    // The scroll its weapon takes next while below its target, with the try's chance; null at the target.
    const wanted = main => {
        const grade = gradeName(main.weapon), order = GRADE_ORDER[grade] ?? 0, level = main.enchant || 0;
        if (order < GRADE_ORDER.C || order !== kitWeaponGrade(view, main.line, main.level) || !scrollOf[grade]) return null;
        const ambitious = Number(personas.get(main.id)?.traits?.ambition) >= AMBITIOUS_TRAIT;
        const max = Rules.maxFor('weapon', config);
        if (level >= (ambitious ? ENCHANT_AMBITIOUS_TARGET : Number(config.safeMax)) || (max > 0 && level >= max)) return null;
        return { scrollId: scrollOf[grade], chance: Rules.isSafe({ isWeapon: () => true }, level, config) ? 100 : Rules.chanceFor('weapon', 'normal', config) };
    };
    return {
        wanted,
        next(main, town, reserve, priced = view) {
            const want = wanted(main);
            if (!want) return null;
            const weapon = Engine.sellerOf(priced, main.weapon), scroll = Engine.sellerOf(priced, want.scrollId, town);
            if (!weapon || !scroll || !(main.money - reserve - scroll.price - scroll.fare > ENCHANT_WALLET_WEAPONS * weapon.price)) return null;
            return { scrollId: want.scrollId, price: scroll.price, town: scroll.town, fare: scroll.fare, channel: scroll.channel, chance: want.chance };
        }
    };
}

module.exports = { npcGear, kitReserve, weaponEnchant, weaponScrolls, kitWeaponGrade, GRADE_ORDER, ENCHANT_WALLET_WEAPONS };
