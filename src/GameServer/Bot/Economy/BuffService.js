const Database = invoke('Database');
const Policy = invoke('GameServer/Bot/Economy/BuffServicePolicy');
const Planner = invoke('GameServer/Bot/AI/BotSupportPlanner');
const Social = invoke('GameServer/Bot/AI/BotSocialMemory');
const Effects = invoke('GameServer/Skills/C4SkillEffects');
const Town = invoke('GameServer/Bot/AI/TownPathfinder');
const ServerResponse = invoke('GameServer/Network/Response');

const QUOTE_MS = 2 * 60 * 1000;
const MAX_DISTANCE = 900;
const quotes = new Map();
const busy = new Set();
const lastAutoAttempt = new Map();
const lastAutoPurchase = new Map();

function id(session) { return Number(session?.actor?.fetchId?.() || 0); }
function tell(provider, player, message) {
    return invoke('GameServer/Bot/BotManager').botTell(provider, player, message);
}
function distance(a, b) {
    return Math.hypot(Number(a.fetchLocX()) - Number(b.fetchLocX()), Number(a.fetchLocY()) - Number(b.fetchLocY()));
}
function skillInRange(provider, recipient, skill) {
    return distance(provider, recipient) <= skillReach(skill);
}
function skillReach(skill) {
    const reach = Number(skill.fetchDistance?.());
    return Math.min(MAX_DISTANCE, Number.isFinite(reach) && reach > 0 ? reach : MAX_DISTANCE);
}
function townFor(actor) {
    return Town.getTown({ locX: actor.fetchLocX(), locY: actor.fetchLocY(), locZ: actor.fetchLocZ() });
}
function clearQuote(playerSession) { quotes.delete(id(playerSession)); }

function buildQuote(playerSession, providerSession, { trade = null } = {}) {
    const player = playerSession?.actor, provider = providerSession?.actor;
    if (!player || !provider || !id(playerSession) || !id(providerSession)) return { ok: false, reason: 'Select a nearby buffer.' };
    if (player.isDead?.() || provider.isDead?.() || player.state?.fetchCombats?.() || provider.state?.fetchCombats?.()) {
        return { ok: false, reason: 'Buff service is unavailable during combat.' };
    }
    if (distance(player, provider) > MAX_DISTANCE) return { ok: false, reason: 'Come closer to the buffer.' };
    if (busy.has(id(playerSession)) || busy.has(id(providerSession))) return { ok: false, reason: 'The buffer is busy.' };
    const ownTrade = trade && playerSession.activeTrade === trade && providerSession.activeTrade === trade;
    if ((providerSession.activeTrade && !ownTrade) || providerSession.merchantStoreMutation || providerSession.hotBackgroundPartyId
        || ['pk_hunting', 'merchant', 'shopping'].includes(providerSession.plan)
        || provider.state?.fetchCasts?.() || (provider.state?.fetchMoves?.() && !ownTrade)) return { ok: false, reason: 'The buffer is busy.' };
    const usefulSkills = Policy.hotSkills(provider, player);
    if (!usefulSkills.length) return { ok: false, reason: 'This buffer has no useful missing buffs for you.' };
    const skills = usefulSkills.filter(skill => skillInRange(provider, player, skill));
    if (!skills.length) {
        const reach = Math.max(...usefulSkills.map(skillReach));
        return { ok: false, reason: `Come within ${reach} of the buffer to receive these buffs.` };
    }
    const mp = skills.reduce((sum, skill) => sum + Math.max(0, Number(skill.fetchConsumedMp() || 0)), 0);
    if (Number(provider.fetchMp()) < mp) return { ok: false, reason: 'The buffer needs to recover MP first.' };
    const relation = Social.peekSnapshot(playerSession, providerSession);
    const price = Policy.priceFor({ provider, recipient: player, skills, town: !!townFor(provider), trust: Number(relation?.trust || 0) });
    return { ok: true, playerId: id(playerSession), providerId: id(providerSession),
        skills: skills.map(skill => Number(skill.fetchSelfId())), price, expiresAt: Date.now() + QUOTE_MS };
}

function quote(playerSession, providerSession) {
    const offer = buildQuote(playerSession, providerSession);
    if (!offer.ok) {
        if (!playerSession?.actor) return offer;
        if (providerSession?.actor) tell(providerSession, playerSession, offer.reason);
        else playerSession?.dataSendToMe?.(ServerResponse.speak(playerSession.actor, { kind: 0, text: offer.reason }));
        return offer;
    }
    const names = offer.skills.map(skillId => providerSession.actor.skillset.fetchSkill(skillId)?.fetchName?.() || `skill ${skillId}`);
    quotes.set(offer.playerId, offer);
    if (offer.price === 0) {
        buy(playerSession).catch(error => utils.infoWarn('BuffService', 'free buff failed: %s', error.message));
        return offer;
    }
    const opened = invoke('GameServer/Bot/BotTradeService').startBuffTrade(playerSession, providerSession, offer);
    if (!opened.ok) {
        tell(providerSession, playerSession, `Could not open buff trade: ${opened.reason}.`);
        return { ok: false, reason: opened.reason };
    }
    tell(providerSession, playerSession, `${names.join(', ')}: ${offer.price} Adena. Put exactly this amount in the trade and confirm within 2 minutes.`);
    return offer;
}

function reserveNativeTrade(trade) {
    const offer = trade?.buffService;
    const playerSession = trade?.playerSession, providerSession = trade?.botSession;
    if (!offer || !playerSession?.actor || !providerSession?.actor || trade.buffServiceCommitting
        || busy.has(offer.playerId) || busy.has(offer.providerId)) return { ok: false, reason: 'The buffer is busy.' };
    if (offer.expiresAt < Date.now()) return { ok: false, reason: 'The buff offer expired. Type .buff again.' };
    if (trade.botItems.size !== 0 || trade.playerItems.size !== 1) {
        return { ok: false, reason: `Put exactly ${offer.price} Adena in the trade, with no other items.` };
    }
    const [line] = trade.playerItems.values();
    if (Number(line.selfId) !== 57 || Number(line.count) !== offer.price) {
        return { ok: false, reason: `Put exactly ${offer.price} Adena in the trade.` };
    }
    const current = buildQuote(playerSession, providerSession, { trade });
    if (!current.ok || current.price !== offer.price || current.skills.join(',') !== offer.skills.join(',')) {
        return { ok: false, reason: current.reason || 'The buff offer changed. Type .buff again.' };
    }
    trade.buffServiceCommitting = true;
    busy.add(offer.playerId); busy.add(offer.providerId);
    return { ok: true };
}

function releaseNativeTrade(trade) {
    if (!trade?.buffServiceCommitting) return;
    trade.buffServiceCommitting = false;
    busy.delete(trade.buffService.playerId);
    busy.delete(trade.buffService.providerId);
}

function waitForCast(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function castInterrupted(playerSession, providerSession, player, provider, skill) {
    return playerSession.actor !== player || providerSession.actor !== provider
        || player.isDead?.() || provider.isDead?.()
        || player.state?.fetchCombats?.() || provider.state?.fetchCombats?.()
        || !skillInRange(provider, player, skill)
        || Number(provider.fetchMp()) < Number(skill.fetchConsumedMp());
}

async function castPaidBuff(playerSession, providerSession, skill, wait = waitForCast) {
    const player = playerSession.actor, provider = providerSession.actor;
    const calculated = provider.attack?.calculatedSkillHitTime?.(provider, skill, skill.fetchSpell?.());
    if (Number.isFinite(calculated)) skill.setCalculatedHitTime?.(calculated);
    const reported = Number(skill.fetchCalculatedHitTime?.() ?? skill.fetchHitTime?.());
    const castMs = Number.isFinite(reported) && reported > 0 ? Math.max(250, Math.floor(reported)) : 1000;
    providerSession.dataSendToMeAndOthers?.(ServerResponse.skillStarted(provider, player.fetchId(), skill), provider);
    if (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) console.info('BuffService :: cast started player=%s provider=%s skill=%d castMs=%d',
        player.fetchName?.() || player.fetchId(), provider.fetchName?.() || provider.fetchId(), skill.fetchSelfId(), castMs);
    await wait(castMs);
    if (castInterrupted(playerSession, providerSession, player, provider, skill)) {
        if (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) console.info('BuffService :: cast interrupted player=%s provider=%s skill=%d',
            player.fetchName?.() || player.fetchId(), provider.fetchName?.() || provider.fetchId(), skill.fetchSelfId());
        return { effect: null, interrupted: true };
    }
    providerSession.dataSendToMeAndOthers?.(ServerResponse.magicSkillLaunched(provider, skill, [player]), provider);
    const outcome = Effects.execute(providerSession, provider, player, skill, { magicSkill: skill.fetchSpell?.() });
    if (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) console.info('BuffService :: cast landed player=%s provider=%s skill=%d effect=%s',
        player.fetchName?.() || player.fetchId(), provider.fetchName?.() || provider.fetchId(), skill.fetchSelfId(), !!outcome?.effect);
    if (outcome?.effect) {
        provider.setMp(Number(provider.fetchMp()) - Number(skill.fetchConsumedMp()));
        provider.statusUpdateVitals(provider);
    }
    return outcome;
}

async function completeNativeTrade(trade, { wait = waitForCast } = {}) {
    const offer = trade.buffService;
    const playerSession = trade.playerSession, providerSession = trade.botSession;
    const player = playerSession.actor, provider = providerSession.actor;
    let applied = 0, charged = 0;
    const appliedSkills = [], skippedSkills = [];
    providerSession.buffServiceCasting = true;
    try {
        if (!player || !provider) throw new Error('buff trade participant unavailable');
        for (let index = 0; index < offer.skills.length; index++) {
            const skill = provider.skillset.fetchSkill(offer.skills[index]);
            if (providerSession.actor !== provider || playerSession.actor !== player
                || provider.isDead?.() || player.isDead?.()
                || provider.state?.fetchCombats?.() || player.state?.fetchCombats?.()
                || skill && !skillInRange(provider, player, skill)) {
                skippedSkills.push(`${offer.skills[index]}:interrupted`);
                break;
            }
            if (!skill || !Policy.eligibleSkill(skill) || provider.canUseSkill?.(skill) === false
                || !Policy.needsPaidBuff(player, skill)
                || !Planner.canPlanSupportAction(player, provider, skill, [{ actor: player, leader: true }])
                || Number(provider.fetchMp()) < Number(skill.fetchConsumedMp())) {
                skippedSkills.push(`${offer.skills[index]}:unavailable`);
                continue;
            }
            try {
                const outcome = await castPaidBuff(playerSession, providerSession, skill, wait);
                if (!outcome?.effect) {
                    skippedSkills.push(`${offer.skills[index]}:${outcome?.interrupted ? 'interrupted' : 'no_effect'}`);
                    if (outcome?.interrupted) break;
                    continue;
                }
                applied += 1;
                appliedSkills.push(offer.skills[index]);
                charged += Math.floor(offer.price / offer.skills.length)
                    + (index < offer.price % offer.skills.length ? 1 : 0);
            } catch (error) {
                utils.infoWarn('BuffService', 'buff trade cast failed: %s', error.message);
                skippedSkills.push(`${offer.skills[index]}:error`);
            }
        }
    } catch (error) {
        utils.infoWarn('BuffService', 'buff trade fulfillment failed: %s', error.message);
    } finally {
        providerSession.buffServiceCasting = false;
        const unused = offer.price - charged;
        let refunded = true;
        if (unused > 0) {
            try { refunded = await refund(playerSession, providerSession, unused); }
            catch (error) {
                refunded = false;
                utils.infoWarn('BuffService', 'buff trade refund failed: %s', error.message);
            }
        }
        tell(providerSession, playerSession, refunded
            ? applied ? `Done: ${applied} buff${applied === 1 ? '' : 's'} for ${charged} Adena.${unused ? ` Refunded ${unused} Adena for buffs not cast.` : ''}`
                : `No buffs landed; ${unused} Adena refunded.`
            : `Only ${applied} buffs landed, and ${unused} Adena could not be refunded. Contact an admin.`);
        if (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) console.info('BuffService :: native trade player=%s provider=%s offered=%d applied=%j skipped=%j charged=%d refunded=%d refundOk=%s',
            player?.fetchName?.() || offer.playerId, provider?.fetchName?.() || offer.providerId,
            offer.skills.length, appliedSkills, skippedSkills, charged, unused, refunded);
    }
    return { ok: applied > 0, applied, charged };
}

function syncAdena(actor, itemId, balance) {
    if (!actor?.backpack) return;
    const item = actor.backpack.fetchItemFromSelfId(57);
    if (item) {
        if (balance > 0) item.setAmount(balance);
        else actor.backpack.items = actor.backpack.fetchItems().filter(entry => entry !== item);
    } else if (balance > 0 && itemId) {
        actor.backpack.insertItem(itemId, 57, { name: 'Adena', amount: balance });
    }
}
function syncPayment(payerSession, providerSession, result) {
    syncAdena(payerSession.actor, result.payerAdenaId, result.payerBalance);
    syncAdena(providerSession.actor, result.providerAdenaId, result.providerBalance);
    for (const session of [payerSession, providerSession]) {
        if (session.actor?.backpack?.fetchItems && session.dataSendToMe) {
            session.dataSendToMe(ServerResponse.itemsList(session.actor.backpack.fetchItems()));
        }
    }
}

async function pay(playerSession, providerSession, amount) {
    if (amount === 0) return { ok: true };
    const result = await Database.transferBuffServiceAdena({
        payerId: id(playerSession), providerId: id(providerSession), amount
    });
    if (result.ok) syncPayment(playerSession, providerSession, result);
    return result;
}
async function refund(playerSession, providerSession, amount) {
    if (amount <= 0) return true;
    const result = await Database.transferBuffServiceAdena({
        payerId: id(providerSession), providerId: id(playerSession), amount
    });
    if (result.ok) syncPayment(providerSession, playerSession, result);
    return result.ok;
}

async function buy(playerSession, { wait = waitForCast } = {}) {
    const playerId = id(playerSession);
    const offer = quotes.get(playerId);
    clearQuote(playerSession);
    if (!offer || offer.expiresAt < Date.now()) return { ok: false, reason: 'Your buff quote expired. Type .buff again.' };
    const providerSession = invoke('GameServer/Bot/BotManager').findSessionById(offer.providerId);
    const provider = providerSession?.actor;
    if (!provider) return { ok: false, reason: 'The buffer is no longer here.' };
    if (busy.has(playerId) || busy.has(offer.providerId)) return { ok: false, reason: 'The buffer is busy.' };
    const current = buildQuote(playerSession, providerSession);
    if (!current.ok || current.price !== offer.price || current.skills.join(',') !== offer.skills.join(',')) {
        return { ok: false, reason: 'The buff offer changed. Type .buff for a new quote.' };
    }
    if (Number(playerSession.actor.backpack?.fetchItemFromSelfId(57)?.fetchAmount?.() || 0) < offer.price) {
        return { ok: false, reason: `You need ${offer.price} Adena for this buff package.` };
    }
    busy.add(playerId); busy.add(offer.providerId);
    providerSession.buffServiceCasting = true;
    let paid = 0, applied = 0;
    let failureText = null;
    try {
        for (let index = 0; index < offer.skills.length; index++) {
            const skill = provider.skillset.fetchSkill(offer.skills[index]);
            if (providerSession.actor !== provider || !playerSession.actor
                || provider.state?.fetchCombats?.() || playerSession.actor.state?.fetchCombats?.()) {
                failureText = 'The cast was interrupted.';
                break;
            }
            if (!skill || !Policy.eligibleSkill(skill) || provider.canUseSkill?.(skill) === false
                || !Policy.needsPaidBuff(playerSession.actor, skill)
                || !Planner.canPlanSupportAction(playerSession.actor, provider, skill, [{ actor: playerSession.actor, leader: true }])
                || !skillInRange(provider, playerSession.actor, skill) || provider.isDead?.()
                || playerSession.actor.isDead?.() || Number(provider.fetchMp()) < Number(skill.fetchConsumedMp())) break;
            const portion = Math.floor(offer.price / offer.skills.length) + (index < offer.price % offer.skills.length ? 1 : 0);
            const payment = await pay(playerSession, providerSession, portion);
            if (!payment.ok) {
                failureText = payment.reason === 'not_enough_adena'
                    ? 'You no longer have enough Adena for the quoted buffs.' : 'Payment could not be completed.';
                break;
            }
            paid += portion;
            try {
                const outcome = await castPaidBuff(playerSession, providerSession, skill, wait);
                if (!outcome?.effect) {
                    if (await refund(playerSession, providerSession, portion)) paid -= portion;
                    if (outcome?.interrupted) failureText = 'The cast was interrupted.';
                    break;
                }
                applied += 1;
            } catch (error) {
                if (await refund(playerSession, providerSession, portion)) paid -= portion;
                throw error;
            }
        }
        tell(providerSession, playerSession, applied
            ? `Done: ${applied} buff${applied === 1 ? '' : 's'} for ${paid} Adena.${failureText ? ` ${failureText}` : ''}`
            : paid > 0 ? `The buff failed, and ${paid} Adena could not be refunded. Contact an admin.`
                : failureText || 'No buffs landed; no fee was charged.');
        return { ok: applied > 0, applied, paid };
    } finally {
        providerSession.buffServiceCasting = false;
        busy.delete(playerId); busy.delete(offer.providerId);
    }
}

function command(playerSession, text) {
    if (!/^\.buff$/i.test(text)) return false;
    const provider = invoke('GameServer/Bot/BotManager').findSessionById(playerSession.actor?.fetchDestId?.());
    quote(playerSession, provider);
    return true;
}

function maybeAutoBuy(session, timestamp = Date.now()) {
    const buyer = session?.actor;
    const buyerId = id(session);
    if (session?.buffServicePending) return true;
    if (!buyer || !buyerId || busy.has(buyerId)
        || session.partyCompanion || session.hotBackgroundPartyId || session.activeTrade
        || ['merchant', 'shopping', 'pk_hunting'].includes(session.plan)
        || buyer.isDead?.() || buyer.state?.fetchCombats?.() || buyer.state?.fetchCasts?.()
        || buyer.state?.fetchMoves?.()) return false;
    if (timestamp - Number(lastAutoAttempt.get(buyerId) || 0) < 60000
        || timestamp - Number(lastAutoPurchase.get(buyerId) || 0) < 10 * 60000) return false;
    lastAutoAttempt.set(buyerId, timestamp);
    const wallet = Number(buyer.backpack?.fetchItemFromSelfId(57)?.fetchAmount?.() || 0);
    const providers = invoke('GameServer/Bot/BotManager').sessions || [];
    const offer = providers.filter(candidate => candidate !== session && candidate?.actor && !candidate.partyCompanion
            && Policy.serviceClass(candidate.actor) && distance(buyer, candidate.actor) <= MAX_DISTANCE)
        .map(candidate => buildQuote(session, candidate))
        .filter(candidate => candidate.ok && candidate.price <= wallet * 0.25
            && candidate.price <= Policy.incomeForTenMinutes(buyer) * 0.8)
        .sort((a, b) => a.price - b.price)[0];
    if (!offer) return false;
    quotes.set(buyerId, offer);
    session.buffServicePending = true;
    buy(session).then(result => {
        if (result.ok) lastAutoPurchase.set(buyerId, Date.now());
    }).catch(error => utils.infoWarn('BuffService', 'bot purchase failed: %s', error.message))
        .finally(() => { session.buffServicePending = false; });
    return true;
}

module.exports = { buildQuote, quote, buy, command, clearQuote, townFor, maybeAutoBuy,
    reserveNativeTrade, releaseNativeTrade, completeNativeTrade };
