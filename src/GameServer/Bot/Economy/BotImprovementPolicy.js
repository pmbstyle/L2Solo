'use strict';
const Sources = require('../../Items/ItemAcquisitionCatalog');
const Rules = invoke('GameServer/Items/C4EnchantRules');
const ItemIndex = require('../../Item/ItemTemplateIndex');
const Valuation = require('./EconomicValuation');
const Tendency = require('../AI/TendencyRoll');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const positive = value => Math.max(0, Number(value) || 0);
function template(id) { return ItemIndex.find(invoke('GameServer/DataCache').items, id); }
function instances(state) {
    return Object.values(state.inventory || {}).flatMap(row => (row.instances || []).map(item => ({ ...row, ...item,
        amount: item.amount ?? 1, selfId: Number(row.selfId), equipped: !!item.equipped })))
        .filter(item => positive(item.id) && item.amount === 1);
}
function adapter(item) {
    const source = template(item.selfId);
    const kind = source?.template?.kind || item.kind || '';
    return { fetchSelfId: () => item.selfId, fetchAmount: () => item.amount,
        fetchEnchantLevel: () => positive(item.enchant), fetchSlot: () => Number(item.slot || source?.etc?.slot),
        fetchKind: () => kind, fetchRank: () => source?.etc?.rank || item.rank,
        fetchCristals: () => Number(source?.etc?.cristals || 0),
        isWeapon: () => kind.startsWith('Weapon.'), isArmor: () => kind.startsWith('Armor.') };
}
// The native improvement targets in the bag, in order. Market interest,
// benefit, costs and tendency belong to opportunities.
function targets(state) {
    const result = [];
    for (const item of instances(state)) {
        if (!Sources.hasSource(item.selfId)) continue;
        const a = adapter(item), category = Rules.categoryOf(a);
        if (category && Rules.CRYSTAL_IDS[Rules.gradeOf(a)]) result.push({ item, a, category });
    }
    return result;
}
function isCaster(state) {
    return ['mage','healer','buffer','nuker','summoner'].includes(invoke('GameServer/Bot/AI/GearAcquisitionPlanner').roleFor(state));
}
function gainBetween(a, b, caster) {
    const attack = caster ? 'mAtk' : 'pAtk', speed = caster ? 'castSpd' : 'atkSpd';
    return { attack: Math.max(0, b[attack] * b[speed] / Math.max(1, a[attack] * a[speed]) - 1),
        defence: Math.max(0, 1 - a.pDef / Math.max(1, b.pDef), 1 - a.mDef / Math.max(1, b.mDef),
            1 - a.maxHp / Math.max(1, b.maxHp)) };
}
// Expected attempts to the COMPLETE target. A normal failure ends the chain;
// blessed failures return to zero. Affine recurrence solves that renewal.
function enchantCost(item, from, to, scroll, config) {
    const a = adapter(item), category = Rules.categoryOf(a);
    let reach = 1, count = 0;
    if (scroll.scrollType !== 'blessed') {
        for (let level = from; level < to; level++) {
            count += reach;
            reach *= Rules.isSafe(a, level, config) ? 1 : Rules.chanceFor(category, scroll.scrollType, config) / 100;
        }
        return { count, reach, lossChance: 1 - reach };
    }
    const coefficients = new Array(to + 1); coefficients[to] = { a: 0, b: 0 };
    for (let level = to - 1; level >= 0; level--) {
        const p = Rules.isSafe(a, level, config) ? 1 : Rules.chanceFor(category, 'blessed', config) / 100;
        const next = coefficients[level + 1];
        coefficients[level] = { a: 1 + p * next.a, b: (1 - p) + p * next.b };
    }
    const zero = coefficients[0].a / (1 - coefficients[0].b);
    return { count: coefficients[from].a + coefficients[from].b * zero, reach: 1, lossChance: 0 };
}
// The share of the attack rate left without the worn weapon: bare, or the
// best spare worn instead. candidates: the bot's candidateProfiles.
function stuckCost(state, item, ctx, candidates = null) {
    if (!item.equipped || !adapter(item).isWeapon()) return 0;
    candidates ||= Profile.candidateProfiles(state, ctx.timestamp ?? Date.now());
    const rate = profile => profile.pAtk * profile.atkSpd + profile.mAtk * profile.castSpd;
    const slot = slotOf(item), free = worn => worn === slot;
    const share = wear => Math.min(1, rate(candidates.after({ free, wear })) / Math.max(1, rate(candidates.before)));
    let kept = share(null);
    for (const spare of instances(state)) {
        if (spare.id === item.id || !adapter(spare).isWeapon()) continue;
        kept = Math.max(kept, share(wornRow(spare, spare.selfId, spare.enchant, slotOf(spare))));
    }
    const remainingIncome = ctx.hunt.perHour * kept;
    const lostPerHour = Math.max(0,ctx.hunt.perHour - remainingIncome);
    if (!lostPerHour) return 0;
    const replacement = positive(ctx.price(item.selfId));
    return remainingIncome > 0 ? replacement + lostPerHour * replacement / remainingIncome : Infinity;
}
function slotOf(item) {
    return Number(item.slot) || Number(template(item.selfId)?.etc?.slot) || 0;
}
// An item instance worn as selfId at enchant in slot (a candidate's wear).
function wornRow(item, selfId, enchant, slot) {
    return { selfId: Number(selfId), objectId: Number(item.id), enchant: positive(enchant), slot };
}
function weaponAbilityGain(state) {
    const profile = Profile.candidateProfiles(state, Date.now());
    const caster = isCaster(state);
    return (weapon, productId) => {
        const slot = slotOf(weapon);
        const before = profile.before;
        const after = profile.after({ free: worn => worn === slot, wear: wornRow(weapon, productId, weapon.enchant || 0, slot) });
        const effect = gainBetween(before, after, caster);
        const critical = caster ? 0 : Math.max(0, (1000 + after.critical) / (1000 + before.critical) - 1);
        return effect.attack + effect.defence + critical;
    };
}
function opportunities(state, ctx) {
    const scrolls = invoke('GameServer/Items/C4EnchantScrolls').ENCHANT_SCROLLS;
    const Henna = invoke('GameServer/Henna/HennaRules');
    const config = Rules.configWith(globalThis.options?.default?.Enchant);
    const horizon = Valuation.decisionHorizon(state, ctx);
    const weight = (ctx.persona.primaryDrive === 'progression' ? 1 : .5) + Valuation.trait(ctx.persona, 'caution');
    // Gains: the bot's kit profile against its numbers after the change
    // (candidateProfiles), read once per review.
    const timestamp = ctx.timestamp ?? Date.now(), magic = isCaster(state);
    let candidates;
    const read = () => candidates ||= Profile.candidateProfiles(state, timestamp);
    const value = change => {
        const effect = gainBetween(read().before, read().after(change), magic);
        return (effect.attack + effect.defence * ctx.deathHours) * horizon * weight;
    };
    const result = [];
    for (const { item, a, category } of targets(state)) {
        // What losing this weapon costs: once per item, only where a try can fail.
        let stuck = null;
        const stuckOnce = () => stuck ?? (stuck = stuckCost(state, item, ctx, read()));
        const equipped = item.equipped;
        const buyer = !equipped && ctx.board?.first(item.selfId, 3, { excludeOwner: state.characterId });
        if (!equipped && !buyer && !ctx.board?.first(item.selfId, 1, { excludeOwner: state.characterId })) continue;
        const from = positive(item.enchant), cap = Rules.maxFor(category, config);
        const slot = slotOf(item), free = worn => worn === slot;
        for (let to = from + 1; to <= Math.min(from + 3, cap || from + 3); to++) {
            const salePrice = !equipped && enchantedPrice(item, to, ctx);
            const benefit = equipped ? value({ free, wear: wornRow(item, item.selfId, to, slot) }) : (ctx.hunt.perHour > 0
                ? Math.max(0, salePrice - enchantedPrice(item, from, ctx)) / ctx.hunt.perHour : 0);
            if (!(benefit > 0)) continue;
            const alternatives = Object.entries(scrolls).flatMap(([id, rule]) => {
                if (!Sources.hasSource(id) || !Rules.validTarget(a, rule) || rule.scrollType === 'blessed' && Rules.isSafe(a, from, config)) return [];
                const price = positive(ctx.price(id)); if (!price) return [];
                const cost = enchantCost(item, from, to, rule, config);
                if (!Number.isFinite(cost.count)) return [];
                const loss = rule.scrollType === 'blessed' || !(cost.lossChance > 0) ? 0 : cost.lossChance
                    * (ctx.price(item.selfId) + stuckOnce());
                return [{ scrollId: Number(id), scrollType: rule.scrollType, cost,
                    price: price * cost.count, riskHours: ctx.hunt.perHour > 0 ? loss / ctx.hunt.perHour : Infinity }];
            }).filter(row => {
                const held = positive(state.inventory?.[row.scrollId]?.amount);
                const cash = row.price - held * ctx.price(row.scrollId);
                return cash <= positive(state.adena);
            });
            if (!alternatives.length) continue;
            // The attempt alternatives share one tendency roll including stop;
            // low-score risks keep the same nonzero tendency floor.
            const choices = [...alternatives, { stop: true, price: 0, riskHours: 0, cost: { reach: 0 } }];
            const scored = choices.map(choice => ({ choice, weight: choice.stop ? 1
                : Math.max(.001, benefit * choice.cost.reach / Math.max(1 / 3600,
                    choice.price / Math.max(1, ctx.hunt.perHour) + choice.riskHours * ctx.riskWeight)) }));
            const total = scored.reduce((n, row) => n + row.weight, 0);
            let roll = Tendency.roll(state.characterId, item.id, from, to, 'enchant');
            const selected = scored.find(row => { roll -= Tendency.MIN / scored.length
                + (1 - Tendency.MIN) * row.weight / total; return roll < 0; })?.choice || scored.at(-1).choice;
            if (selected.stop) continue;
            result.push({ key: `enchant:${item.id}:${to}`, kind: 'enchant', itemId: item.selfId, objectId: item.id,
                from, to, scrollId: selected.scrollId, scrollType: selected.scrollType,
                materials: [{ selfId: selected.scrollId, amount: Math.ceil(selected.cost.count) }],
                price: selected.price, riskHours: selected.riskHours, valueHours: benefit * selected.cost.reach,
                sale: !equipped });
        }
    }
    const slots = state.stats?.hennas || [];
    if (slots.filter(Boolean).length < Henna.slotsForClass(state.stats?.classId || state.classId)) {
        const ClanDyes = require('../../Clan/ClanDyeStock');
        for (const symbol of Henna.availableForClass(state.stats?.classId || state.classId)) {
            if (slots.includes(symbol.id)) continue;
            const id = symbol.dyeSelfId;
            const held = positive(state.inventory?.[id]?.amount);
            const ordered = positive(state.acceptedIncoming?.[id]);
            const free = Math.min(ClanDyes.amount(state, id), Math.max(0, symbol.dyeAmount - held - ordered));
            if (!Sources.hasSource(id) && !(free && held + free >= symbol.dyeAmount)) continue;
            const benefit = value({ hennas: [...slots, symbol.id] });
            if (benefit <= 0) continue;
            result.push({ key: `henna:${symbol.id}`, kind: 'henna', symbolId: symbol.id,
                materials: [{ selfId: id, amount: symbol.dyeAmount, ...(free ? { clanFree: free } : {}) }], fee: symbol.price,
                price: (free ? Math.max(0, symbol.dyeAmount - held - ordered - free) : symbol.dyeAmount)
                    * ctx.price(id) + symbol.price, valueHours: benefit });
        }
    }
    return result.sort((a,b) => b.valueHours / Math.max(1, b.price) - a.valueHours / Math.max(1,a.price)).slice(0, 6);
}
function enchantedPrice(item, level, ctx) {
    const base = positive(ctx.price(item.selfId));
    if (!level) return base;
    const config = Rules.configWith(globalThis.options?.default?.Enchant);
    const costs = Object.entries(invoke('GameServer/Items/C4EnchantScrolls').ENCHANT_SCROLLS)
        .filter(([,rule]) => rule.scrollType === 'normal' && Rules.validTarget(adapter(item),rule))
        .map(([id,rule]) => { const cost = enchantCost(item,0,level,rule,config);
            const price = ctx.price(id); return price > 0 && cost.reach > 0
                ? (base + price * cost.count) / cost.reach : Infinity; });
    return Math.min(...costs, Infinity);
}
module.exports = { isCaster, enchantedPrice, weaponAbilityGain, opportunities, instances, adapter, enchantCost, stuckCost };
