# Clan command parties

A clan leader with an existing player party can assemble additional bot parties.
Each party has at most nine members, including its designated leader. Parties
have stable session-local numbers; removing p1 does not rename p2. There is no
special two-party limit.

| Command | Result |
| --- | --- |
| `.createparty <leader>` | Create the next additional party with that clan bot |
| `.invite-p1 <character>` | Recruit a clan bot into p1 |
| `.kick-p1 <character>` | Release a member of p1 |
| `.leader-p1 <character>` | Promote an existing member of p1 |
| `.dismiss-p1` | Release all members of p1 |
| `.p1 hold` | Hold current positions and defend within the normal hold radius |
| `.p1 follow` | Resume following the commander |
| `.p1 regroup` | Gather in formation, then resume the previous movement order |
| `.main hold`, `.main follow`, `.main regroup` | Address the main party |
| `.all hold`, `.all follow`, `.all regroup` | Address the entire command |
| `.parties` | List additional parties and their members |
| `.partysave` | Save the main party and every additional party for this character |
| `.partyrestore` | Assemble the saved main party and all additional parties |

Use the same commands with p2, p3, and subsequent numbers. Recruiting a bot already
in the player's main party requires removing it from that party first. Clan
recruitment uses the existing activity handoff and activation path, including
capacity reservations and cancellation when the commander leaves.

## Saved composition

A clan leader can use `.partysave` to replace their saved composition. It stores
the main party's bot members, every additional party's members and designated
leader in SQLite. The save survives logout and server restarts. Character IDs
are stored, so renamed bots are restored by their current names.

`.partyrestore` works when the player is alone too. It assembles the main party
first, then the additional parties through the usual recruitment path. Existing
members are skipped, and restored groups keep their current party numbers.
If a member is unavailable, the others still assemble; the command reports the
missing names and can be repeated to retry them. Existing parties that conflict
with the saved member assignments must be adjusted first. Restore does not
dismiss unrelated additional parties or change loot settings and movement
orders. Leaving the main party or disconnecting cancels an unfinished restore.

## Combat and support

Each additional party keeps its own ordinary party membership for healing,
buffs, recharge, resurrection, party skill targets, and rewards. Farm targeting
and incoming threats are shared with the main party. Additional parties do not
start independent pulls. Formation positions are offset by party.

The main party retains its existing raid behavior. Additional parties prepare
their own buffs and resources and attack after the main party opens combat.
Their tanks participate without becoming the boss's main tank or taunting it.
Once the main party opens combat, ready damage dealers join even if local
support is still finishing buffs or recovering mana. Those support actions
occupy only their provider; full-party recovery is a pre-pull requirement.
Casualties do not stop surviving damage dealers: resurrection and recovery use
the additional party's own support. The main party's retreat is shared; retreat
does not dissolve the parties.

Accepted offensive casts reserve control effects and estimated incoming damage
across the command. Interruptions, impacts, and target death release those
reservations. Sleep/fear protection also applies to weapon attacks and splash.
Damage estimates are conservative and do not serialize attacks on healthy
targets.

## Loot and lifecycle

All additional parties inherit the main party's client loot distribution and
bot pickup toggle. Disabling pickup cancels additional parties' active pickup
runs too. Each party collects its own drops; changing its leader preserves
access to drops already on the ground. Distribution recipients remain inside
the collecting party.

EXP/SP attribution retains the current native behavior: for separate parties,
the killing party receives the reward. Additional parties can therefore receive
the kill reward instead of the main party. This feature does not introduce
damage-based reward sharing or change quest kill credit.

Leaving or dissolving the main party, losing its last companion, or disconnecting
releases every additional party. A member's death does not change membership.
Parties and movement orders last for the commander's current session.
