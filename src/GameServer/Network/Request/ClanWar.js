const Receive = invoke('Packet/Receive');
const Clans = invoke('GameServer/Clan/ClanService');
function consume(session, name, action) {
    const actor = session?.actor;
    const target = Clans.all().find(c => c.name.toLowerCase() === String(name || '').trim().toLowerCase());
    if (!actor || !target) return Promise.resolve(fail(session, 'clan_not_found'));
    return invoke('GameServer/Clan/ClanWarRuntime').transition(actor, target.id, action, {
        admit: () => session.actor === actor && actor.fetchIsOnline?.() !== false
    }).then(result => result.ok ? result : fail(session, result.code)).catch(error => {
        utils.infoWarn('ClanWar', 'request failed: %s', error.message);
        return fail(session, 'war_failed');
    });
}
function fail(session, code) {
    if (session?.actor) {
        const Response = invoke('GameServer/Network/Response');
        session.dataSendToMe(Response.speak(session.actor, { kind: 10, text: `Clan war: ${String(code).replaceAll('_', ' ')}.` }));
        session.dataSendToMe(Response.actionFailed());
    }
    return { ok: false, code };
}
const handler = action => (session, buffer) => {
    const packet = new Receive(buffer); packet.readS();
    if (packet.data.length !== 1 || packet.offset !== buffer.length || packet.data[0].length > 16) return Promise.resolve(fail(session, 'invalid_clan_name'));
    return consume(session, packet.data[0], action);
};
function list(session, command) {
    const own = Number(session?.actor?.fetchClanId?.() || 0), wars = invoke('GameServer/Clan/ClanWarRuntime').view;
    const rows = Clans.all().map(clan => ({ clan, state: wars.between(own, clan.id) }))
        .filter(({ state }) => command === 88 ? state.outgoing : command === 89 ? state.incoming : state.mutual);
    const Response = invoke('GameServer/Network/Response');
    const text = rows.length ? rows.map(({ clan, state }) => `${clan.name} (${state.status})`).join(', ') : 'No clans on this war list.';
    session.dataSendToMe(Response.speak(session.actor, { kind: 10, text }));
}
module.exports = { declare: handler('declare'), withdraw: handler('withdraw'), consume, list };
