const Database = invoke('Database');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');

function updatePosition(session, actor, coords) {
    const Generics = invoke(path.actor);

    // Snap coordinates to geodata elevation
    const geoHeight = GeodataEngine.getHeight(coords.locX, coords.locY, coords.locZ);
    coords.locZ = geoHeight;

    // TODO: Write less in DB about movement
    actor.setLocXYZH(coords);
    Database.updateCharacterLocation(actor.fetchId(), coords);

    // Update Online users, NPCs, underwater locations
    Generics.updateEnvironment(session, actor);
    Generics.underwaterCheck  (session, actor);

    // Reschedule actions based on updated position
    if (actor.storedAttack) {
        Generics.attackExec(session, actor, structuredClone(actor.storedAttack));
        Generics.clearStoredActions(session, actor);
    }

    if (actor.storedSpell) {
        Generics. skillExec(session, actor, structuredClone(actor.storedSpell ));
        Generics.clearStoredActions(session, actor);
    }

    if (actor.storedPickup) {
        Generics.pickupExec(session, actor, structuredClone(actor.storedPickup));
        Generics.clearStoredActions(session, actor);
    }
}

module.exports = updatePosition;
