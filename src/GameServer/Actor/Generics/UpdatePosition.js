const Database = invoke('Database');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');

function updatePosition(session, actor, coords, environmentOptions) {
    const Generics = invoke(path.actor);

    // NOTE: Do NOT snap Z to geodata here. UpdatePosition is called both after
    // teleports (with correct Z from teleport data) and after movement. Geodata
    // Z-correction is handled inside MoveTo.js during actual pathfinding steps.
    // Overriding Z here causes actors to fall through terrain in cities where
    // geodata is inaccurate (Dion, Gludio, Dark Elf Village, etc.).

    // TODO: Write less in DB about movement
    actor.setLocXYZH(coords);
    Database.updateCharacterLocation(actor.fetchId(), coords);

    // Update Online users, NPCs, underwater locations
    Generics.updateEnvironment(session, actor, environmentOptions);
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
