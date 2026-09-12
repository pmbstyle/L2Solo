const View = require('./ClanSocialView');
const Policy = require('./ClanSocialPolicy');
const view = new View();
let cursor = 0, running = null, lastMemberships = '', lastCheck = 0;
const sent = new Map();
let sentEpoch = '', sentMembershipVersion = 0;
let activeClanIds = [];
let expelling = false;
const disciplineRetryAt = new Map();
let counts = { clans: 0, relations: 0, discipline: {} };
async function announce(snapshot, previous) {
    if (!previous) return;
    const changed = snapshot.relations.some(r => ['warned', 'probation'].includes(r.discipline?.stage)
        && previous.relations.find(p => p.kind === r.kind && p.targetId === r.targetId)?.discipline?.stageAt !== r.discipline.stageAt);
    if (!changed || !await invoke('Database').isAutonomousClan(snapshot.clanId)) return;
    const service = invoke('GameServer/Clan/ClanService'), clan = service.findById(snapshot.clanId);
    if (!clan) return;
    const leader = clan.members.find(m => m.id === clan.leaderId);
    if (!leader) return;
    for (const r of snapshot.relations) {
        const d = r.discipline;
        if (!d || !['warned', 'probation'].includes(d.stage)) continue;
        const old = previous.relations.find(p => p.kind === r.kind && p.targetId === r.targetId)?.discipline;
        if (old?.stageAt === d.stageAt) continue;
        const name = clan.members.find(m => m.id === r.targetId)?.name;
        if (!name) continue;
        const text = d.stage === 'warned' ? `${name}, your repeated provocations are hurting our clan. This is a warning.`
            : `${name}, you are on probation. Another serious incident may cost you your place in the clan.`;
        const packet = invoke('GameServer/Network/Response').speak({ fetchId: () => leader.id, fetchName: () => leader.name }, { kind: 4, text });
        service.onlineSessions(clan).forEach(s => s.dataSendToMe(packet));
    }
}
async function enforceOne(coordinator) {
    if (expelling || coordinator.stopping || !coordinator.competitionActions?.canRun()) return;
    const candidate = [...view.clans.values()].flatMap(s => s.relations
        .filter(r => r.discipline && Policy.relation(r, Date.now()).discipline.stage === 'expulsion_pending').map(r => ({ s, id: r.targetId })))
        .find(({ s, id }) => Date.now() >= (disciplineRetryAt.get(id) || 0)
            && view.memberships.get(id) === s.clanId && invoke('GameServer/Clan/ClanService').findById(s.clanId)?.leaderId !== id);
    if (!candidate) return;
    expelling = true;
    const { s, id } = candidate;
    disciplineRetryAt.set(id, Date.now() + 60000);
    while (disciplineRetryAt.size > 256) disciplineRetryAt.delete(disciplineRetryAt.keys().next().value);
    const Life = invoke('GameServer/Bot/Population/BotLifeState');
    try {
        if (!await invoke('Database').isAutonomousClan(s.clanId)) return;
        const fenced = await coordinator.fenceBot(id);
        if (!fenced.ok) return;
        await Life.settleWrites([id]);
        const result = await invoke('Database').expelDisciplinedClanMember(s.clanId, id, s.revision);
        if (!result.ok) return;
        view.accept(result.snapshot);
        const state = Life.acceptLifecycleRow(result.row);
        result.memorySnapshots.forEach(m => invoke('GameServer/Social/InteractionMemoryRuntime').accept(m));
        invoke('GameServer/Clan/ClanService').applyDisciplineRemoval(result);
        coordinator.notifyState(state);
        utils.infoWarn('ClanSocial', 'clan %d expelled member %d after warning and probation', s.clanId, id);
    } finally {
        const state = Life.cachedState(id);
        if (state) coordinator.notifyState(state);
        expelling = false;
    }
}
function syncMemberships() {
    const clans = invoke('GameServer/Clan/ClanService').all();
    activeClanIds = clans.map(c => Number(c.id));
    const rows = clans.flatMap(c => c.members.map(m => ({ id: Number(m.id), clanId: Number(c.id) })));
    const signature = JSON.stringify([rows, activeClanIds]);
    if (signature !== lastMemberships) {
        lastMemberships = signature;
        view.acceptMemberships(rows, Math.max(Date.now(), view.membershipVersion + 1), activeClanIds);
    }
    for (const clan of clans) if (!view.clans.has(clan.id)) view.accept(Policy.empty(clan.id));
}
async function refresh(force = false) {
    if (running) return running;
    if (!force && Date.now() - lastCheck < 5000) return;
    lastCheck = Date.now();
    running = (async () => {
        syncMemberships();
        // The single writer assigns a globally increasing clan change stamp.
        const rows = await invoke('Database').execute(['SELECT snapshotJson, updatedAt FROM clan_social_memory WHERE updatedAt > ? ORDER BY updatedAt, clanId LIMIT 64', [cursor]], 'clan-social:refresh');
        for (const row of rows) {
            const snapshot = JSON.parse(row.snapshotJson), previous = view.clans.get(snapshot.clanId);
            if (view.accept(snapshot)) await announce(snapshot, previous);
            cursor = Math.max(cursor, row.updatedAt);
        }
        counts = { clans: view.clans.size, relations: 0, discipline: {} };
        for (const snapshot of view.clans.values()) for (const r of snapshot.relations) {
            counts.relations++;
            const stage = Policy.relation(r, Date.now()).discipline?.stage;
            if (stage) counts.discipline[stage] = (counts.discipline[stage] || 0) + 1;
        }
    })().finally(() => { running = null; });
    return running;
}
function projection(s) {
    return { ...s, recent: [], relations: s.relations.map(({ evidence, budget, ...r }) => r) };
}
function send(coordinator) {
    if (sentEpoch !== coordinator.workerEpoch) { sentEpoch = coordinator.workerEpoch; sent.clear(); sentMembershipVersion = 0; }
    if (sentMembershipVersion !== view.membershipVersion) {
        const memberships = [...view.memberships].map(([id, clanId]) => ({ id, clanId }));
        if (!coordinator.post('clan_social_page', { rows: [], memberships, activeClanIds, membershipVersion: view.membershipVersion })) return;
        sentMembershipVersion = view.membershipVersion;
        for (const id of sent.keys()) if (!view.clans.has(id)) sent.delete(id);
    }
    for (const [id, s] of view.clans) {
        if (sent.get(id) === s.revision) continue;
        if (!coordinator.post('clan_social_page', { rows: [projection(s)] })) return;
        sent.set(id, s.revision);
    }
}
function inspect(at = Date.now()) {
    return { clans: [...view.clans.values()].map(s => ({ clanId: s.clanId, revision: s.revision,
        relations: s.relations.map(r => ({ ...Policy.relation(r, at), stance: Policy.stance(r, at), evidence: undefined })) })) };
}
module.exports = { view, refresh, send, syncMemberships, inspect, enforceOne, summary: () => counts };
