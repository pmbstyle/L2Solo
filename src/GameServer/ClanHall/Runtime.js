const Policy = require('./Policy');
const HOUR = 60 * 60 * 1000;
let halls = [],
    timer = null,
    running = false,
    clanOffset = 0;
// Hourly dues pass per clan: when it is due and how far it got (4 members per tick).
const duesPasses = new Map();
function applyRows(rows) {
    halls = rows.map((h) => ({ ...Policy.definition(h.id), ...h, functions: JSON.parse(h.functionsJson || '{}') }));
}
function owned(clanId) {
    return Number(clanId) > 0 ? halls.find((h) => h.ownerId === Number(clanId)) || null : null;
}
function forActor(actor) {
    return owned(actor?.fetchClanId?.());
}
function refresh(rows) {
    const before = new Map(halls.map((h) => [h.id, h.ownerId]));
    applyRows(rows);
    const World = invoke('GameServer/World/World'),
        response = invoke('GameServer/Network/Response');
    for (const h of halls) {
        if (before.get(h.id) === h.ownerId) continue;
        require('./Doors').change(h.id, false);
        for (const session of World.user?.sessions || []) {
            const actor = session.actor,
                id = actor?.fetchClanId?.();
            if (id && (id === h.ownerId || id === before.get(h.id))) {
                const clan = invoke('GameServer/Clan/ClanService').findById(id);
                if (clan) {
                    session.dataSendToMe(response.pledgeShowInfoUpdate(clan));
                    // Lisvus Auction.removeBids / ClanHall.RentTask: notify online clan members.
                    session.dataSendToMe(id === h.ownerId
                        ? response.systemMessage(776, clan.name)
                        : response.systemMessage(1052));
                }
            }
            if (before.get(h.id) > 0 && Policy.inside(h, actor || {}) && id !== h.ownerId) {
                const coords = invoke('GameServer/World/TownRespawn').getRespawnCoords(
                    actor.fetchLocX(),
                    actor.fetchLocY(),
                    actor.fetchLocZ()
                );
                invoke('GameServer/Actor/Generics/TeleportTo')(session, actor, coords);
            }
        }
    }
}
// One dues settlement per member and hour (ClanHall/Repository.settleClanDues),
// at most 4 members per tick. Rates follow the members' personas
// (ClanContributionPolicy); a busy member pays at the next pass.
async function settleDues(db, id, level, leaderId) {
    const pass = duesPasses.get(id) || { nextAt: 0, offset: 0 };
    if (Date.now() < pass.nextAt) return;
    const members = await db.execute(
        [
            `SELECT c.id, p.traitsJson FROM characters c JOIN bot_life_state l ON l.characterId=c.id
        LEFT JOIN bot_personas p ON p.characterId=c.id
        WHERE c.clanId=? AND l.phase='cold' AND c.username NOT LIKE 'bot_craft_%' ORDER BY c.id`,
            [id]
        ],
        'clan-hall:contributors'
    );
    const DuesPolicy = invoke('GameServer/Clan/ClanContributionPolicy');
    const life = invoke('GameServer/Bot/Population/BotLifeState');
    const traitsOf = (member) => {
        try { return JSON.parse(member.traitsJson || '{}'); } catch (_) { return {}; }
    };
    const clanRate = DuesPolicy.duesRate(members.map(traitsOf));
    const end = Math.min(members.length, pass.offset + 4);
    for (let i = pass.offset; i < end; i++) {
        const characterId = members[i].id;
        const traits = traitsOf(members[i]);
        await life.settleWrites(level === 0 ? [characterId, leaderId] : [characterId]);
        const state = life.cachedState(characterId);
        const result = await db.settleClanDues({
            clanId: id,
            characterId,
            rate: DuesPolicy.memberRate(clanRate, traits, state),
            investFraction: DuesPolicy.investFraction(traits)
        });
        life.acceptNewerLifecycleRow(result.row);
        life.acceptNewerLifecycleRow(result.leaderRow);
    }
    if (end < members.length) {
        duesPasses.set(id, { nextAt: 0, offset: end });
        return;
    }
    duesPasses.set(id, { nextAt: Date.now() + HOUR, offset: 0 });
    // Levels 0-1 chain contributions only: refresh the stored goal's progress once per pass.
    if (level <= 1) {
        const Goals = invoke('GameServer/Clan/ClanGoalService');
        try {
            await Goals.resolveClan(await Goals.clanProjectionById(id));
        } catch (error) {
            utils.infoWarn('ClanGoal', 'level goal refresh failed for clan %d: %s', id, error.message);
        }
    }
}
async function tick() {
    if (running) return;
    running = true;
    try {
        const db = invoke('Database');
        refresh(await db.tickClanHalls());
        if (!invoke('GameServer/Clan/ClanSimulationConfig').enabled) return;
        const clans = await db.execute(
            [
                `SELECT c.id, c.level, c.leaderId FROM clans c JOIN clan_simulation_clans s ON s.clanId=c.id
            WHERE s.mode='autonomous' ORDER BY c.id`,
                []
            ],
            'clan-hall:bot-clans'
        );
        const deadline = Date.now() + 40;
        let count = 0;
        while (clans.length && count < clans.length && Date.now() < deadline) {
            const { id, level, leaderId } = clans[clanOffset % clans.length];
            clanOffset++;
            count++;
            if (Number(level) >= 2) await db.planClanHallFinance(id);
            await settleDues(db, id, Number(level), Number(leaderId));
        }
        refresh(await db.fetchClanHallAuctions());
    } finally {
        running = false;
    }
}
module.exports = {
    Policy,
    applyRows,
    owned,
    forActor,
    tick,
    all: () => halls,
    async start() {
        this.stop();
        applyRows(await invoke('Database').initClanHalls());
        require('./Doors').start(invoke('GameServer/World/World'));
        timer = setInterval(
            () => tick().catch((e) => utils.infoWarn('ClanHall', 'finance tick: %s', e.message)),
            10000
        );
        timer.unref?.();
    },
    stop() {
        if (timer) clearInterval(timer);
        timer = null;
    },
    async refresh() {
        refresh(await invoke('Database').fetchClanHallAuctions());
    },
    destination(actor) {
        return forActor(actor)?.spawn || null;
    },
    regen(actor, kind) {
        const hall = forActor(actor);
        return hall && Date.now() < hall.serviceDueAt && Policy.inside(hall, actor)
            ? 1 + (Number(hall.functions[kind]) || 0) / 100
            : 1;
    },
    expRestore(actor) {
        const h = forActor(actor);
        return h && Date.now() < h.serviceDueAt ? Number(h.functions.exp) || 0 : 0;
    }
};
