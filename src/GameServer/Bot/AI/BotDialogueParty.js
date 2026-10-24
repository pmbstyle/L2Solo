// Membership answers use the same server decision as native invitations.
// Being willing now is not a reservation or a promise about future state.
const INTENT_SCHEMA = { type: 'string', enum: ['none', 'membership'],
    description: 'membership when discussing whether you and the speaker can form/join a party; none for other topics.' };
const PROMPT = 'When discussing whether you and the speaker can group, set partyIntent=membership, including indirect questions and mixed requests. Use none when only discussing other candidates or clan invitations. Party availability is checked by the server; never promise acceptance of a later invite.';

function hasPartyContext(value) {
    return /\b(?:party|group|team)\b|\u043f\u0430\u0442\u0438|\u0433\u0440\u0443\u043f\u043f|\u043a\u043e\u043c\u0430\u043d\u0434/i.test(value);
}

function otherMembership(value) {
    return /\b(?:clan|guild|alliance)\b|\u043a\u043b\u0430\u043d|\u0433\u0438\u043b\u044c\u0434\u0438|\u0430\u043b\u044c\u044f\u043d/i.test(value) && !hasPartyContext(value);
}

function otherInvitation(value) {
    return /\bjoin\s+(?:(?:my|your|our|the|this|a|an|new)\s+){0,3}(?:clan|guild|alliance)\b(?!\s+(?:party|group|team)\b)|\binvite\s+(?:(?:me|you|us|them)\s+)?(?:to|into)\s+(?:(?:my|your|our|the|this|a|an|new)\s+){0,3}(?:clan|guild|alliance)\b|\b(?:clan|guild|alliance)\s+(?:invite|invitation)\b/i.test(value);
}

function membershipText(text) {
    return String(text || '').split(/[.!?;,]/).map(clause => clause.trim())
        .filter(clause => clause && !otherMembership(clause)).join('. ');
}

function directRequest(value) {
    value = membershipText(value);
    if (otherMembership(value)) return false;
    // Asking this bot takes precedence over mentioning other candidates in
    // the same message. A bare join inside a candidate question does not.
    if (/\b(?:can|could|would|will|may)\s+you\s+(?:please\s+)?(?:join\s+(?:me|us|(?:(?:my|our|the|this)\s+)?(?:party|group|team))\b|(?:party|group|team)(?:\s+up)?\s+with\s+(?:me|us)\b)|\b(?:can|could|may)\s+i\s+join\s+(?:you(?:\s+guys)?|(?:your|this)\s+(?:party|group|team))\b|(?:^|[.!?;]\s*)(?:please\s+)?join\s+(?:me|us|(?:my|our)\s+(?:party|group|team))\b/i.test(value)) return true;
    if (/^\s*(?:who|anyone|anybody|someone|somebody)\b/i.test(value)) return false;
    return /\b(?:can|could|shall|should)\s+we\s+(?:(?:form|make|start|create)\s+(?:a\s+)?)?(?:party|group|team)\b|\bwe\s+(?:can|could|might)\s+(?:party|group|team)\b/i.test(value);
}

function isCandidateRequest(text) {
    const value = membershipText(text);
    if (otherMembership(value) || directRequest(value)) return false;
    const candidate = /\b(?:other|another|anyone|anybody|somebody|someone|who|other\s+bots?)\b|\u043a\u0442\u043e|\u0434\u0440\u0443\u0433(?:\u0438\u0435|\u0438\u0445)?\s+(?:\u0431\u043e\u0442|\u0438\u0433\u0440\u043e\u043a)/i;
    const party = /\b(?:party|group|team|join|invite|member|bot|player)s?\b|\u043f\u0430\u0442\u0438|\u0433\u0440\u0443\u043f\u043f|\u043a\u043e\u043c\u0430\u043d\u0434|\u043f\u0440\u0438\u0441\u043e\u0435\u0434\u0438\u043d|\u0438\u0433\u0440\u043e\u043a/i;
    return candidate.test(value) && party.test(value);
}

function isRequest(text) {
    const value = membershipText(text);
    if (otherMembership(value)) return false;
    if (directRequest(value)) return true;
    if (isCandidateRequest(value)) return false;
    if (/\b(?:did|used to|yesterday|last time)\b/.test(value.toLowerCase())) return false;
    if (/\b(?:can|could|shall|should)\s+(?:we|you|i)\s+(?:form|make|start|create)\s+(?:a\s+)?(?:party|group|team)\b|\b(?:are|would)\s+you\s+(?:be\s+)?up\s+for\s+(?:a\s+)?(?:party|group|team)\b/i.test(value)) return true;
    if (/\b(?:we|you|i)\s+(?:can|could|might)\s+(?:party|group|team)\b/i.test(value)) return true;
    return /\b(?:join|invite|add|take)\s+(?:(?:me|us|you)\s+(?:to|into)\s+)?(?:(?:your|my|our|the|this|a)\s+)?(?:party|group|team)\b|\b(?:party\s+up|group\s+up|(?:wanna|want(?:\s+to)?|let'?s|looking\s+to)\s+(?:party|group|team)|(?:can|could|shall|should|would|may|might)\s+(?:we|you|i)\s+(?:party|group|team)|(?:party|group)\s+with\s+(?:me|us))\b|\u043f\u0430\u0442\u0438\s*(?:\u0432\u0441\u0442\u0443\u043f|\u043f\u0440\u0438\u0441\u043e\u0435\u0434\u0438\u043d|\u0438\u043d\u0432\u0430\u0439\u0442)|(?:\u043c\u043e\u0436\u0435\u043c|\u0434\u0430\u0432\u0430\u0439)\s+(?:\u0432\s+)?(?:\u043f\u0430\u0442\u0438|\u0433\u0440\u0443\u043f\u043f)/i.test(value);
}

function shouldCheck(text, decision = {}) {
    const speech = membershipText(decision.reply);
    const request = isRequest(text);
    if (request || decision.partyIntent === 'membership') return true;
    if ((otherMembership(text) || otherInvitation(text)) && !hasPartyContext(speech)) return false;
    // A model may volunteer a promise even when the request classifier misses
    // an indirect question. Never deliver such a promise as an admission.
    if (otherMembership(speech)) return false;
    return /\b(?:party|group|team|invite)\b/i.test(speech) &&
        (/\b(?:i|we)(?:['\u2019]ll|\s+(?:will|would|can|could))\s+(?:(?:gladly|happily|also|love\s+to|like\s+to)\s+)?(?:join\b|accept\s+(?:(?:your|the|that)\s+)?invite\b|form\s+(?:a\s+)?(?:party|group|team)\b)/i.test(speech)
            || /\b(?:i['\u2019]m|i am|we['\u2019]re|we are)\s+(?:(?:down|ready|happy|willing)\s+to\s+(?:join|group)|(?:up|down)\s+for\s+(?:(?:a|your|the)\s+)?(?:party|group|team))\b/i.test(speech)
            || /\b(?:send|give|throw)\s+(?:me\s+)?(?:an?\s+)?invite\b|\blet['\u2019]?s\s+(?:party|group)\b/i.test(speech));
}

function isArrivalRequest(text) {
    const value = String(text || '');
    if (/\b(?:don't|do not|never|stop)\s+(?:come|walk|run|move|head|get|teleport|meet)\b/i.test(value)) return false;
    const movement = '(?:come|walk|run|move|head|get|teleport)\\s+(?:here|over(?:\\s+here)?|closer|(?:to|near)\\s+(?:me|us))\\b|meet\\s+(?:me|us)\\s+here\\b';
    return new RegExp(`(?:^|[.!?,;:]\\s*)(?:(?:please|just)\\s+)*(?:${movement})`, 'i').test(value)
        || new RegExp(`\\b(?:can|could|would|will)\\s+you\\s+(?:(?:please|just)\\s+)*(?:${movement})`, 'i').test(value)
        || /(?:^|[.!?,;]\s*)(?:\u043f\u0440\u0438\u0434\u0438|\u043f\u043e\u0434\u043e\u0439\u0434\u0438|\u0438\u0434\u0438)\s+(?:\u0441\u044e\u0434\u0430|\u043a(?:\u043e)?\s+\u043c\u043d\u0435)/i.test(value);
}

function reply(availability, subject = null, text = '') {
    const level = Number(subject?.actor?.fetchLevel?.() ?? subject?.level);
    const prefix = /\blevel\b|\u0443\u0440\u043e\u0432\u0435\u043d\u044c|\u043b\u0432\u043b/i.test(String(text))
        && Number.isFinite(level) && level > 0 ? `I'm level ${level}. ` : '';
    if (availability?.available) return prefix + "I'm open to grouping right now. Send an invite so we can check the party.";
    if (availability?.reason === 'bot_dead') return prefix + 'I died and need to recover before we can group. Ask me again once I am back.';
    return prefix + `I cannot join right now: ${availability?.reasonText || availability?.reason || 'I need to check a few things first'}.`;
}

function apply(decision, availability, subject = null, text = '') {
    return { ...decision, action: 'say', reply: reply(availability, subject, text),
        reason: `party_policy:${availability?.reason || 'unavailable'}`, confidence: 1 };
}

module.exports = { INTENT_SCHEMA, PROMPT, isCandidateRequest, isRequest, isArrivalRequest, shouldCheck, reply, apply };
