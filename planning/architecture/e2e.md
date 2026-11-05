# End-to-end scripts

Checked at d379becbd (2026-11-05).

Situations played on the real server by a scripted player (`src/Perf/PlayerScript.js`, `src/Perf/PlayerClient.js`):
the player acts only through client packets (`session.dataReceive`, the real request handlers) and a step checks
the server's packets back or the world's state. The scripts are a library of situations, one file per situation in
`tests/e2e/`. They are slow (a server boot, minutes) and are not part of `npm test`.

**Release rule.** A release runs the perf load run (`perf.js run --scenario=hot`, every release) plus every script
whose `areas` its diff touches (table below). A change in the harness itself (`src/Perf/PlayerClient.js`,
`src/Perf/PlayerScript.js`, `src/Perf/HotCrowd.js`, `scripts/perf/window.js`) runs every script.

## Run one

```
export L2NODE_GEODATA_DIR=/Users/iposukhoff/L2Solo/data/Geodata
node scripts/perf.js run --save=<id> --scenario=script --script=tests/e2e/<name>.js --warmup=2 --minutes=<n>
```

- `--minutes` is the script's deadline: the runner asks for the script when the window opens and closes the window
  when it is done or at `--minutes`, whichever comes first; the report then says "NOT FINISHED in the window".
- The result is in the run's report (`perf.js report <run folder>`, also printed at the end): `e2e <script>: N step(s),
  K failed`, one line per step, and for a failed step the server packets around it. The steps are also `e2e` lines in
  the run's timeline.
- A run never writes the save: `perf.js run` copies the save's world into its own folder
  (`tmp/perf/runs/<sha>-script-<name>-<time>/world.sqlite`, `SavedGames` `load`) and deletes that copy after the run
  (`--keep-world` keeps it to read the DB after the run). Every run starts from the same rows.
- One server at a time on this laptop, and nothing else running (CLAUDE.md, perf measurements).
- Scripts to run for a diff (prints the matching files; add the harness rule above by hand):

```
git diff --name-only <last release>..HEAD -- src/ | node -e "
const fs = require('fs'), changed = fs.readFileSync(0, 'utf8').split('\n').filter(Boolean).map(file => file.replace(/^src\//, ''));
for (const name of fs.readdirSync('tests/e2e').filter(n => n.endsWith('.js'))) {
    const { areas = [] } = require('./tests/e2e/' + name);
    if (areas.some(area => changed.some(file => file === area || file.startsWith(area.replace(/\/?$/, '/'))))) console.log('tests/e2e/' + name);
}"
```

## A script

```
module.exports = { name, players, areas, needs, place(), async run(ctx) }
```

- `name`: the file's name. `players`: 1..20 (HotCrowd logs that many in). `place()`: where they enter, from data
  only (a `TownRespawn` town), or null for HotCrowd's fullest crowd of cold hunters.
- `areas`: the `src/` paths the situation plays (files or folders). They are the source of the table below.
- `needs`: the data it names, `{ items, npcs, skills, towns }` (ids; town names as `TownRespawn` has them).
- `run(ctx)`: see the header of `PlayerScript`; `ctx.setup` grants what a level-1 character lacks through the
  game's own owner of that grant (the GM's give-adena), never by writing the DB.

`tests/test_e2e_scripts.js` (in `scripts/run-tests.js`, CI) requires every `tests/e2e/*.js` and checks the shape,
that every area exists under `src/`, and that every item, NPC, skill and town in `needs` exists in `data/`. A rename or
a data change breaks that unit test instead of a script that would fail months later as if the game were broken.

## Failures

Three kinds, so a broken script never reads as a broken game:

- **game**: a step's expectation did not hold (`within` or `player.packet` timed out on what the game should do, or a
  check threw). The packets around it are in the report.
- **precondition**: the place, NPC, item or bot the situation needs is not there (no gatekeeper within 1500, no
  crowd of cold hunters). Today it shows as a failed first step whose name says what it looks for ("a gatekeeper is
  near the player"); the static half (ids, towns, areas) is caught earlier by the unit test.
- **script timeout**: the window's `--minutes` ended before the script ("NOT FINISHED in the window").

Not there yet (open): a per-step timeout around every `step` and a script-wide deadline inside `PlayerScript.run`
that fail as "script timeout at <step>" (today a step without its own `within`/`packet` timeout waits until the
window closes), and a `ctx.precondition(what, fn)` (proposed) that fails as "precondition: <what>" in the report.
Until then each step bounds its own waits (`within(ms, ...)`, `packet(name, { timeoutMs })`).

## Limits

- Bot AI is random: an expectation is "within N s at least once" on a fixed save; a flaky one gets a longer timeout
  or a narrower expectation, not a retry loop.
- No game client: rendering and a client-side rejection of a packet are not seen.
- One script per `perf.js run`; a runner over a folder of scripts (`perf.js e2e`, proposed) and a fork CI job for
  the scripts (like the bot tables) are not there yet.

## Change -> scripts

From the scripts' `areas` (paths under `src/`):

| A change in | Run |
|---|---|
| `GameServer/Network/Request/MoveToLocation.js`, `Network/Request/Action.js`, `Actor/Generics/Select.js` | gatekeeper |
| `GameServer/World/Generics/NpcTalk.js`, `World/Generics/NpcTalkResponse.js` | gatekeeper |
| `GameServer/World/Generics/NpcBypasses/GatekeeperTeleport.js`, `World/C4GatekeeperTeleports.js` | gatekeeper |
| `GameServer/World/Generics/NpcBypasses/AdminGiveAdena.js` | gatekeeper |
| `GameServer/Actor/Generics/TeleportTo.js` | gatekeeper, cold-hot-cold |
| `GameServer/Bot/Population/PopulationService.js`, `HotActivation.js`, `Cooldown.js`, `ActivationPlacement.js` | cold-hot-cold |
| `GameServer/Bot/Population/BotLifeState.js`, `ColdSimulationCoordinator.js`, `PopulationConfig.js` | cold-hot-cold |
| `GameServer/World/CharacterVisibility.js` | cold-hot-cold |
| `Perf/PlayerClient.js`, `Perf/PlayerScript.js`, `Perf/HotCrowd.js` | all |

## Situations not written yet

Asked 2026-11-03 for this release's changes; researched, not written (e2e runs were put off). What each needs:

- **item-cast** (`Actor/Backpack.js` `useSkillItem`, `castItemSkill`; `Actor/Attack.js` `abortCast`;
  `Network/Request/DestCancel.js`; `Skills/C4SkillEffects.js` recall; `Session.js` `error`). Scroll of Escape (item
  736, skill 2013, 20 s, not a spell). Grant: the GM's Adena, then buy 736 from the Gludio grocer through its window
  (the admin shop has no scrolls); needs a client `purchase` (0x1f) (proposed) and `useItem` (0x14) (proposed).
  (a) disconnect mid-cast: the server keeps running and nobody is recalled; needs a client `disconnect` (proposed: what
  a socket close does, `session.error()`, and the ValidatePosition probe stops for that client) and a relog
  (proposed, in HotCrowd: a new Session for the same account). (b) Esc (`DestCancel` 0x37 with 0): scroll spent, no
  recall. (c) a hit during the cast does not break it: outside town, a mob or a second player hits.
- **death-respawn** (`Network/Request/RestartPoint.js`, `Actor/Generics/Revive.js`, `Formulas.js` `respawnHp`,
  `World/TownRespawn.js`): die (attack a much stronger mob at a crowd), RestartPoint (0x6d, 0) -> in town at 70 % HP.
- **login-shots** (`Network/Request/EnterWorld.js`, `Inventory/ShotStock.js`, `Network/Request/CreateNewChar.js`):
  use one shot (0x14), relog, the stack is not raised to 1000. Needs the relog (proposed).
- **closed-merchant** (`Actor/Generics/Select.js` `sendNotTrading`): the merchant bots are hot in towns (Gludio has
  five), but a hot one with `plan` 'merchant' and its store closed is rare: the only closing path,
  `BotMerchantStoreService.withdrawForParty`, also sets `plan` to 'hunting'. An open store with no items gives the same
  reply (buy one out). May have to stay manual.
- **pvp-flag** (`Actor/Attack.js`, `Actor/Generics/ReceivedHit.js`, `Actor/PvpFlag.js`, `PvpRules.js`, `Karma.js`): outside
  town (Gludio is a peace zone), hit a bot -> flagged; kill an unflagged one -> karma; record what the bot does back (a
  bot that strikes back is flagged and its kill is PvP, not karma). Setup: the GM's set-level and full buff
  (`AdminSetLevel`, `AdminFullBuff`).
- **restart-recovery** (`Database.js` `recoverStaleHotLifeStates`, `BotLifeState.js` `staleHotRowFromRecord`): not a
  PlayerScript (a script cannot restart its server). Procedure: a hot run with `--keep-world` (shutdown leaves hot
  rows hot), its world saved (`SavedGames` `create`), a short cold run on that save with `--keep-world`, then compare
  for the rows that were hot (merchants excepted): `bot_life_state` level, exp, adena equal `characters` and `items`,
  and the record's exp not below the first run's (unless the bot died). A small checker script (proposed) under
  `scripts/perf/`.

Planned with the harness (2026-11-03), not written:

- **party**: walk to a hunting bot, `invite`, expect the join and that it follows; dismiss (the client has no
  dismiss-party (0x2b) step yet), expect it back on its own plan, and cool when the player leaves.
- **hunt**: walk into a crowd, `attack` a mob, expect the kill and EXP; bots compete for mobs without failures. A
  client skill step (skill use, 0x2f) is not there yet.
- **chat**: `say` to a nearby bot (`Network/Request/Speak.js`), expect a reply within N s.
