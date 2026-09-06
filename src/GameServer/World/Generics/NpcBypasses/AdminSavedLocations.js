const Database = invoke('Database');
const ServerResponse = invoke('GameServer/Network/Response');
const Html = invoke('GameServer/World/Generics/HtmlKit');

const PAGE_SIZE = 8;

async function render(session, actor, requestedPage = 0, notice = '') {
    const locations = await Database.fetchSavedLocations(actor.fetchId());
    if (session.actor !== actor) return;
    const pages = Math.max(1, Math.ceil(locations.length / PAGE_SIZE));
    const page = Math.min(Math.max(0, Number(requestedPage) || 0), pages - 1);
    let body = '<html><body><a action="bypass -h html Admin/teleport">Back to Teleports</a><br>'
        + '<center><font color="LEVEL">My Saved Locations</font></center><br>';
    if (notice) body += `${Html.esc(notice)}<br><br>`;
    body += 'Save current position (optional name):<br>'
        + '<edit var="location_name" width=240 height=15 length=40><br>'
        + Html.button('Save', 'admin-saved-locations save $location_name', { width: 75, height: 21 })
        + '<br><br>';
    if (!locations.length) body += 'No saved locations yet.<br>';
    for (const location of locations.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)) {
        body += `<font color="LEVEL">${Html.esc(location.name)}</font><br1>`
            + `${location.locX}, ${location.locY}, ${location.locZ}<br1>`
            + `<a action="bypass -h admin-saved-locations go ${location.id} ${page}">Teleport</a>&nbsp;&nbsp;`
            + `<a action="bypass -h admin-saved-locations delete ${location.id} ${page}">Delete</a><br><br>`;
    }
    body += `Page ${page + 1} / ${pages}`;
    if (page > 0) body += ` <a action="bypass -h admin-saved-locations page ${page - 1}">Previous</a>`;
    if (page + 1 < pages) body += ` <a action="bypass -h admin-saved-locations page ${page + 1}">Next</a>`;
    session.dataSendToMe(ServerResponse.npcHtml(actor.fetchId(), body + '</body></html>'));
}

async function handle(session, parts) {
    const actor = session.actor;
    if (!actor) return;
    const action = parts[1] || 'page';
    if (action === 'save') {
        const coords = {
            locX: Math.round(actor.fetchLocX()), locY: Math.round(actor.fetchLocY()),
            locZ: Math.round(actor.fetchLocZ()), head: Math.round(actor.fetchHead())
        };
        if (!Object.values(coords).every((value) => Number.isSafeInteger(value) && value >= -2147483648 && value <= 2147483647)) {
            return render(session, actor, 0, 'Current position is unavailable.');
        }
        const name = parts.slice(2).join(' ').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 40)
            || `Location ${coords.locX}, ${coords.locY}, ${coords.locZ}`;
        await Database.saveLocation(actor.fetchId(), name, coords);
        return render(session, actor, 0, 'Location saved.');
    }
    if (action === 'go' || action === 'delete') {
        const id = Number(parts[2]);
        const page = Number.isSafeInteger(Number(parts[3])) ? Number(parts[3]) : 0;
        if (!Number.isSafeInteger(id) || id <= 0) return render(session, actor, page, 'Invalid location.');
        if (action === 'delete') {
            const result = await Database.deleteSavedLocation(actor.fetchId(), id);
            return render(session, actor, page, result.affectedRows ? 'Location deleted.' : 'Location no longer exists.');
        }
        const [location] = await Database.fetchSavedLocation(actor.fetchId(), id);
        if (session.actor !== actor) return;
        if (!location) return render(session, actor, page, 'Location no longer exists.');
        const { locX, locY, locZ, head } = location;
        const moved = invoke(path.actor).teleportTo(session, actor, { locX, locY, locZ, head });
        if (moved === false) return render(session, actor, page, 'Cannot teleport right now.');
        return;
    }
    return render(session, actor, Number.isSafeInteger(Number(parts[2])) ? Number(parts[2]) : 0);
}

module.exports = function(session, parts = []) {
    return handle(session, parts).catch((error) => {
        utils.infoWarn('GameServer', 'saved locations failed: %s', error.message || error);
        session.dataSendToMe(ServerResponse.speak(session.actor, { kind: 0, text: 'Could not access saved locations. Please try again.' }));
        session.dataSendToMe(ServerResponse.actionFailed());
    });
};
