'use strict';
const TargetMatchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
const TendencyRoll = invoke('GameServer/Bot/AI/TendencyRoll');
const DecisionEvents = invoke('GameServer/Bot/AI/DecisionEvents');
const HealingPotionStock = invoke('GameServer/Bot/AI/HealingPotionStock');
const ColdRest = invoke('GameServer/Bot/Population/ColdRest');
const PartyAwareness = invoke('GameServer/Bot/AI/PartyAwareness');
const Diagnostics = invoke('GameServer/Bot/Economy/EconomyDiagnostics');
const EscapePolicy = invoke('GameServer/Bot/AI/BotEscapePolicy');

// E70, §13.6 "it got dangerous": drink a potion, run to heal, sit or keep
// fighting, each priced in the bot's hours. First choices, calibrated later
// by the hot harness:
// the survival margin 1.5 the target choice admits reads as a 0.15% lose
// chance, 1.2 as 5%, an even race (margin 1) as 50%.
const LOSE_SLOPE = 16;
// Only a viable escape receives this discount; faster pursuers rule it out.
const FLEE_EXPOSURE = 0.5;
// One roll moves the bot's sense of the death price by up to +-50%.
const ROLL_SPREAD = 0.5;
// Melee and nearby casters hitting the bot; farther mobs are not in this fight.
const ATTACKER_RADIUS = 900;

// The chance to lose the fight from the survival ratio: how many times the
// enemies' remaining HP the bot deals before its own remaining HP runs out.
function loseChance(survivalRatio) {
    return survivalRatio > 0 ? 1 / (1 + survivalRatio ** LOSE_SLOPE) : 1;
}

// One decision for hot and cold, in hours. Inputs: own HP now and max, the
// survival ratio at this HP (null = unknown), attacked (someone hits the bot),
// the potion it would drink ({ heal, price } or null), hours to rest to full,
// the hours the fight still needs (given up by running or sitting), the death price (EconomicValuation.deathHours), the price of money (hours
// per adena), the trait weight on risk (EconomicValuation.riskWeight:
// caution, resilience, frustration) and the decision's roll.
// null leaves the caller's own rule in place, also when the price of money is
// unknown: a free potion would be drunk whenever the last one wears off.
function decide({ hp, maxHp, survivalRatio, attacked = true, canEscape = true, potion = null, restHours = 0, fightHours = 0,
    deathHours, moneyPrice, riskWeight, roll = 0.5 } = {}) {
    if (!Number.isFinite(survivalRatio) || !(maxHp > 0) || !(hp > 0)
        || !(deathHours >= 0) || !Number.isFinite(moneyPrice) || moneyPrice < 0 || !(riskWeight >= 0)) return null;
    const risk = deathHours * riskWeight * (1 + ROLL_SPREAD * (2 * roll - 1));
    const lose = loseChance(survivalRatio);
    const hours = { fight: lose * risk };
    const heal = Math.min(Math.max(0, Number(potion?.heal) || 0), maxHp - hp);
    if (heal > 0) {
        hours.drink = Math.max(0, Number(potion.price) || 0) * moneyPrice
            + loseChance(survivalRatio * (hp + heal) / hp) * risk;
    }
    const leave = Math.max(0, restHours) + Math.max(0, fightHours);
    if (attacked && canEscape) hours.flee = lose * FLEE_EXPOSURE * risk + leave;
    if (!attacked) hours.sit = leave;
    let action = 'fight';
    for (const option of Object.keys(hours)) if (hours[option] < hours[action]) action = option;
    return { action, loseChance: lose, hours };
}

function npcHp(npc) { return Math.max(0, Number(npc.fetchHp?.() || 0)); }
function npcPAtk(npc, view) {
    return Math.max(0, Number(npc.matchupTarget?.pAtk ?? npc.fetchCollectivePAtk?.() ?? npc.fetchPAtk?.() ?? view.pAtk) || 0)
        * Math.max(1, Number(npc.matchupTarget?.atkSpd ?? npc.fetchCollectiveAtkSpd?.() ?? npc.fetchAtkSpd?.() ?? 253) || 253);
}

// The target and every other mob hitting the bot. `near` is a world scan
// around the bot (PartyAwareness.npcThreateningActor) reused instead of a new one.
function attackersOf(actor, target, near = null) {
    const others = PartyAwareness.npcsAttackingActor(actor, ATTACKER_RADIUS, near)
        .filter(npc => npc !== target && npc.fetchId?.() !== target.fetchId?.());
    return [target, ...others];
}

// The decision the body received with its death price, else null: before
// the first near decision arrives (DecisionEvents.held gives a view without
// a card) the author's retreat rule decides. `decided` is read first: the
// cardless view's death price is never consulted.
function decidedEconomy(session) {
    const economy = DecisionEvents.held(session);
    return economy?.decided && economy.deathHours >= 0 ? economy : null;
}

// The hot moment for a bot fighting target: the held economy gives the death
// price, the price of money and the trait weight; the live fight gives the
// survival ratio at the HP and MP left against every mob hitting the bot.
// The roll is kept for the whole fight with this target. The chosen action
// is kept on the session, so the fixed-ratio potion step yields to it.
function forActor(session, actor, target, options = {}) {
    session.dangerMoment = undefined;
    const economy = decidedEconomy(session);
    if (!economy || !target) return null;
    const hp = Number(actor.fetchHp?.() || 0), maxHp = Number(actor.fetchMaxHp?.() || 0);
    const mp = Number(actor.fetchMp?.() || 0), maxMp = Number(actor.fetchMaxMp?.() || 0);
    // A pet keeps its own HP (BotTargetMatchup.actorProfiles; it tanks first).
    const profiles = (options.profiles || TargetMatchup.actorProfiles([actor])).map(profile => profile.soloDamageReceiver === false || profile.servitor === true ? profile
        : { ...profile, maxHp: Math.min(profile.maxHp, hp), maxMp: Math.min(profile.maxMp, mp) });
    const view = TargetMatchup.targetView(target);
    const attackers = options.attackers || attackersOf(actor, target);
    const atkSpd = Math.max(1, Number(view.atkSpd || 253));
    // The mobs on the bot are judged as one mob with their HP and attack summed (minimum.md #3).
    // An area skill hits each of them (F20: BotTargetMatchup reads `pull`).
    const enemy = { ...view, maxHp: attackers.reduce((sum, npc) => sum + npcHp(npc), 0),
        pAtk: attackers.reduce((sum, npc) => sum + npcPAtk(npc, view), 0) / atkSpd, atkSpd, pull: attackers.length };
    const survival = TargetMatchup.soloSurvival(profiles, enemy);
    // Damage per second of the same attack envelope as the survival ratio.
    const damageRate = TargetMatchup.damageRate(profiles, enemy);
    // A potion still working or a cast in flight leaves no bottle to drink now.
    const potion = options.potion === null || actor.state?.fetchCasts?.() || HealingPotionStock.activePotionHot(actor) ? null
        : HealingPotionStock.selectPotion(options.bag ? options.bag() : HealingPotionStock.actorInventory(actor), hp, maxHp, actor,
            { dangerMoment: true });
    // Drinking costs the bottle the bot then buys again.
    const heldPotion = potion ? { heal: potion.heal, price: HealingPotionStock.purchasePotionFor(actor).price } : null;
    // The price of money as EconomyContext holds it (money[1] of its stats packet); unknown leaves the author rule.
    const packetPrice = Number(economy.statsPacket?.money?.[1] || 0);
    const moneyPrice = economy.moneyPrice > 0 ? economy.moneyPrice : packetPrice > 0 ? packetPrice : null;
    const targetId = Number(target.fetchId?.() ?? 0);
    if (moneyPrice === null) Diagnostics.count('danger_moment', 'no_price', 'all');
    const restHours = ColdRest.estimateRestMs({ level: actor.fetchLevel?.(), stats: { classId: actor.fetchClassId?.() } },
        { hp, maxHp, mp, maxMp }) / 3600000;
    const moment = decide({ hp, maxHp, survivalRatio: survival.survivalRatio, attacked: options.attacked !== false,
        canEscape: EscapePolicy.assess(session, actor, attackers).possible,
        potion: heldPotion, restHours, fightHours: damageRate > 0 ? enemy.maxHp / damageRate / 3600 : 0, deathHours: economy.deathHours, moneyPrice, riskWeight: economy.riskWeight,
        roll: TendencyRoll.roll('danger', actor.fetchId?.(), targetId) });
    session.dangerMoment = moment ? { targetId, action: moment.action } : undefined;
    return moment;
}

// Whether the moment can run at all: a wounded bot with a held economy. A
// caller checks it before its own scan for the attackers.
function applies(session, actor) {
    const hp = Number(actor.fetchHp?.() || 0), maxHp = Number(actor.fetchMaxHp?.() || 0);
    if (hp < maxHp && decidedEconomy(session)) return true;
    session.dangerMoment = undefined;
    return false;
}

// One counter per outcome taken (drank is counted as drink): the live check reads what the moment decides.
function counted(action) {
    if (!action) return null;
    Diagnostics.count('danger_moment', action === 'drank' ? 'drink' : action, 'all');
    return action;
}

// The moment a fight in progress takes, hunting (E70) or resting and attacked
// (E71): 'drank', 'flee', 'fight', or null when
// the bot has no received decision or the matchup is unknown (the author's retreat
// rule then). A potion it could not drink leaves the moment to the other
// options. A bot at full HP has nothing to drink and takes the author's rule
// until the first hit, so a fight at full HP scans nothing. options: profiles
// (the matchup profiles, built here once if absent), attackers (the mobs on
// the bot) or near (a world scan around the bot to read them from).
function take(session, actor, target, options = {}) {
    if (!target) {
        session.dangerMoment = undefined;
        return null;
    }
    if (!applies(session, actor)) return null;
    const profiles = options.profiles || TargetMatchup.actorProfiles([actor]);
    const attackers = options.attackers || attackersOf(actor, target, options.near);
    // The bag is read once, only when a potion is looked for.
    let inventory = null;
    const bag = () => inventory || (inventory = HealingPotionStock.actorInventory(actor));
    const moment = forActor(session, actor, target, { profiles, attackers, attacked: options.attacked, bag });
    if (moment?.action !== 'drink') return counted(moment?.action);
    if (HealingPotionStock.tryUseInCombat(session, actor, target, { dangerMoment: true, inventory: bag() })) return counted('drank');
    return counted(forActor(session, actor, target, { profiles, attackers, attacked: options.attacked, potion: null })?.action);
}

module.exports = { LOSE_SLOPE, FLEE_EXPOSURE, ROLL_SPREAD, ATTACKER_RADIUS, loseChance, decide, forActor, applies, take };
