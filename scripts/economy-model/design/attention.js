'use strict';

// One fact queue and one led character per account: the facts of all its
// characters wait in one queue and are heard as one chain where the account
// stands (the catalog's plane of each fact); a fact raised while it cannot be
// heard (a stock run out on the road) waits for the place where it is (the
// arrival). Pure on plain data; an account is replaced, never edited:
//   account = { id, led: character id, place: 'hunt' | 'road' | 'town', queue: [{ kind, who, at }] }
// Called by the design plane, once per fact and once per chain.
const { situationOf, heardAt } = require('./catalog');

// The account with a fact queued. The same kind for the same character is one
// entry: a waiting fact is not raised twice.
function push(account, fact) {
    situationOf(fact.kind);
    if (account.queue.some(held => held.kind === fact.kind && held.who === fact.who)) return account;
    return { ...account, queue: [...account.queue, { kind: fact.kind, who: fact.who, at: fact.at }] };
}

// The facts heard where the account stands, in queue order (one chain), and
// the account holding the rest.
function heard(account) {
    const chain = [], rest = [];
    for (const fact of account.queue) (heardAt(fact.kind, account.place) ? chain : rest).push(fact);
    return { chain, account: chain.length ? { ...account, queue: rest } : account };
}

// The character the account's decisions serve. With no plan goals (one
// character hunting for itself) it is always the led one.
function ledOf(account, characters) {
    return characters.find(character => character.id === account.led) || null;
}

module.exports = { push, heard, ledOf };
