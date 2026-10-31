'use strict';

// Owner: the healing potion a solo bot drinks to save its seated rest, hot and
// cold alike, and what that rule adds to its potion stock (T141,
// docs/game-decisions.md "Potions to save rest"): between fights a bot drinks
// when the rest the bottle saves, at the bot's own hour, is worth more than
// the bottle's NPC price, and the bot misses at least what it heals. The rest
// is the one ColdRest counts: the longer of its HP and, for a bot that sits for
// mana, its MP, so a bottle saves nothing while the MP holds the rest; a rest a
// pet holds ends no sooner (RestPolicy.petRested). The survival drink stays
// (tryUseInCombat, the danger moment, the cold fight's) and keeps its bottles
// (stockTargets[5]). Healing potions only; Quick Healing waits for near death.
// It reads the hot actor's API: a hot bot, or a cold profile through
// ColdClassPolicy.actorFor. A party's rest ends at its slowest member, so party
// members stay out of it, as of SoloSelfHeal.
const ColdRest = invoke('GameServer/Bot/Population/ColdRest');
const Diagnostics = require('../Economy/EconomyDiagnostics');
const Formulas = invoke('GameServer/Formulas');
const HealingPotionStock = invoke('GameServer/Bot/AI/HealingPotionStock');
const Pricing = invoke('GameServer/Bot/Economy/StaticMerchantPricing');
const RestPolicy = invoke('GameServer/Bot/AI/RestPolicy');
const Utility = invoke('GameServer/Bot/AI/BotCombatUtility');

const HOUR_SECONDS = 3600;
const RESTED = RestPolicy.THRESHOLDS.locked;
const DRINKS = HealingPotionStock.POTIONS.filter(potion => potion.hot);
const NO_USE = Object.freeze({ use: 0, hours: 0 });

// The rest seconds left at missingHp, at the bot's MP now; null for a bot
// that regenerates no HP seated.
function restLeft(actor) {
    const seatedHp = Utility.seatedHpPerMs(actor);
    if (!(seatedHp > 0)) return null;
    const regen = { hp: seatedHp * Formulas.REGEN_TICK_MS, mp: Utility.seatedMpPerMs(actor) * Formulas.REGEN_TICK_MS };
    const options = { regen, requireMana: RestPolicy.sitsForMana(actor) };
    const missingMp = RESTED.mp * actor.fetchMaxMp() - actor.fetchMp();
    return missingHp => ColdRest.restSeconds(actor, missingHp, missingMp, options);
}

const hoursOf = seconds => seconds / HOUR_SECONDS;

// The healing potions in the bag beyond those its survival drink keeps.
function spareBottles(actor, stats, inventory) {
    let bottles = -Math.max(0, Number(stats?.stockTargets?.[5]) || 0);
    for (const potion of DRINKS) bottles += HealingPotionStock.heldAmount(actor, inventory, potion.selfId);
    return bottles;
}

// Between fights: the potion to drink instead of sitting, or null. stats: the
// bot's money and stock packet, its hour (money[0], EconomyContext.hourAdena);
// without one (no decision yet, the spot table's reference bot) its hour is
// unknown and it does not drink. inventory: a cold bag; unset, the hot actor's.
// pet: reads the rest view of its pet (PetHealRule.restView), last: a hot tick
// that drinks nothing does not pay for it.
function betweenFights(actor, { stats = null, inventory = null, pet = null } = {}) {
    const hour = Number(stats?.money?.[0]);
    const missing = RESTED.hp * actor.fetchMaxHp() - actor.fetchHp();
    if (!(hour > 0) || !(missing > 0)) return null;
    const left = restLeft(actor);
    if (!left) return null;
    const rest = left(missing);
    let best = null, bestGain = 0;
    for (const potion of DRINKS) {
        if (potion.heal > missing) continue;
        const gain = hoursOf(rest - left(missing - potion.heal)) * hour - Pricing.botBuyPrice(potion.selfId);
        if (gain > bestGain && HealingPotionStock.heldAmount(actor, inventory, potion.selfId) > 0) {
            best = potion;
            bestGain = gain;
        }
    }
    return best && spareBottles(actor, stats, inventory) > 0 && RestPolicy.petRested(pet?.()) ? best : null;
}

// Hot: a solo bot between fights or seated. Drinks and returns true, or false.
function tryBetweenFights(session, bot, pet = null) {
    if (bot.state?.fetchCasts?.()) return false;
    // lazy: cycle DecisionEvents > EconomyContext > this module
    const stats = invoke('GameServer/Bot/AI/DecisionEvents').statsFor(session);
    const potion = betweenFights(bot, { stats, pet });
    if (!potion || HealingPotionStock.activePotionHot(bot)
        || !HealingPotionStock.drinkFromBag(session, bot, potion, HealingPotionStock.actorInventory(bot))) return false;
    Diagnostics.count('rest_potion', 'drink', 'hot');
    session.lastCombatDecision = { action: 'use_healing_potion', reason: 'rest_saved', itemId: potion.selfId,
        itemName: potion.name, hp: Number(bot.fetchHp()), maxHp: Number(bot.fetchMaxHp()), targetId: null, at: Date.now() };
    return true;
}

// What the rule drinks in an hour of a hunt, for the potion stock: use, the
// bottles; hours, the rest they save. row: the table's kill at the bot's spot
// (SpotValueTable.cycle); potion: the one it buys ({ heal, price }); hour: its
// hour. The seconds of a kill's rest only its HP holds (the MP rest stays, as
// in betweenFights), bounded by the table's rest; each bottle takes heal /
// seated rate of them, no faster than its heal runs. Zero where the bottle
// does not pay, or where it heals more than a rest refills (from the solo HP
// line to rested): such a bot misses that much only near death. The table's
// own potions are the survival drink's: its reference bot has no hour, so the
// two never count the same bottle.
function stockUse(state, { row, potion, hour, timestamp }) {
    if (!(row?.rest > 0) || !(row.kph > 0) || !(potion?.heal > 0)) return NO_USE;
    if (!(potion.heal <= (RESTED.hp - RestPolicy.THRESHOLDS.solo.hp) * Number(state.vitals?.maxHp))) return NO_USE;
    const regen = ColdRest.coldRestRegenPerTick(state, { timestamp });
    const hpPerSecond = regen.hp / (Formulas.REGEN_TICK_MS / 1000);
    if (!(hpPerSecond > 0)) return NO_USE;
    const saved = potion.heal / hpPerSecond;
    if (!(hoursOf(saved) * hour > potion.price)) return NO_USE;
    const options = { regen, requireMana: RestPolicy.sitsForMana(state) };
    const rest = missingHp => ColdRest.restSeconds(state, missingHp, row.mpLost, options);
    const heldByHp = Math.min(row.rest, rest(row.hpLost) - rest(0));
    const use = Math.min(heldByHp * row.kph / saved, HOUR_SECONDS * 1000 / HealingPotionStock.HOT_MS);
    return use > 0 ? { use, hours: hoursOf(use * saved) } : NO_USE;
}

module.exports = { betweenFights, tryBetweenFights, stockUse };
