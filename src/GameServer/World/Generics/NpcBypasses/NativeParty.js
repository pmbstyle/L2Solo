// Client capabilities change presentation only. Every order still uses the
// existing companion handler and resolves membership again on the server.
module.exports = function nativeParty(session, parts) {
    if (!session?.actor) return;
    const CompanionControl = invoke('GameServer/World/Generics/NpcBypasses/CompanionControl');
    const operation = parts[1];
    // The native client reports its setting even with every companion UI closed.
    if (operation === 'distribution') {
        if (parts.length !== 3 || !/^[0-4]$/.test(parts[2] || '')) return;
        invoke('GameServer/Bot/AI/PartyCompanionService').syncClientDistribution(session, Number(parts[2]));
        return;
    }
    if (operation === 'open') {
        session.nativePartyUiVersion = ['1', '2', '3'].includes(parts[2]) ? Number(parts[2]) : 0;
        session.nativePartyUiOpen = session.nativePartyUiVersion > 0;
        CompanionControl.render(session, 0, { open: true });
        return;
    }
    if (![1, 2, 3].includes(session.nativePartyUiVersion)) return;
    if (operation === 'close') {
        session.nativePartyUiOpen = false;
        return;
    }
    if (!session.nativePartyUiOpen) return;
    if (operation === 'refresh') {
        CompanionControl.render(session);
        return;
    }
    if (operation === 'action') {
        const command = parts[2];
        const value = parts[3];
        const allowed = {
            combat: ['assist', 'protect', 'passive'],
            movement: ['follow', 'hold'],
            pull: ['auto', 'leader', 'off'],
            loot: ['on', 'off']
        };
        if (command === 'regroup' || (Object.hasOwn(allowed, command) && allowed[command].includes(value))) {
            CompanionControl(session, ['companion-control', command, value]);
        }
        return;
    }
    if (operation === 'member') {
        if (!/^\d{1,10}$/.test(parts[2] || '')) return;
        const Party = invoke('GameServer/Bot/AI/PartyCompanionService');
        const member = Party.membersForLeader(session).find((candidate) => (
            candidate.actor?.fetchId() === Number(parts[2])
        ));
        if (!member) {
            CompanionControl.render(session);
            return;
        }
        const name = member.actor.fetchName();
        const action = parts[3];
        if (['follow', 'stay', 'summon'].includes(action)) {
            CompanionControl(session, ['companion-control', action, name]);
        } else if (action === 'pull-on' || action === 'pull-off') {
            CompanionControl(session, ['companion-control', 'member-pull', action === 'pull-on' ? 'on' : 'off', name]);
        }
    }
};
