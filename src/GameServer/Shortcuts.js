const Database = invoke('Database');
const ServerResponse = invoke('GameServer/Network/Response');

// Resolve levels from the current skillbook; persisted slots contain only IDs.
async function refreshSkills(session, actor) {
    if (session.accountId?.startsWith('bot_')) return;
    try {
        const shortcuts = await Database.fetchShortcuts(actor.fetchId());
        for (const shortcut of shortcuts) {
            if (shortcut.kind !== 2) continue;
            const skill = actor.skillset.fetchSkill(shortcut.id);
            if (!skill || skill.fetchPassive()) continue;
            session.dataSendToMe(ServerResponse.addShortcut({ ...shortcut, level: skill.fetchLevel() }));
        }
    } catch (error) {
        utils.infoWarn('Character', 'skill shortcut refresh failed: %s', error.message);
    }
}

module.exports = { refreshSkills };
