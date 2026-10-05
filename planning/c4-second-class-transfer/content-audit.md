# C4 second-profession quest audit — 2026-10-04

All 23 trials (Q211–Q233) and all 31 second-profession routes passed the
automated server audit. No mandatory NPC template, hunt spawn or quest item
template is missing. The audit covers 168 dialogue NPC templates, 140 hunt
templates and 574 intermediate quest item templates; shared entries count once.

## Scope and evidence

- Full route walkthroughs use real quest handlers, inventories and temporary
  SQLite databases. They exercise authored drop chances and caps, required
  weapons, independent branches, recipes/Spoil, personal encounter ownership,
  encounter recovery, once-only rewards and the three-mark class transfer.
- Normal walkthrough clicks now open `NpcTalk`, follow the offered merchant,
  priest or gatekeeper Quest link, select a shared quest when necessary, then
  dispatch through `NpcTalkResponse`. Follow-up pages such as the First Orc's
  story are clicked without reopening and losing the conversation. Forged-event
  and concurrent-reward probes still deliberately call the service directly.
- The 34 profession/content test files passed, including every class route.
  Their dialogue logs cover all 23 trials and 92 distinct quest actions, with
  1,942 dispatched quest clicks. A dedicated content audit checks each trial's
  acceptance level, exact initial items, item-received packets, persistence and
  abort cleanup. Its Magus seed drops also pass through real
  `ReceivedHit → Die → NpcDied → QuestService` callbacks.
- Syntax validation passed for 1,830 JavaScript files. All 11 additional quest packet,
  registry, availability, persistence, hand-in, teleport, crafting and summon
  runtime regressions passed separately from the profession walkthroughs.

## Coverage

Every row passed acceptance, full progression, reward and persistence checks.
NPC IDs are native server IDs, not client object IDs.

| Quest | Start NPC | Level |
| --- | --- | --- |
| Q211 Trial of Challenger | Kash 7644 | 35 |
| Q212 Trial of Duty | Hannavalt 7109 | 35 |
| Q213 Trial of the Seeker | Dufner 7106 | 35 |
| Q214 Trial of the Scholar | Mirien 7461 | 35 |
| Q215 Trial of the Pilgrim | Santiago 7648 | 35 |
| Q216 Trial of the Guildsman | Valkon 7103 | 35 |
| Q217 Testimony of Trust | Hollint 7191 | 37 |
| Q218 Testimony of Life | Cardien 7460 | 37 |
| Q219 Testimony of Fate | Kaira 7476 | 37 |
| Q220 Testimony of Glory | Vokian 7514 | 37 |
| Q221 Testimony of Prosperity | Parman 7104 | 37 |
| Q222 Test of the Duelist | Kaien 7623 | 39 |
| Q223 Test of the Champion | Ascalon 7624 | 39 |
| Q224 Test of Sagittarius | Bernard 7702 | 39 |
| Q225 Test of the Searcher | Luther 7690 | 39 |
| Q226 Test of the Healer | Bandellos 7473 | 39 |
| Q227 Test of the Reformer | Pupina 7118 | 39 |
| Q228 Test of the Magus | Rukal 7629 | 39 |
| Q229 Test of Witchcraft | Orim 7630 | 39 |
| Q230 Test of the Summoner | Galatea 7634 | 39 |
| Q231 Test of the Maestro | Lockirin 7531 | 39 |
| Q232 Test of the Lord | Kakai 7565 | 39 |
| Q233 Test of the War Spirit | Somak 7510 | 39 |

## Gaps corrected

### C4 quest journal conditions

The persisted internal `cond` previously went straight into the C4 QuestList
packet. This exposed extra server phases that the source client journal does
not use. The existing `clientCondition` hook now translates those phases without
changing stored state or requiring a migration:

- Q213, Q214, Q218, Q219, Q221, Q224 and Q225 retain C4 condition 1 throughout
  their item-driven journeys.
- Q228 sends 1/2/3 while investigating, 5 after collecting all seeds, 6 after
  receiving the elemental score, and 7 after accepting an elemental branch.
  The seed and first-charm changes trigger a QuestList update even though the
  internal server condition does not change.
- Q229 maps the box/gem stages to 1/2, the first encounter to 4, its report to
  5, the independent tool collection to 6, the completed tools to 8, Evert's
  encounter to 9, and the final crystal/key return to 10. Condition 8 reflects
  the implemented combination of Orim's informational tool review with the
  instruction to visit Evert; no new mandatory hand-in was added.

Primary reference: the
[Lisvus C4 quest scripts](https://gitlab.com/TheDnR/l2j-lisvus/-/tree/fdc7e33af5d69067b41a6ee7cc7c07fe7aa35975/datapack/data/scripts/quests),
pinned at `fdc7e33af5d69067b41a6ee7cc7c07fe7aa35975`. Their constant `cond`
values and separate `step`/`phase` variables explain the required translation.
The other 14 trials already use compatible client conditions.

### Missing directions in dialogue

- Q228 now names the watersides near Fellmere Lake, the Ivory Tower waterfalls
  and the southern Giran area from Casian's source dialogue.
- Q229 now names Nameless Revenants in the Execution Grounds and Skeletal
  Mercenaries near the Wasteland. Roderik and Endrigo give the missing-buyer hint.

Required decisions, hand-ins and recovery links are available. Dialogue prose
remains condensed English: this is not an import of every original C4 story page.

## Validation boundary

These are server and packet checks, not a C4 client walkthrough. They do not
prove rendered journal text, clickable HTML layout, icons, movement/geodata or
visible combat effects in the client. World Observer confirmed an unchanged
running process (epoch `93826-musus2ws`, started 2026-10-03 20:37 UTC); it was not
restarted or used for live quest mutations during this audit. The new fixes are
local and require the normal server rollout before client verification.

For the client pass, use a clean eligible character and cover: accepting a quest
from a merchant/warehouse keeper and a priest, parallel quests at a shared NPC,
an ordinary drop and receipt, a required equipped trial weapon, a personal NPC
follow-up page, restart recovery, abort cleanup, and the final three-mark transfer.
