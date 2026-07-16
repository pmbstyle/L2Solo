const BotAvailability = invoke('GameServer/Bot/AI/BotAvailability');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const cooldowns = new Map();

function bool(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function num(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function config() {
    const optn = options.default.OpenRouter || {};
    return {
        enabled: bool(optn.enabled, false),
        apiKey: process.env.OPENROUTER_API_KEY || optn.apiKey || '',
        model: process.env.OPENROUTER_MODEL || optn.model || 'google/gemini-2.5-flash-lite',
        temperature: num(optn.temperature, 0.35),
        maxTokens: num(optn.maxTokens, 120),
        timeoutMs: num(optn.timeoutMs, 3500),
        remoteChatCooldownMs: num(optn.remoteChatCooldownMs, 10000),
        debug: bool(optn.debug, false)
    };
}

function playerSummary(playerSession) {
    const actor = playerSession?.actor;
    if (!actor) return null;

    return {
        id: actor.fetchId(),
        name: actor.fetchName(),
        level: actor.fetchLevel(),
        hpPct: Math.round((actor.fetchHp() / actor.fetchMaxHp()) * 100),
        mpPct: Math.round((actor.fetchMp() / actor.fetchMaxMp()) * 100),
        karma: typeof actor.fetchKarma === 'function' ? actor.fetchKarma() : 0
    };
}

function stateSummary(state) {
    if (!state) return null;

    return {
        id: state.characterId,
        name: state.name,
        level: state.level,
        phase: state.phase,
        activity: state.activity,
        homeRegion: state.homeRegion,
        currentRegion: state.currentRegion,
        spotId: state.spotId,
        hpPct: state.vitals?.maxHp ? Math.round((state.vitals.hp / state.vitals.maxHp) * 100) : null,
        mpPct: state.vitals?.maxMp ? Math.round((state.vitals.mp / state.vitals.maxMp) * 100) : null,
        adena: state.adena,
        partyId: state.party?.partyId || null,
        role: state.party?.role || state.stats?.role || 'dps',
        lastReason: state.stats?.lastReason || null,
        newbieAnchor: !!state.stats?.newbieAnchor
    };
}

function compactEvents(events) {
    return events.map((event) => ({
        type: event.type,
        summary: event.summary,
        ageSec: event.createdAt ? Math.max(0, Math.round((Date.now() - event.createdAt) / 1000)) : null
    }));
}

function fallbackReply(state, availability, text) {
    const name = state?.name || 'I';
    const activity = state?.activity || 'hunting';
    const hpPct = state?.vitals?.maxHp ? Math.round((state.vitals.hp / state.vitals.maxHp) * 100) : null;
    const lower = String(text || '').toLowerCase();

    if (availability?.reason === 'low_trust') {
        return `I hear you, but I don't trust you enough yet.`;
    }
    if (availability?.reason === 'recently_abandoned') {
        return `Not now. Last party ended badly.`;
    }
    if (activity === 'dead' || availability?.reason === 'bot_dead') {
        return `I died out here. Running back from town when I can.`;
    }
    if (activity === 'resting' || (hpPct !== null && hpPct < 35)) {
        return `I'm recovering for a bit, HP is around ${hpPct ?? 'low'}%.`;
    }
    if (lower.includes('party') || lower.includes('пати') || lower.includes('invite')) {
        return `Invite me by name if you want, I'm near ${state?.homeRegion || 'my spot'}.`;
    }
    if (lower.includes('where') || lower.includes('где')) {
        return `${name} here. I'm ${activity} near ${state?.homeRegion || state?.spotId || 'my hunting spot'}.`;
    }

    return `Hey. I'm ${activity} near ${state?.homeRegion || 'my hunting spot'} right now.`;
}

function schema() {
    return {
        type: 'object',
        properties: {
            reply: {
                type: 'string',
                description: 'Short in-character private reply. Long factual lists may be up to 360 chars.'
            },
            intent: {
                type: 'string',
                enum: ['none', 'open_to_party', 'decline_party', 'keep_hunting', 'resting', 'traveling']
            },
            reason: {
                type: 'string',
                description: 'Short internal reason.'
            },
            confidence: {
                type: 'number',
                minimum: 0,
                maximum: 1
            }
        },
        required: ['reply', 'intent', 'reason', 'confidence'],
        additionalProperties: false
    };
}

function systemPrompt() {
    return [
        'You are replying as one Lineage 2 bot in private chat.',
        'Use only the provided state, social memory, availability, and life events.',
        'Do not invent items, rewards, locations, levels, party membership, or combat results.',
        'Keep the reply short, grounded, and in character.',
        'You may express a high-level intent, but server code decides all real actions.'
    ].join(' ');
}

async function requestLlmReply(payload, cfg) {
    if (typeof fetch !== 'function') return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs);

    try {
        const response = await fetch(OPENROUTER_URL, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${cfg.apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'http://localhost',
                'X-OpenRouter-Title': 'L2Node Bots'
            },
            body: JSON.stringify({
                model: cfg.model,
                messages: [
                    { role: 'system', content: systemPrompt() },
                    { role: 'user', content: JSON.stringify(payload) }
                ],
                temperature: cfg.temperature,
                max_tokens: cfg.maxTokens,
                response_format: {
                    type: 'json_schema',
                    json_schema: {
                        name: 'bot_remote_chat',
                        strict: true,
                        schema: schema()
                    }
                }
            }),
            signal: controller.signal
        });

        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            utils.infoWarn('BotRemoteChat', 'OpenRouter request failed: %d %s', response.status, detail.slice(0, 180));
            return null;
        }

        const json = await response.json();
        const content = json.choices?.[0]?.message?.content;
        if (!content) return null;

        const parsed = JSON.parse(content);
        const BotChatText = invoke('GameServer/Bot/AI/BotChatText');
        const reply = BotChatText.normalize(parsed.reply).slice(0, BotChatText.DEFAULT_LINE_LIMIT * BotChatText.DEFAULT_MAX_LINES);
        if (!reply || Number(parsed.confidence || 0) < 0.35) return null;

        return {
            reply,
            intent: parsed.intent || 'none',
            reason: parsed.reason || 'llm',
            llm: true
        };
    } catch (err) {
        if (err.name !== 'AbortError') {
            utils.infoWarn('BotRemoteChat', 'OpenRouter error: %s', err.message);
        }
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

const BotRemoteChat = {
    replyForState(playerSession, state, text) {
        if (!playerSession?.actor || !state) {
            return Promise.resolve({ ok: false, reason: 'missing_context' });
        }

        const cfg = config();
        const key = `${playerSession.actor.fetchId()}:${state.characterId}`;
        const lastAt = cooldowns.get(key) || 0;
        if (lastAt && Date.now() - lastAt < cfg.remoteChatCooldownMs) {
            return Promise.resolve({
                ok: true,
                reply: `Give me a moment, I'm still sorting things out.`,
                intent: 'none',
                reason: 'cooldown'
            });
        }
        cooldowns.set(key, Date.now());

        const availability = BotAvailability.evaluateState(playerSession, state);
        return LifeEvents.recentForBot(state.characterId, 5).then((events) => {
            const memory = BotSocialMemory.getSnapshot(playerSession, state);
            const payload = {
                event: 'remote_chat',
                playerMessage: String(text || '').slice(0, 240),
                player: playerSummary(playerSession),
                bot: stateSummary(state),
                social: {
                    relationship: BotSocialMemory.relationship(memory),
                    trust: memory.trust,
                    familiarity: memory.familiarity,
                    groupRuns: memory.groupRuns,
                    tradesCompleted: memory.tradesCompleted
                },
                availability: {
                    available: availability.available,
                    reason: availability.reason,
                    reasonText: availability.reasonText
                },
                recentEvents: compactEvents(events),
                constraints: {
                    privateReply: true,
                    noActivation: true,
                    noCombatMicromanagement: true,
                    noInventedFacts: true
                }
            };

            const fallback = {
                ok: true,
                reply: fallbackReply(state, availability, text),
                intent: 'none',
                reason: 'fallback'
            };

            const llmReady = cfg.enabled && !!cfg.apiKey;
            if (!llmReady) return fallback;

            return requestLlmReply(payload, cfg).then((result) => result || fallback);
        }).then((result) => {
            BotSocialMemory.recordEvent(playerSession, state, 'chat', result.reason || 'remote_chat');
            return result;
        });
    }
};

module.exports = BotRemoteChat;
