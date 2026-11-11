// A PK-hunting bot stays autonomous: chat and tools may not redirect it.
// Each caller passes its own set of refused actions; the registry set and the
// tool availability set differ on purpose, only this check is shared.
// Loaded with a relative require so isolated module harnesses need no stub.
function isPkLocked(session, action, lockedActions) {
    return session?.plan === 'pk_hunting' && lockedActions.has(action);
}

module.exports = { isPkLocked };
