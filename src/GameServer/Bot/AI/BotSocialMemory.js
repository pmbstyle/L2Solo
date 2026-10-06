const Identity = invoke('GameServer/Bot/AI/BotServiceIdentity');
const Memory = invoke('GameServer/Social/InteractionMemoryRuntime');
const { randomUUID } = require('crypto');
const TRUSTED_TRUST = 8;
const RECENT_ABANDON_MS = 5 * 60 * 1000;
const combatHelpSeen = new Set();
function actorId(session) { return Number(session?.characterId || session?.actor?.fetchId?.() || 0); }
function actorName(session) { return session?.name || session?.characterName || session?.actor?.fetchName?.() || ''; }
function isBotSession(session) { return String(session?.accountId || '').startsWith('bot_') || session?.constructor?.name === 'BotSession'; }
function botSessionForActor(actor) { return isBotSession(actor?.session) ? actor.session : invoke('GameServer/Bot/BotManager').findSessionById(actor?.fetchId?.()); }
function relationship(record) {
    if (!record) return 'stranger';
    if (record.trust >= TRUSTED_TRUST) return 'trusted';
    if (record.trust >= 3 || record.familiarity >= 5) return 'friendly';
    if (record.trust <= -5) return 'wary';
    return record.familiarity > 0 ? 'familiar' : 'stranger';
}
function recentlyAbandoned(record, at) { return record?.recentlyAbandonedAt > 0 && at - record.recentlyAbandonedAt < RECENT_ABANDON_MS; }
function snapshot(player, bot) {
    const relation = Memory.views.get(actorId(bot))?.relation('character', actorId(player), Date.now());
    const counts = relation?.social || {};
    return { playerId: actorId(player), botId: actorId(bot), playerName: actorName(player), botName: actorName(bot),
        trust: relation?.trust || 0, familiarity: relation?.familiarity || 0, groupRuns: counts.party_formed || 0, inviteAttempts: counts.invite_attempt || 0,
        wipesTogether: counts.party_wiped || 0, helpedInCombat: counts.helped_in_combat || 0,
        gaveUsefulLoot: counts.gave_useful_loot || 0, ignoredLootRequests: counts.ignored_loot_request || 0,
        tradesCompleted: counts.trade_completed || 0, insults: counts.insulted || 0,
        recentlyAbandonedAt: relation?.abandonedAt || null, grudge: relation?.grudge || 0,
        gratitude: relation?.gratitude || 0, irritation: relation?.irritation || 0 };
}
const BotSocialMemory = {
    init() {},
    getSnapshot(player, bot) {
        if (!Identity.isStaticService(bot) && actorId(bot) && !Memory.views.has(actorId(bot))) void this.load(player, bot);
        return snapshot(player, bot);
    },
    peekSnapshot: snapshot,
    load(player, bot) {
        if (Identity.isStaticService(bot) || !actorId(bot)) return Promise.resolve(null);
        return Memory.load(actorId(bot)).then(() => snapshot(player, bot)).catch(() => null);
    },
    async recordEvent(player, bot, type, detail = '') {
        if (Identity.isStaticService(bot) || !actorId(player) || !actorId(bot)) return null;
        const at = Date.now();
        const event = require('../../Social/RelationshipContext').enrich({ key: `social:${randomUUID()}`,
            sourceId: actorId(bot), targetId: actorId(player), type, at, player: !isBotSession(player) }, bot, player?.actor);
        let result;
        try { result = await Memory.recordBatch([event]); }
        catch (error) {
            utils.infoWarn('BotSocial', 'social memory failed: %s', error?.message || error);
            return null;
        }
        if (!result.ok) return null;
        const record = snapshot(player, bot);
        bot.socialSummary = { playerName: record.playerName, trust: record.trust, familiarity: record.familiarity, relationship: relationship(record) };
        bot.lastSocialEvent = { playerName: record.playerName, event: type, detail, at };
        return record;
    },
    recordTradeCompleted(playerSession, merchantActor, detail = '') {
        if (!playerSession || isBotSession(playerSession)) return Promise.resolve(null);

        let botSession = null;
        try {
            botSession = botSessionForActor(merchantActor);
        } catch (err) {
            utils.infoWarn('BotSocial', 'trade social lookup failed: %s', err.message);
            return Promise.resolve(null);
        }

        if (!botSession || botSession.plan !== 'merchant') return Promise.resolve(null);
        return this.recordEvent(playerSession, botSession, 'trade_completed', detail);
    },

    recordCombatHelp(playerSession, npc, detail = '') {
        if (!playerSession || isBotSession(playerSession) || !npc || !npc.fetchId) {
            return [];
        }

        const playerId = actorId(playerSession);
        const npcId = npc.fetchId();
        if (!playerId || !npcId) return [];

        let botSessions = [];
        try {
            const BotManager = invoke('GameServer/Bot/BotManager');
            botSessions = BotManager.sessions;
        } catch (err) {
            utils.infoWarn('BotSocial', 'combat social lookup failed: %s', err.message);
            return [];
        }

        if (combatHelpSeen.size > 5000) {
            combatHelpSeen.clear();
        }

        return botSessions
            .filter((botSession) => (
                botSession.actor &&
                botSession.followPlayerSession === playerSession &&
                botSession.partyCompanion === true &&
                botSession.currentTargetId === npcId
            ))
            .map((botSession) => {
                const seenKey = `${playerId}:${actorId(botSession)}:${npcId}`;
                if (combatHelpSeen.has(seenKey)) return null;

                combatHelpSeen.add(seenKey);
                return this.recordEvent(playerSession, botSession, 'helped_in_combat', detail || `shared target ${npcId}`);
            })
            .filter(Boolean);
    },

    TRUSTED_TRUST, relationship, recentlyAbandoned
};
module.exports = BotSocialMemory;
