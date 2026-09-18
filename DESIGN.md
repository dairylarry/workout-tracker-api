# Workout Tracker API — Design & Implementation Plan

## Update - [2026-08-23 23:40]

### Role of this document

This is the concrete backend implementation of the architecture already decided in `../workout-tracker-app/DESIGN.md` (the canonical system-design doc for the whole migration — read that first for the *why*: multi-user rebuild of `../workout-tracker`, AWS-native chosen over Supabase to honor CLAUDE.md's "AWS primary" rule, owner-only feature gating, stable `slotId`s, etc.). This doc covers the *how* for the backend specifically. Scope/architecture decisions that affect all three repos still belong in the app repo's `DESIGN.md`, not here — this file should only diverge into backend-specific detail (concrete endpoints, table schema, IaC layout).

**Hard requirement driving every choice below: this API must be equally usable by both clients** — the existing PWA (`../workout-tracker`, React/Vite, browser) and the new Expo/RN app (`../workout-tracker-app`, native). No endpoint, payload shape, or auth flow should assume one client over the other.

---

### Stack

| Layer | Technology |
|---|---|
| API | API Gateway (HTTP API) |
| Compute | Lambda (Node.js / TypeScript) |
| Auth | Cognito User Pools, two app clients (web + native) |
| Database | DynamoDB, single-table design |
| IaC | AWS CDK |
| Environments | Separate Cognito pool + DynamoDB table per stage (`dev`, `prod`) — dev data must never mix with prod |

---

### Auth

- **Clients talk to Cognito directly** for sign-up, login, logout, token refresh, and password reset (via the Cognito SDK — `amazon-cognito-identity-js` or Amplify Auth on web, the equivalent on RN). No custom proxy endpoints for these — Cognito's own APIs already work identically from a browser and from React Native, so building a passthrough would just be extra code with no benefit to either client.
- **Every data endpoint below requires `Authorization: Bearer <Cognito ID/access token>`**, verified by API Gateway's built-in JWT authorizer bound to the User Pool — no custom Lambda authorizer needed.
- **Post-confirmation Lambda trigger** (Cognito trigger, not an API endpoint) creates the `USER#<sub> / PROFILE` record on first successful signup — this is where `isOwner` gets set (`true` only for your account, matched by email at trigger time; `false` for everyone else).
- **Token storage is client-specific, not part of this API's contract**: RN app uses `expo-secure-store` (already mandated in the app repo's CLAUDE.md); PWA uses whatever the Cognito web SDK defaults to (document this explicitly in the PWA-migration phase — don't silently inherit an insecure default).
- Sign-in method for MVP: email + password only, per the app repo's DESIGN.md — no social login, so no Sign in with Apple obligation.

---

### Data Model — DynamoDB single table `workout-tracker-api-<stage>`

| Entity | PK | SK | Notes |
|---|---|---|---|
| User profile | `USER#<sub>` | `PROFILE` | `{ email, defaultWeightUnit, isOwner, createdAt }` |
| Default exercise (global, golden) | `EXERCISE_LIB_DEFAULT` | `EXERCISE#<slug>` | Seeded once from the PWA's current 82-exercise catalog. **Read-only at runtime — no API writes this.** |
| Custom exercise (per user) | `USER#<sub>` | `EXERCISE#<slug>` | Visible/deletable only by its owner; never merged into the default catalog |
| Exercise history (per user, per exercise) | `USER#<sub>` | `EXERCISE_HISTORY#<slug>` | Decoupled from the exercise definition itself — necessary because default exercises are shared/immutable but history is always per-user, whether the exercise is default or custom |
| Program config (a user's "workout") | `USER#<sub>` | `SESSION_TYPE#<id>` | `{ name, day (descriptive label only, not enforced), focus, exercises: [{ slotId, name, sets, repRange, rir, rest, subs, superset, perSide, optional }] }`. Authored via the Create Workout flow, not a hardcoded seed. |
| Session instance | `USER#<sub>#SESSION#<sessionTypeId>` | `DATE#<date>` | Exercises reference `slotId` (not array index) — the fix for the PWA's known reorder-corrupts-history bug. Same fields otherwise: `swappedName`, `supplemental`, `notes`, `deload`, `weightUnit`, `startedAt`, `sets[]`. |
| Bodyweight entry | `USER#<sub>` | `BODYWEIGHT#DATE#<date>` | `{ weight, weightUnit, timeOfDay }` |
| Tags | `USER#<sub>` | `TAGS` | Same shape as the PWA's `ManageTags` (color-coded tags, e.g. "Deload") |
| 5/3/1 config — **owner-only** | `USER#<sub>` | `531_CONFIG#EXERCISE#<exercise>` | Only ever populated/readable for the owner account; see Authorization below |
| Plan doc — **owner-only** | `USER#<sub>` | `PLAN_DOC` | Markdown content for "View Plan"; owner-only |

**GSI1** — `PK = USER#<sub>`, `SK = DATE#<date>` (sparse, projected only from Session Instance items): supports "all my sessions sorted by date regardless of type," replacing the old app-wide `date-index` GSI with a per-user equivalent.

---

### API Surface

All routes require a valid Cognito bearer token unless noted. All responses scoped to the caller's own `USER#<sub>` — no endpoint accepts a foreign user ID.

**Profile**
- `GET /me` — profile + preferences
- `PATCH /me` — update preferences (e.g. default weight unit)
- `DELETE /me` — delete account and all owned data

**Exercise Library**
- `GET /exercises` — effective library = default catalog ∪ caller's custom exercises (supports `muscleGroup`/`family` filters)
- `POST /exercises` — add a custom exercise (written to caller's own namespace only)
- `DELETE /exercises/:slug` — delete caller's own custom exercise. Attempting to delete a default exercise returns `403` — the catalog is golden, no API path mutates it.
- `GET /exercises/:slug/history` — caller's logged history for that exercise

**Workouts (Create Workout flow)**
- `GET /programs` — caller's session types (their workout split)
- `POST /programs` — create a session type/day; server assigns each exercise a stable `slotId`
- `PUT /programs/:id` — edit exercises/subs/slots for a session type
- `DELETE /programs/:id`

**Sessions**
- `GET /sessions?type=&limit=` — recent sessions of a given type
- `GET /sessions/calendar?month=` — date-indexed list for calendar view (via GSI1)
- `GET /sessions/:type/:date` / `PUT /sessions/:type/:date` — read/save a session instance (save also denormalizes into exercise history, same two-write pattern as the PWA)
- `DELETE /sessions/:type/:date`

**Bodyweight & Tags**
- `GET /bodyweight`, `POST /bodyweight`, `DELETE /bodyweight/:date`
- `GET /tags`, `PUT /tags`

**Owner-only** (any other caller gets `403`, checked against `isOwner` on the caller's profile — not a general roles system, scoped to exactly these two resources per the app repo's DESIGN.md)
- `GET /owner/531-config/:exercise`, `PUT /owner/531-config/:exercise`
- `GET /owner/plan`, `PUT /owner/plan`

*(Progression Guide and Interval Timer have no backend data — they're gated client-side only, in each client's own nav/routing, not represented here.)*

---

### Historical Data Migration

One-time script, lives in this repo (`scripts/migrate-legacy-data.ts`), run manually — not part of any pipeline:

1. Reads (read-only credentials, never write access) the existing `workout-tracker-db` table that `../workout-tracker` uses
2. Transforms: adds `USER#<owner-sub>` prefixing, assigns `slotId`s to historical session exercises based on their position in the current program config (the only mapping available), strips 5/3/1 fields that don't apply to non-owner data, keeps them for the owner's own historical 5/3/1 sessions
3. Writes into this table
4. `--dry-run` flag required before any real write; old table is only ever read, never modified

---

### Client Integration Notes

- **CORS** must be enabled on the API for the PWA's origins (production GitHub Pages domain + local dev origin). The RN app makes native HTTP requests and isn't subject to CORS.
- **Cognito app clients**: separate app client per platform (web, native) even though both hit the same API — lets token expiry/refresh behavior be tuned per platform later without touching the API itself.
- **No client-specific endpoints or payload branching.** If the PWA ever needs something the RN app doesn't (or vice versa), that's a signal to reconsider the endpoint design, not to add a `?platform=` flag.
- PWA migration (`../workout-tracker`) replaces `frontend/src/lib/dynamodb.js` with a new API client module hitting these endpoints — that work happens in the PWA repo, with explicit go-ahead, per the read-only note in this repo's CLAUDE.md.

---

### Deployment

Single CDK app defining, per stage (`dev` / `prod`):
- Cognito User Pool + two App Clients (web, native)
- API Gateway HTTP API with a JWT authorizer bound to the User Pool
- Lambda functions grouped by resource (`auth-triggers`, `exercises`, `programs`, `sessions`, `bodyweight-tags`, `owner`) rather than one per route or one monolith
- DynamoDB table + GSI1

---

### Non-goals for this backend (see app repo's DESIGN.md for full list)

- Admin panel / cross-user management endpoints
- Full offline sync queue — clients handle local caching; this API is simple request/response, no sync protocol
- Rate limiting beyond API Gateway defaults (revisit if abuse becomes real)

---

## Update - [2026-08-23 23:55]

### Migration audit resolutions

Auditing the legacy PWA table against the plan above surfaced several gaps between what the original migration section assumed and what the source data actually looks like. Resolutions below — supersedes the affected rows/steps in the sections above rather than editing them in place.

**Exercise identity.** `name` stays the immutable ID, `displayName` is the field clients render everywhere. Existing default-catalog exercises (the 82-exercise seed) keep their current human-readable slug as `name` — no rewrite of program configs, subs, session records, or history keys for those. Only exercises created going forward (via `POST /exercises`) get a generated `slug-timestamp` id as `name` (matches the scheme the PWA already adopted post-displayName-split), with `displayName` set from user input. Add `displayName` to both the default and custom exercise item shape.

**Default catalog seed source.** `EXERCISE_LIB_DEFAULT` is seeded from a snapshot of the *live* legacy table at migration time, not from `exerciseLibrarySeed.js`. The static seed file (82 entries) undercounts what's actually in the live table — runtime additions/renames exist there that the seed file doesn't have. The migration script reads the live table's `EXERCISE_LIB` items directly for this seed step.

**Exercise history storage — revised.** Not a single capped item per exercise (that was the legacy lossy cache, capped at 20, that this redesign was meant to fix). Instead: one item per history entry — `USER#<sub> / EXERCISE_HISTORY#<slug>#<date>#<sessionType>` — read via `begins_with` query, naturally paginated, no cap, no data loss ever. The migration script reconstructs this from the legacy table's Session Instances (the actual source of truth), not from the old denormalized `EXERCISE_LIB.history[]` array, which is already missing anything older than each exercise's most recent 20 logs.

**Program config — 5 session types, not 4.** The live `programConfigSeed.js` (source of truth, distinct from this repo's own docs above) has a 5th session type, "Upper C" (`upper-c`), with no historical sessions logged against it yet. Migrate it as a program config regardless. Nothing in the migration script or API should hardcode an assumption of exactly 4 session types.

**Slot IDs — copy, don't recompute.** The legacy table already has real `slotId`s: `migrate-slot-ids.mjs` previously ran against it and backfilled stable `slotId`s onto both session-type configs and historical session exercises (with a manual one-off correction for a slot that had drifted, in `migrate-upper-a.mjs`). The migration script for this repo copies each historical session exercise's existing `slotId` directly where present, instead of recomputing one from the exercise's position in the current program config — recomputing risks reintroducing the exact reorder-corruption bug this schema exists to fix.

**5/3/1 session fields — made explicit.** The Session Instance row's field list is extended, for the owner-only carve-out, to explicitly include `is531`, `week`, and `trainingMax` (the per-session training-max snapshot) alongside the fields already listed. These exist on real historical squat/bench session records and were previously only implied by the migration-script prose, not spelled out in the schema.

**Interval/Core Timer.** Routine *definitions* (e.g. "Ground Level") are not backend data — they're static authored content, only ever written by a one-off reseed script in the legacy app, never edited at runtime. They ship as a static asset in the client (RN app / PWA), the same way the Progression Guide markdown does — no `CORE_ROUTINE` item, no seeding, no endpoint in this API.

Routine *completions* are real per-user logged data (dates a routine was finished, used to show a "times completed" count) and do need a home:

| Entity | PK | SK | Notes |
|---|---|---|---|
| Core routine completion — **owner-only** | `USER#<sub>` | `CORE_ROUTINE_COMPLETION#<routineId>#<date>` | `{ routineId, date }`. Owner-only, same `isOwner` enforcement as 5/3/1 and Plan. |

New owner-only endpoints:
- `POST /owner/core-routines/:routineId/complete`
- `GET /owner/core-routines/completions`

(Routine IDs referenced here are the static client-side content's own ids — e.g. `ground-level` — not a DynamoDB-managed catalog.)

---

## Update - [2026-08-23 23:58]

### 5/3/1 data — grandfather everything, owner-only

Closes the open question from the audit above: all existing 5/3/1 data carries over into the new table under the owner-only carve-out, as-is.

- `531_CONFIG` items (training max + full `history[]`) migrate verbatim into `USER#<owner-sub> / 531_CONFIG#EXERCISE#<exercise>`, per the schema already defined in this doc. No local snapshot of current values exists (the CSV export never captured this PK) — the migration script queries it directly against the live table at run time.
- `is531` session records migrate as-is, including sessions where the tracked sets are sparse or entirely blank. The real export shows Squat sets blank in every logged session and Bench working sets inconsistently filled — consistent with the program config's own note that 5s PRO is "tracked manually." Don't skip these records on the theory that empty sets means nothing to migrate: the session shell (`date`, `deload`, `notes`, `week`, `trainingMax` snapshot) is real historical data even where the numbers themselves live outside the app.

---

## Update - [2026-08-24 00:05]

### Live-table pull — findings from a real (read-only) query against every known PK

Per "all data in the current table should migrate": ran a Query-based pull (not a full Scan — the legacy app's IAM user is Query/Get-only, matching `architecture.md`'s documented least-privilege policy) against every PK prefix `dynamodb.js` is known to write to. 230 items total, zero writes. This confirms most of the plan above and corrects a few specifics:

- **7 session types exist live, not 5 or 4.** `lower-a`, `lower-b`, `upper-a`, `upper-a-5`, `upper-b`, `upper-b-5`, `upper-c`. `remove-five-day-variants.mjs` apparently didn't stick in this environment — `upper-a-5`/`upper-b-5` program configs are still present (though zero session records were ever logged against either, confirmed separately by Query). Migrate all 7 program configs regardless of whether they're actively used — supersedes the earlier "5 session types" note.
- **Real 5/3/1 training-max history confirmed, and it's substantive.** `531_CONFIG` holds genuine progression: bench 195→230 lbs across 6 dates (2026-03-23 to 2026-07-28), squat 270→335 lbs across 7 dates. Validates grandfathering this in full.
- **`is531` session sets carry three previously-undocumented fields**: `isWarmup` (bool), `label` (e.g. `"1×5"`, `"Warmup 1×5"`), `target` (the computed suggested weight for that set). Neither this doc nor the PWA's own `data-model.md` mention these. Adding them to the Session Instance schema's owner-only carve-out so the migration script doesn't silently drop them.
- **The exercise library has diverged from the seed file by exactly one exercise**: "Iso-Lateral Low Row" (added 2026-07-17 per its `createdAt`, present live, absent from `exerciseLibrarySeed.js`'s 82). Concrete confirmation that seeding `EXERCISE_LIB_DEFAULT` from a live-table snapshot rather than the static seed file was the right call — this is exactly the exercise that approach exists to catch.
- **`displayName` is universally populated** (backfill completed, 100% coverage) but none currently differ from `name` — no live rename to preserve today. Keeping the field in the schema regardless, per the earlier decision, for whenever a rename does happen.
- **`CORE_ROUTINE` matches its seed file exactly** (14/14, no drift) — unlike the exercise library. Consistent with treating it as static client content going forward, per the earlier resolution; still migrated into the new table as an owner-only archival copy per "all data migrates."
- **17 real `CORE_ROUTINE_COMPLETION` records exist** — confirms this wasn't hypothetical, validates the owner-only carve-out added earlier.

One data-quality anomaly noted, not corrected — migration preserves source data as-is, doesn't guess at fixes: one `Iso-Lateral Low Row` history entry has `weight: "2250"` on a single set, almost certainly a fat-fingered `"225"`. Worth a manual fix in the new app later if you want it; not something the migration script should silently "correct."

**Resolved:**
- `upper-a-5` / `upper-b-5` program configs are excluded from migration — dead leftovers from the removal script not sticking, zero session records ever logged against either, not worth carrying forward. The other 5 (`lower-a`, `lower-b`, `upper-a`, `upper-b`, `upper-c`) migrate.
- "Iso-Lateral Low Row" is included via the live-snapshot seeding approach already planned above — no separate special-case needed, the migration script's `EXERCISE_LIB_DEFAULT` seed step reads the live table directly, which already includes it.
- The `weight: "2250"` typo is corrected to `"225"` during migration — the one explicit exception to "preserve source as-is."

### Four more fields found by inspecting raw session records directly (not just the CSV exports)

- **Session Instance gets a `tags` field**: `tags: string[]` (tag ids, e.g. `["crunch"]`) — sessions reference tag definitions directly, for the badges shown on session cards. Undocumented anywhere until now; added to the schema.
- **Program Config `subs` entries are heterogeneous, not `string[]`.** Real example: `Leg Press`'s subs mixes plain exercise names with per-sub override objects — `[{ name: 'Bulgarian Split Squat', sets: 2, repRange: [8,8], rir: 2, perSide: true }, 'Goblet Squat', 'Seated Leg Press Machine']`. Each `subs` entry is `string | { name, sets?, repRange?, rir?, perSide? }`. The Programs API and its data-access layer need to handle both shapes, not assume a plain string array.
- **`displayName` is redundantly denormalized onto session exercise entries in the live data.** Not carried into the new schema as a stored field — `displayName` is resolved via a join against the exercise library at read time instead. Storing it twice reintroduces the staleness problem `displayName` exists to solve, the moment a rename happens.
- **One legacy tag has `deleted: false`, the other two have no `deleted` field at all** (soft-delete added after those tags were created, never backfilled). New Tags schema treats `deleted` as optional, default-false; migration carries over whatever's present rather than backfilling it.

Checked and ruled out as a concern: exercise-history `note` text (the per-set free-text note, distinct from session-level `notes`) exists on the Session Instance record itself, not only on the denormalized `EXERCISE_LIB.history[]` cache — so reconstructing history from Session Instances (per the "rebuild from source of truth" resolution above) does not lose these notes.

---

## Update - [2026-08-24 00:20]

### Second audit pass — integrity, key-uniqueness and type checks against all 230 items

A deeper verification pass (referential integrity, key collisions, type consistency, full attribute inventory) rather than spot checks. Referential integrity came back **clean**: zero orphan exercise references across all 82 sessions and all 7 program configs, zero orphan tag references, zero session exercises missing `slotId`, no malformed dates, no SK/date mismatches. Sessions span 2026-03-23 to 2026-08-21. The findings below are the exceptions.

**1. `EXERCISE_HISTORY` sort key is not collision-safe — schema fix required.** The key proposed earlier (`EXERCISE_HISTORY#<slug>#<date>#<sessionType>`) drops the slot discriminator the legacy design deliberately included: `data-model.md` keys history on `date + sessionType + slotIndex` explicitly to "handle duplicate exercises in same session." No duplicates exist in the data *today* (verified), but the program schema permits them and the Create Workout flow makes them more likely, not less. Revised key:

`USER#<sub> / EXERCISE_HISTORY#<slug>#<date>#<sessionType>#<slotId>`

with the literal `SUPP` substituted for `<slotId>` on supplemental exercises (which legitimately have no slot). Without this, a repeated exercise in one session silently overwrites its own history entry — the same class of silent-data-loss bug this redesign exists to eliminate.

**2. Two stub session records that will crash a naive migration.** `SESSION#lower-a / DATE#2026-06-06` and `SESSION#lower-b / DATE#2026-07-19` contain only `{PK, SK, notes: ""}` — no `date`, no `exercises`, no `sessionType`, no `type` attribute. Presumably sessions opened and abandoned before anything was logged. They carry zero user data (`notes` is the empty string). Two consequences: the migration script must tolerate missing `date`/`exercises`/`sessionType` rather than assuming they exist (an analysis script written against the documented shape crashed on exactly these two records), and because they lack the `type` attribute they would also be invisible to any sparse GSI. **Recommendation: skip both during migration** — they are empty artifacts, not data. Flagging rather than silently dropping, since the standing instruction is that everything migrates.

**3. All set values are strings, not numbers.** Every one of the 1,826 logged sets stores `weight`, `reps`, and `rir` as strings (`"245"`, `"12"`, `"2"`), with the empty string — not null, not absent — as the blank marker (417 blank weights, 338 blank reps, 356 blank rir). Bodyweight entries, by contrast, store real numbers (`179.4`). A strict-mode TypeScript API typing these as `number` will reject or mangle the migrated data. Decision needed, and it has a **direct PWA-compatibility consequence**: the PWA reads and writes these as strings today, so normalizing to `number | null` at migration means the PWA's phase-2 API client must coerce at the boundary. See open question below.

**4. `fiveDay` — another undocumented session field.** A boolean on 3 sessions (`true` on two, `false` on one). This is the live 5-day-split volume toggle that `remove-five-day-variants.mjs` describes as replacing the deleted `upper-a-5`/`upper-b-5` session types ("handled by a toggle in the session UI instead"). Add `fiveDay?: boolean` to the Session Instance schema — and note this confirms dropping those two program configs is correct, since the toggle superseded them.

**5. `deload` boolean and a `deload` *tag* are overlapping mechanisms.** 5 sessions have `deload: true`; 2 sessions carry the `"deload"` tag; the sets do not coincide. Both migrate as-is, but the new app needs a decision on whether these unify — otherwise "is this a deload week?" has two disagreeing answers.

**6. `kg` is genuinely in use** — 50 sets (Weighted Pull-Up) against 500 in `lbs`. Per-exercise weight unit must be preserved per-exercise, never normalized to a single account-level unit.

**7. `CORE_ROUTINE` items carry `progressions` and `notes`** fields absent from this doc's description — richer than the seed file implies. The archival owner-only copy must preserve them.

### Resolutions

**Numeric normalization — set values become `number | null`.** The migration coerces `"245"` → `245` and `""` → `null` for `weight`/`reps`/`rir` across all 1,826 sets. The new API types them as `number | null` in strict mode; no strings-as-numbers in the schema. **PWA-compatibility consequence, to handle in phase 2:** the PWA's inputs produce strings, so its new API client needs a coercion step at the boundary (parse on read, serialize on write) — a small contained adapter in `lib/`, not a change to its components.

**The two stub sessions are skipped**, logged explicitly by the migration script as skipped-with-reason so the decision is auditable rather than invisible. Separately, the script must still tolerate missing `date`/`exercises`/`sessionType` defensively rather than assuming the documented shape.

**Deload unifies onto the tag — and this needs almost no rewiring, contrary to the earlier note.** Reading the PWA source: it has *already* migrated to the tag. `constants/tags.js` labels the boolean "Legacy: pre-tag sessions stored deload as a boolean field" and normalizes it into the tags array at read time; `ActiveSession.jsx` writes `deload: true` only as a back-compat shim *derived from* the tag ("keep writing deload field so pre-tag clients can still read history"). The tag is already the source of truth; the boolean is a write-only compatibility artifact.

Crucially, the 5/3/1 deload percentages do **not** read this boolean — they are driven by a separate per-exercise `week` selector where `'deload'` is one of the options (`getDeloadSets()` in `lib/fiveThreeOne.js`). Different field, different scope, unaffected.

The live data confirms a clean chronological cutover with zero overlap: 5 sessions from Mar–May 2026 carry `deload: true` and no tags at all (pre-tag era); 2 sessions from Jul 2026 carry the `"deload"` tag and no boolean (post-tag era).

So the migration applies the same normalization `getSessionTags()` already performs — where `deload === true`, prepend `"deload"` to `tags` — then drops the boolean from the new schema entirely. The identical rule applies to exercise-history entries, which carry the same legacy field. Nothing else changes.

**Related schema note:** the per-exercise 5/3/1 `week` field is an enum of `1 | 2 | 3 | 'deload'` (the code supports the string variant even though only `1`/`2`/`3` appear in live data — 15/14/13 occurrences). Type it as the full union so the deload week isn't rejected if it's ever used.

---

## Update - [2026-08-24 00:35]

### Active Session exercise reordering — no schema change required

Requirement: Program Config's exercise order stays fixed/authoritative (only editable via `PUT /programs/:id`); Active Session should allow freely reordering exercises — including supplemental/add-on exercises intermixed with program exercises — for that session only.

This falls out of the schema already documented above, with no changes needed:
- Program Config and Session Instance are separate items; saving a session (`PUT /sessions/:type/:date`) never writes to the Program Config item, so "fixed in Manage Program" is structural, not a rule that needs enforcing elsewhere.
- Session Instance `exercises[]` is an ordered array where each entry is independently tagged (`slotId` for program exercises, `supplemental: true` and no `slotId` for add-ons) — nothing requires supplementals to sort after program exercises or requires program-exercise entries to stay in program order. Free intermixing and reordering of both was already possible in the array shape.
- History correctness is unaffected by reordering in either direction: exercise history keys off `slotId` (`SUPP` for supplementals), never array position — this is the same fix already in place for the legacy reorder-corrupts-history bug.

Checked against the PWA source before assuming: it currently has **no** reorder capability at all (no drag/sortable logic anywhere in the codebase), and a new session always initializes its exercise list fresh from the program config's order every time (`ActiveSession.jsx`, `emptyExerciseData(config, ...)`) — there's no existing "remember last order" behavior.

**Resolved:** new sessions always reset to the program's canonical order, matching that existing PWA behavior exactly — a reorder done in one session does not carry forward to the next. No session-initialization logic beyond what's already planned.

**Client-side note, not a backend concern:** superset pairing (`superset: 'A'`/`'B'`) currently assumes the two paired exercises render adjacently. Once exercises can be freely reordered, the client should group by superset label at render time rather than assume array adjacency.

---

## Update - [2026-08-24 00:50]

### Future-proofing pass — schema landmines and feature-flag design

Forward-looking audit against the deferred/roadmap features (progress charts, rest timer, offline sync with conflict resolution, premium tier, admin tooling). Everything below was verified against the live data pull, not assumed. Ordered by cost-of-deferral.

**1. Give GSI1 generic key names — highest priority, irreversible otherwise.** A GSI's key schema cannot be altered after creation. Defining GSI1 semantically (`PK = USER#<sub>`, `SK = DATE#<date>`, sparse, session items only) locks the index to one access pattern forever. Any future unified-timeline view (workouts + bodyweight + core-routine completions on one date axis) or any other item type needing date queries would require a second GSI and dual-writes. **Define GSI1 over opaque `GSI1PK` / `GSI1SK` attributes instead**, and have each item type populate them as needed — session items initially, others later with no index change. Zero cost today.

**2. Snapshot programming targets onto session exercises — retroactively unrecoverable.** Verified: program-config exercises carry `sets`, `repRange`, `rir`, `rest`; session exercises carry only performed data (`sets[]`, `weightUnit`, `slotId`, `note`, plus 5/3/1 fields). Historical sessions therefore render their targets from the *current* program config. Editing a program silently rewrites what every past session appears to have been targeting — and any "actual vs. target" progression chart would be quietly wrong. **Snapshot `sets` / `repRange` / `rir` / `rest` onto each session exercise at session-creation time.** Write-once, negligible cost, and impossible to reconstruct for anything logged before this is added.

**3. Add `updatedAt` and `version` to every item.** Offline sync with conflict resolution is deferred-but-likely; it needs a timestamp at minimum and a version for optimistic locking. Free now, awkward to retrofit across items in unknown state. Consider `schemaVersion` on items too, so future migrations are targetable rather than requiring inference.

**4. Normalize `rest` into a parseable numeric.** Live values are display strings — `'60 sec'` (27), `'90 sec'` (17), `'3–4 min'` (3, note the en-dash), `'2 min'` (2). The rest timer on the V2 roadmap cannot consume these without parsing. Add `restSeconds: number | [number, number]` alongside the display string, normalized during migration while there are only 49 values total.

**5. Two key-granularity constraints — decide deliberately rather than discover later.**
- Bodyweight (`BODYWEIGHT#DATE#<date>`) permits one entry per day, but carries a `timeOfDay` field whose values are all in active use (night 13, morning 10, afternoon 1). The field implies multiple weigh-ins per day; the key forbids them. No collision has occurred (24 entries across 24 distinct dates), so this is still a free choice.
- Sessions are one per `(sessionType, date)`. Two sessions of the same type in one day are unrepresentable; the 4am rollover mitigates but does not remove this. Also note the session PK embeds `sessionTypeId`, so account deletion must enumerate session-type partitions rather than deleting one prefix.

**6. Extend the existing soft-delete convention.** Tags already use `deleted: true`. Programs and custom exercises hard-delete, which orphans historical sessions' slot metadata and any history referencing a removed custom exercise. Reuse the established convention rather than introducing a second pattern later.

### Feature flags — design

**Avoid a boolean-per-feature on the profile** (`isOwner`, then `isBeta`, then `hasPremium`…). Each new flag would otherwise mean a schema change plus a client change.

Instead:

| Item | Key | Contents |
|---|---|---|
| Global flag defaults | `CONFIG` / `FEATURE_FLAGS` | `{ [flagName]: boolean }` — defaults for all users, flippable without a redeploy |
| Per-user overrides | `USER#<sub>` / `PROFILE` | `featureOverrides: { [flagName]: boolean }` |

Effective flags = global defaults merged with the user's overrides, **computed server-side and returned by `GET /me`** so clients never derive gating logic themselves. Adding a flag then requires no schema change and no deploy.

`isOwner` remains as it is — it is *identity*, not a feature flag. Owner-only features are expressed as flags defaulting to `false` globally and overridden `true` for the owner account, which keeps the existing narrow carve-out intact while making it uniform with everything else.

Use cases this covers: owner-only gating (today's four features), beta/early access, server-side kill switches for a broken feature, gradual rollout, and a paid tier should App Store monetization ever happen.

**Constraint — flags gate capabilities, never API shape.** A `platform`-style flag that branches payloads or endpoints by client would directly violate the client-agnostic mandate in CLAUDE.md and this doc's hard requirement. Gating whether a client *renders* a native-only feature is fine; branching an endpoint's response on client type is not.

---

## Update - [2026-08-24 01:00]

### Resolutions on the future-proofing pass

**Adopted:** generic `GSI1PK`/`GSI1SK` index keys (item 1); `updatedAt` + `version` on every item (item 3); normalized numeric rest (item 4); soft-delete extended to programs and custom exercises (item 6); the feature-flag design below.

**Rejected — snapshotting programming targets onto sessions (item 2).** Targets are program-level guidance, not per-session goals; copying them into all 82+ session records to guard against an infrequent event isn't a good trade. Accepted consequence: restructuring a slot into a different scheme (e.g. 3×10–12 RIR 2 → 4×6–8 RIR 1) retroactively changes the targets shown against past sessions in that slot. If that ever becomes a real problem, the clean fix is **program versioning** — sessions reference a program version id — not per-session denormalization. Note the 5/3/1 `trainingMax` snapshot on session exercises **stays**: that value moves every few weeks by design, which is precisely the case where snapshotting earns its cost.

**Rest normalization (item 4):** store `restSeconds` numeric alongside the display string. Live values are `'60 sec'`, `'90 sec'`, `'2 min'`, `'3–4 min'` — the range form maps to a tuple, so `restSeconds: number | [number, number]`. Normalized during migration (49 values total).

**Bodyweight key — revised (item 5).** SK becomes `BODYWEIGHT#DATE#<date>#<timeOfDay>`, superseding the `BODYWEIGHT#DATE#<date>` form defined earlier in this doc. This lets morning and night entries coexist on one date (matching the intent of the already-populated `timeOfDay` field) while a repeat entry for the same date *and* slot simply overwrites — acceptable since bodyweight doesn't move meaningfully within a slot. All 24 legacy entries carry `timeOfDay` and map cleanly. **Wrinkle:** `afternoon` < `morning` < `night` sorts alphabetically, not chronologically, so within-day ordering needs either a numeric slot ordinal in the key or a client-side sort.

**Session key stays one-per-`(sessionType, date)` (item 5)** — by design. Two realistic collision paths exist, both causing *silent* data loss under a plain `PutItem`:
- **Timezone travel** — logging a session, crossing a date line, and logging another of the same type on what the client still resolves as the same local date.
- **Manual backfill** — entering a missed session on a date that already has one of that type.

The fix is not a key change but a **conditional write**: session *creation* uses `attribute_not_exists(PK)` so an accidental overwrite fails loudly and the client can offer "a session already exists for this date — open it?" instead of silently discarding data. Updates to an existing session are unaffected. (Two-a-days of the *same* type remain unrepresentable and are accepted as out of scope; different types on one day already work.)

### Feature flags — risks and precedence rules

Design adopted as proposed (global `CONFIG` / `FEATURE_FLAGS` defaults + `featureOverrides` map on the profile), with these rules attached:

**1. Flags are UX gating, never authorization.** Returned flags tell a client what to *render*; they protect nothing, since any client can ignore them and call an endpoint directly. **Owner-only endpoints keep their independent server-side `isOwner` check** — a flag lookup must never replace it. This also neutralizes the misconfiguration risk: a bad global default could reveal a nav entry, but never data.

**2. Precedence is code defaults → global DB overrides → per-user overrides.** Defaults live in code so a missing, empty, or deleted `CONFIG/FEATURE_FLAGS` item is harmless rather than silently turning every feature off (or on).

**3. Cache the global item in Lambda module scope with a short TTL (~60s).** Every `GET /me` would otherwise read one global item on every request — irrelevant at current scale, but a hot key later. Accepted trade-off: a kill switch takes up to the TTL to propagate.

**4. Constrain flag names with a TypeScript union type**, not a bare string-keyed map, and treat flags as temporary by default — string maps lose type safety and unmanaged flags accumulate indefinitely.

---

## Update - [2026-08-24 01:15]

### Program versioning — adopted (supersedes the item-2 rejection above)

Reverses the earlier decision to accept stale historical targets. Rather than snapshotting programming targets onto every session, programs themselves are versioned and sessions reference a version. This gives correct historical rendering with no per-session duplication.

Design constraint driving the shape: "get all my session types" is the hottest read (Home screen) and must not degrade as versions accumulate. So a mutable pointer plus immutable snapshots, in **separate SK namespaces**:

| Entity | PK | SK | Notes |
|---|---|---|---|
| Current program | `USER#<sub>` | `SESSION_TYPE#<id>` | Mutable, always the live version. Carries `version: N`. |
| Archived program version | `USER#<sub>` | `PROGRAM_VERSION#<id>#<version>` | Immutable snapshot of a prior version. Zero-padded version (`00001`) for lexical sort. |

- The hot read is unchanged: `begins_with(SK, 'SESSION_TYPE#')` returns only current programs regardless of how many versions exist.
- The distinct `PROGRAM_VERSION#` prefix is deliberate — a `SESSION_TYPE#<id>#V#<n>` scheme would work only because `SESSION_TYPE_VERSION#` happens not to match `begins_with('SESSION_TYPE#')`, which is too subtle to rely on.
- `PUT /programs/:id` archives the current item as a `PROGRAM_VERSION#` snapshot, then writes the update with `version` incremented.
- Session Instance gains `programVersion: number`, stamped at session-creation time.
- Historical rendering: a session recording `programVersion: 3` reads `PROGRAM_VERSION#<id>#00003` for the targets actually in effect when it was run. `slotId`s remain stable across versions, so exercise-history lookup is unaffected.

**Migration:** every program gets `version: 1` plus a matching `PROGRAM_VERSION#<id>#00001` snapshot, and all migrated sessions are stamped `programVersion: 1` — so every session references a version that actually exists.

*(Growth is unbounded in principle — one small item per edit. Pruning versions no session references is possible later if it ever matters; not needed now.)*

**Atomicity of the two-write edit.** `PUT /programs/:id` performs two writes (archive the outgoing version, update the current item). Two independent failure modes, with distinct fixes:

*Partial failure.* Write order alone determines whether this is recoverable:
- *Update first, then archive* — current becomes v4 but v3 was never archived, so any session recording `programVersion: 3` references an item that does not exist. Permanent data gap.
- *Archive first, then update* — v3 is archived and current remains v3. A retry re-archives identical content (idempotent) and proceeds; abandoning the retry leaves only a redundant archive of the current version. Benign.

Archive-first is therefore the correctness-critical ordering, independent of any transaction.

*Concurrent edits.* Ordering does not address two clients editing simultaneously — both archive v3, both write v4, one edit is silently lost. Fixed with a conditional write on the `version` attribute (`ConditionExpression: 'version = :expectedVersion'`), so the second writer fails loudly. This is the optimistic-locking use of the `version` field adopted earlier, not merely a counter.

**Implementation:** use `TransactWriteItems` containing both puts (archive + conditional update) as one atomic operation. At two items the doubled write cost is negligible at this scale, and it removes the need to reason about ordering or retry semantics — the edit either fully applied or did not, with no redundant archive items. The non-transactional equivalent (archive-first plus a conditional put) is also correct if transactional writes are ever undesirable; it just carries more invariants.

### Feature flags — recommended rollout: contract now, machinery later

Flags are the one item in this pass that should **not** be fully built now. The design is purely additive: adding `featureOverrides` to a profile later is a no-op (absent = empty map), and introducing the `CONFIG` / `FEATURE_FLAGS` item requires no migration. Building the storage layer before there's anything to flip only invites flag sprawl.

What *is* expensive to retrofit is the **client contract** — if clients gate on `isOwner` directly, every client must change when flags arrive. So establish the boundary immediately:

1. **Day one:** `GET /me` returns `features: { fiveThreeOne, planDoc, intervalTimer, progressionGuide }`, computed server-side from code defaults + `isOwner`. No DB items, no override map.
2. **Clients gate on `me.features.X`**, never on `isOwner` directly.
3. **When per-user or no-deploy flipping is actually needed:** add the `CONFIG` / `FEATURE_FLAGS` item and the `featureOverrides` profile map, applying the precedence and caching rules above. Pure addition — no client change, no migration.

The four day-one flags map exactly to the existing owner-only carve-out: all default `false`, all `true` when `isOwner`. Per rule 1 in the risks section, owner-only *endpoints* keep their independent server-side `isOwner` check regardless — these flags gate UI only.

---

## Update - [2026-08-24 01:40]

# CONSOLIDATED REFERENCE — current state

**This section supersedes every section above it.** The sections above are retained as decision history (the *why*); this one is the *what*, and is the single source of truth for implementation. Where they disagree, this section wins.

Verified against a read-only pull of the live legacy table (235 items) on 2026-08-24.

---

## 1. Conventions

**Identity.** The Cognito `sub` claim is the user id everywhere. Never key on email — email is mutable.

**Item envelope.** Every item carries:

| Attribute | Type | Notes |
|---|---|---|
| `PK`, `SK` | string | Per the entity table below |
| `entityType` | string | e.g. `SESSION`, `PROFILE` — for filtering and debugging |
| `createdAt`, `updatedAt` | string | ISO-8601 UTC |
| `version` | number | Starts at 1, incremented on every write; used for optimistic locking |
| `schemaVersion` | number | Starts at 1; makes future migrations targetable |
| `deleted` | boolean? | Soft-delete marker. Absent = live. Applies to programs, custom exercises, tags |

**Numeric values.** `weight`, `reps`, `rir` are `number | null` — never strings, never `""`. The migration coerces legacy strings (`"245"` → `245`, `""` → `null`). Bodyweight is a number.

**Dates.** `YYYY-MM-DD`, always **client-supplied** — the server cannot determine the user's local date, and the 4am rollover rule is client-side. The server validates format only. `startedAt` is a client-supplied ISO-8601 UTC timestamp.

**DynamoDB reserved words.** These attribute names are reserved and *will* fail in expressions if used literally: `date`, `name`, `notes`, `target`, `type`, `weight`. Rather than auditing case by case, **always use `ExpressionAttributeNames`** for every attribute reference in every expression.

**Slot identity.** Every session exercise has a `slotId`, including supplementals — supplementals get a generated id (`supp-<ulid>`) rather than a `SUPP` sentinel. This keeps the exercise-history key uniform and collision-free when a session contains two ad-hoc entries of the same exercise. *(Revises the `SUPP` sentinel proposed earlier; live data currently has at most one supplemental per session, so nothing has collided yet — but the sentinel is unsafe by construction.)*

---

## 2. Entity reference

Table: `workout-tracker-api-<stage>`. Single table, `PK` + `SK`.

| Entity | PK | SK | Payload |
|---|---|---|---|
| User profile | `USER#<sub>` | `PROFILE` | `email`, `defaultWeightUnit`, `isOwner`, `featureOverrides?` |
| Default exercise (golden) | `EXERCISE_LIB_DEFAULT` | `EXERCISE#<slug>` | `name` (immutable id), `displayName`, `muscleGroups[]`, `family`, `defaultRepRange`, `defaultSets`, `unilateral`. **Read-only at runtime — no API writes this.** |
| Custom exercise | `USER#<sub>` | `EXERCISE#<slug>` | Same shape. `name` = `<slug>-<timestamp>` for new ones. Soft-deletable. |
| Exercise history entry | `USER#<sub>` | `EXERCISE_HISTORY#<slug>#<date>#<sessionType>#<slotId>` | `sets[]`, `weightUnit`, `note?`. **One item per entry — unbounded, no cap.** |
| Program (current) | `USER#<sub>` | `SESSION_TYPE#<id>` | `name`, `day` (descriptive label, not enforced), `focus`, `version`, `exercises[]`. Mutable. Soft-deletable. |
| Program (archived version) | `USER#<sub>` | `PROGRAM_VERSION#<id>#<nnnnn>` | Immutable snapshot. Zero-padded version for lexical sort. |
| Session instance | `USER#<sub>#SESSION#<sessionTypeId>` | `DATE#<date>` | See below |
| Bodyweight entry | `USER#<sub>` | `BODYWEIGHT#DATE#<date>#<n>#<timeOfDay>` | `weight`, `weightUnit`, `timeOfDay`. `<n>` is a chronological ordinal (`1`=morning, `2`=afternoon, `3`=night) so within-day sort is correct — alphabetical would order afternoon/morning/night wrongly. |
| Tags | `USER#<sub>` | `TAGS` | `tags[]` of `{ id, name, color: { bg, text }, deleted? }` |
| 5/3/1 config — owner-only | `USER#<sub>` | `531_CONFIG#EXERCISE#<exercise>` | `trainingMax`, `history[]` of `{ date, tm }` |
| Plan doc — owner-only | `USER#<sub>` | `PLAN_DOC` | Markdown content |
| Core routine completion — owner-only | `USER#<sub>` | `CORE_ROUTINE_COMPLETION#<routineId>#<date>` | `routineId`, `date` |
| Core routine archive — owner-only | `USER#<sub>` | `CORE_ROUTINE_ARCHIVE#<routineId>` | Migration-only archival copy of legacy routine definitions. Not read at runtime — clients ship routine content statically. |

**Program `exercises[]` entry:**
`slotId`, `name`, `sets`, `repRange: [number, number] | null`, `rir`, `rest` (display string), `restSeconds: number | [number, number]`, `subs[]`, `superset?`, `perSide?`, `optional?`, `is531?`, `note?`

`subs[]` entries are **heterogeneous**: `string | { name, sets?, repRange?, rir?, perSide? }` — a sub may carry its own programming overrides. Both shapes occur in live data.

**Session instance payload:**
`sessionType`, `date`, `startedAt`, `programVersion`, `tags[]`, `notes?`, `fiveDay?`, `exercises[]`

**Session `exercises[]` entry:**
`slotId`, `name`, `swappedName?`, `supplemental?`, `weightUnit` (`lbs` | `kg`, per-exercise — never normalized), `note?`, `sets[]`
Owner-only 5/3/1 additions: `is531`, `week: 1 | 2 | 3 | 'deload'`, `trainingMax` (snapshot — retained deliberately; TM moves every few weeks)

**Session `sets[]` entry:** `setNumber`, `weight`, `reps`, `rir`
5/3/1 sets additionally: `isWarmup`, `label` (e.g. `"1×5"`), `target`

`displayName` is **not** stored on session exercises — resolved by joining the exercise library at read time, so a rename never leaves stale copies.

There is **no `deload` boolean.** Deload is a tag (`tags: ["deload"]`). Migration converts the legacy boolean.

---

## 3. Indexes

**GSI1** — `GSI1PK` (partition) / `GSI1SK` (sort), both opaque strings. Deliberately *not* semantically named: a GSI's key schema can never be altered after creation, so generic names let any entity opt in later without a new index.

Initial population — session items only:
- `GSI1PK = USER#<sub>`
- `GSI1SK = DATE#<date>`

Serves "all my sessions by date regardless of type" (calendar view). Sparse: items that don't set these attributes don't appear.

---

## 4. API surface

All routes require `Authorization: Bearer <Cognito ID token>` unless noted. All responses scoped to the caller's own `sub`; no endpoint accepts a foreign user id.

**Profile**
- `GET /me` — profile, preferences, and computed `features` map
- `PATCH /me` — update preferences
- `DELETE /me` — delete account and all owned data

**Exercises**
- `GET /exercises` — effective library = default catalog ∪ caller's custom (filters: `muscleGroup`, `family`)
- `POST /exercises` — add custom exercise
- `DELETE /exercises/:slug` — soft-delete own custom exercise; `403` for default catalog entries
- `GET /exercises/:slug/history` — paginated, newest first

**Programs**
- `GET /programs` — current programs (`begins_with(SK, 'SESSION_TYPE#')`, excludes archived versions and soft-deleted)
- `POST /programs` — create; server assigns `slotId`s
- `PUT /programs/:id` — edit; archives prior version, bumps `version` (see §5.2)
- `DELETE /programs/:id` — soft-delete
- `GET /programs/:id/versions/:version` — read an archived version

**Sessions**
- `GET /sessions?type=&limit=&cursor=`
- `GET /sessions/calendar?month=` — via GSI1
- `GET /sessions/:type/:date`
- `POST /sessions/:type/:date` — create; conditional write, `409` if one already exists (see §5.1)
- `PUT /sessions/:type/:date` — update existing; optimistic-locked on `version`
- `DELETE /sessions/:type/:date` — also removes derived history entries

**Bodyweight & tags**
- `GET /bodyweight`, `POST /bodyweight`, `DELETE /bodyweight/:date/:timeOfDay`
- `GET /tags`, `PUT /tags`

**Owner-only** — `403` for any other caller, enforced server-side against `isOwner` on the caller's profile
- `GET|PUT /owner/531-config/:exercise`
- `GET|PUT /owner/plan`
- `POST /owner/core-routines/:routineId/complete`
- `GET /owner/core-routines/completions`

**Conventions:** cursor-based pagination (opaque cursor wrapping `LastEvaluatedKey`); consistent error envelope `{ error: { code, message } }`; all write payloads schema-validated (e.g. zod) before touching DynamoDB — the legacy system had no validation layer and that is listed as a known defect in its own architecture doc.

---

## 5. Critical algorithms

### 5.1 Saving a session (the two-write pattern, corrected for item-per-entry history)

Exercise history is derived data: each session exercise produces exactly one history item, keyed `EXERCISE_HISTORY#<slug>#<date>#<sessionType>#<slotId>` where `<slug>` is `swappedName ?? name`.

**The reverse-lookup problem:** history items are keyed by *exercise slug first*, so there is no way to query "all history entries belonging to session X" without a scan. The solution: **the session item is its own index.** Read the existing session before writing; its `exercises[]` deterministically yields the previous key set.

Save flow:
1. `GetItem` the existing session (if any)
2. Derive `oldKeys` from its `exercises[]`; derive `newKeys` from the incoming payload
3. Single `TransactWriteItems`:
   - `Put` the session item (with `ConditionExpression` on `version` for optimistic locking)
   - `Put` one history item per incoming exercise
   - `Delete` each key in `oldKeys - newKeys`

**Sizing and the hard ceiling.** `TransactWriteItems` caps at 100 items. A save writes `1 session item + N history puts + D history deletes`, where `D` is bounded by the previous exercise count and, worst case (every exercise swapped), `D ≈ N`. So `1 + 2N ≤ 100` gives a ceiling of **~49 exercises per session**.

The largest session in live data has 9 exercises (~10–12 items), so this is ~5× headroom — but the limit is real and nothing in the schema caps exercise count, since supplementals can be added freely. Left unhandled it would surface as an opaque DynamoDB error.

**Therefore: validate a maximum of 40 exercises per session at the input-validation layer** (worst case `1 + 40 + 40 = 81` items, comfortably inside the limit) and reject beyond it with a clear error. 40 is >4× the observed maximum and well past any realistic workout.

`BatchWriteItem`'s 25-item cap would also fit typical sessions but is not atomic, so the transaction is preferred.

This diff step is what handles exercise swaps: changing Leg Press → Hack Squat mid-session deletes the `leg-press` history item and writes a `hack-squat` one, rather than orphaning the old entry.

**Deleting a session** uses the same derivation: read it, delete the session item plus every history key it produced, in one transaction.

### 5.2 Editing a program (archive + update)

Two writes with two distinct failure modes:

*Partial failure* — **archive first, then update.** If the process dies between them, the archive exists and the current item is unchanged; a retry is idempotent. The reverse order would leave a version archived nowhere, and any session referencing it would point at a nonexistent item.

*Concurrent edits* — `ConditionExpression: 'version = :expected'` on the current item, so a second concurrent writer fails loudly instead of silently discarding the first edit.

Implement as one `TransactWriteItems` (archive `Put` + conditional `Put`), which makes both moot.

### 5.3 Profile creation — must not depend solely on the Cognito trigger

The post-confirmation trigger creates `USER#<sub>/PROFILE` and sets `isOwner` by email match. **Cognito triggers can fail with no retry**, leaving a confirmed user with no profile and every subsequent API call broken.

Mitigation: profile creation is an **idempotent shared function**, called by the trigger *and* lazily by `GET /me` when no profile exists. The ID token carries the `email` claim, so `isOwner` can be determined either way.

---

## 6. Auth

- **ID token, not access token.** The API Gateway JWT authorizer validates against the User Pool with `audience` = both app client ids. The ID token carries the `email` claim needed for `isOwner` determination and lazy profile creation; the access token does not by default.
- Clients talk to Cognito directly for signup/login/logout/refresh/reset. No proxy endpoints.
- Two app clients (web, native) so token lifetimes can diverge later without API changes.
- Owner-only authorization is a server-side `isOwner` check on every owner-scoped request — **never** a feature-flag lookup.

**Feature flags — day one:** `GET /me` returns `features: { fiveThreeOne, planDoc, intervalTimer, progressionGuide }`, computed server-side from code defaults + `isOwner`. Clients gate UI on `me.features.X`, never on `isOwner` directly. No `CONFIG` item and no `featureOverrides` map yet — both are pure additions when per-user or no-deploy flipping is actually needed. Precedence when added: code defaults → global overrides → per-user overrides. Flag names constrained by a TS union type.

---

## 7. Robustness & operational requirements

- **PITR (point-in-time recovery) enabled on both stages.** Cheap insurance, and the legacy table has none.
- **`RemovalPolicy.RETAIN` + deletion protection on the prod table and user pool.** CDK's default would destroy them on stack deletion; an accidental `cdk destroy` must not be able to delete workout history or the identity store.
- **Per-Lambda least-privilege IAM** — each function gets only the actions it uses, scoped to the table (+ GSI1 where needed). Mirrors the legacy app's scoping, which is why a `Scan` wasn't even possible during this audit.
- **Input validation on every write path** before any DynamoDB call.
- **Optimistic locking** via `version` + `ConditionExpression` on session and program updates.
- **Idempotency:** all history writes use deterministic keys, so retries and re-runs converge rather than duplicate.
- Separate Cognito pool + DynamoDB table per stage; dev and prod data never mix.
- CORS enabled for the PWA's GitHub Pages origin + local dev origin. RN app is unaffected.

---

## 8. Migration spec (`scripts/migrate-legacy-data.ts`)

One-time, manual, `--dry-run` required before any real write. Reads the legacy `workout-tracker-db` with read-only credentials; never writes to it. Idempotent — deterministic keys mean re-running converges.

**Recommended order:** dev stage first, verify, then prod.

Transformations:
1. **Seed `EXERCISE_LIB_DEFAULT` from a live-table snapshot**, not `exerciseLibrarySeed.js` — the live catalog has drifted (e.g. "Iso-Lateral Low Row", added 2026-07-17, absent from the seed file).
2. Prefix all user-owned data with `USER#<owner-sub>`.
3. **Copy existing `slotId`s verbatim.** Do not recompute from array position — a prior migration already backfilled real slotIds, and recomputing risks reintroducing the reorder-corruption bug.
4. Assign generated `slotId`s (`supp-<ulid>`) to supplemental exercises.
5. **Rebuild exercise history from Session Instances**, not from the legacy `EXERCISE_LIB.history[]` cache, which is capped at 20 entries per exercise and already lossy. Per-set `note` text survives because it lives on the session record too.
6. Coerce all `weight`/`reps`/`rir` to `number | null`.
7. Convert `deload: true` → `tags: ["deload"]`; drop the boolean. Same rule for history entries.
8. Normalize `rest` display strings → `restSeconds` (49 values: `'60 sec'`, `'90 sec'`, `'2 min'`, `'3–4 min'`).
9. Stamp `version: 1`, `schemaVersion: 1`, `programVersion: 1`; write a `PROGRAM_VERSION#<id>#00001` snapshot per program so every session references a version that exists.
10. Migrate all 5/3/1 data verbatim (training-max history is substantive: bench 195→230, squat 270→335 across Mar–Jul 2026), including sessions whose 5/3/1 sets are sparse or blank.
11. Archive `CORE_ROUTINE` definitions (preserving `progressions` and `notes`) and all `CORE_ROUTINE_COMPLETION` records, owner-only.
12. Populate `GSI1PK`/`GSI1SK` on session items.

**Exclusions and corrections:**
- **Skip** `upper-a-5` / `upper-b-5` program configs — superseded by the `fiveDay` session toggle, zero sessions ever logged against them.
- **Skip** the two stub sessions (`SESSION#lower-a/DATE#2026-06-06`, `SESSION#lower-b/DATE#2026-07-19`) — `{PK, SK, notes:""}` only, no data. Log as skipped. The script must tolerate missing `date`/`exercises`/`sessionType` regardless.
- **Correct** the `weight: "2250"` → `225` typo on the Iso-Lateral Low Row history entry — the sole intentional data correction.

The legacy table and PWA continue running untouched; this is a copy, not a cutover.

---

## 9. Deferred (unchanged)

Admin panel, offline sync queue with conflict resolution (`updatedAt`/`version` are in place to support it), progress charts, social/Apple sign-in, rate limiting beyond API Gateway defaults, program-version pruning, custom API domain, SES-branded Cognito emails.

---

## Update - [2026-08-24 02:30]

### Legacy operation coverage audit

Every exported function in the PWA's `lib/dynamodb.js` (31 total) mapped against the new API, to confirm nothing the existing client does is unrepresentable.

| Legacy operation | New API | Notes |
|---|---|---|
| `getSession` | `GET /sessions/{type}/{date}` | |
| `putSession` | `POST` / `PUT /sessions/{type}/{date}` | Split: POST creates under a conditional write, PUT updates under an optimistic lock |
| `updateSessionField` | `PUT /sessions/{type}/{date}` | Full-document replace rather than a field patch |
| `updateSessionExercises` | `PUT /sessions/{type}/{date}` | As above |
| `deleteSession` | `DELETE /sessions/{type}/{date}` | Now also removes derived history in the same transaction |
| `getAllSessionsForType` | `GET /sessions?type=` | Paginated |
| `getRecentSessions` | `GET /sessions?type=&limit=` | |
| `getLastSession` | `GET /sessions?type=&limit=1` | |
| `putBodyweight` | `POST /bodyweight` | |
| `deleteBodyweight` | `DELETE /bodyweight/{date}/{timeOfDay}` | **Signature change** — the key now includes the slot |
| `getAllBodyweights` | `GET /bodyweight` | |
| `getTags` / `putTags` | `GET` / `PUT /tags` | |
| `get531Config` / `put531Config` | `GET` / `PUT /owner/531-config/{exercise}` | Owner-gated |
| `getSessionType` | — | No external callers in the PWA; `GET /programs` covers the need |
| `getAllSessionTypes` | `GET /programs` | |
| `putSessionType` | `POST /programs`, `PUT /programs/{id}` | |
| `updateSessionTypeSubs` | `PUT /programs/{id}` | Full replace; archives a version |
| `getExerciseLibrary` | `GET /exercises` | Now returns default catalog ∪ user's custom |
| `putExercise` | `POST /exercises` | |
| `updateExerciseMeta` | `PATCH /exercises/{slug}` | **Added during this audit — see below** |
| `deleteExercise` | `DELETE /exercises/{slug}` | Now a soft delete |
| `removeExerciseHistoryEntry` | *(implicit)* | Handled by the session-save diff; no longer a client concern |
| `updateExerciseHistory` | *(implicit)* | As above |
| `backfillExerciseHistory` | *(migration)* | Superseded by migration step 5 |
| `getCoreRoutines` / `putCoreRoutine` | *(static client content)* | Routine definitions deliberately never reach this API |
| `recordCoreRoutineCompletion` | `POST /owner/core-routines/{routineId}/complete` | |
| `getCoreRoutineCompletions` | `GET /owner/core-routines/completions` | |
| `flushWriteQueue` | *(client concern)* | Offline queue stays client-side |

**Gap found and closed: `PATCH /exercises/{slug}`.** The API had create and delete for exercises but no update, while the PWA has a live Edit Exercise flow (`ExerciseLibrary.jsx` → `updateExerciseMeta`) that edits `displayName`, `muscleGroups`, `family`, `defaultRepRange`, and `defaultSets`. Without it, renaming was impossible — which would have made the entire `name`/`displayName` split pointless, since its only purpose is to let a rename happen without breaking references. `name` is deliberately not accepted by the endpoint; default-catalog entries reject edits exactly as they reject deletes.

**Operations that moved server-side.** Exercise-history maintenance was previously two client-managed calls (`updateExerciseHistory`, `removeExerciseHistoryEntry`) that the client had to remember to pair with every session write. It is now derived automatically inside the session save transaction — the client can no longer forget it, and it cannot half-apply.

**Client changes required at PWA migration (phase 2):**
1. `deleteBodyweight` must pass `timeOfDay`.
2. `putSession` splits into POST (create) and PUT (update); a `409` on POST means "session already exists — open it instead."
3. Numeric coercion at the boundary: the API returns and expects `number | null`, while the PWA's inputs produce strings.
4. Full-document writes: partial helpers like `updateSessionField` send the whole session.

---

## Update - [2026-09-18 10:00]

# PLAN — Managed Workouts (not yet implemented)

A design for user-defined, versionable, branchable workout plans with an active
selection. **Plan only — no code written.** Decisions marked *(decided)* are settled;
*(open)* items still need a call.

---

## 1. The gap this closes

What the code currently calls a "program" is a single **training day** — `SESSION_TYPE#lower-a`
("Lower A", Monday, 5 exercises). There are five, and nothing groups them.

The legacy PWA *did* have a container (`PROGRAM#spring2026`); the migration flattened it
away because one user with one plan didn't need it. This feature restores it with
description, lineage, and an active flag.

## 2. Terminology *(decided)*

| Term | Means | Was |
|---|---|---|
| **Program** | A named plan containing days. Versionable, branchable, one active at a time. | *(did not exist)* |
| **Day** | One training day with its exercise slots. | confusingly called "program" |

The existing `/programs` endpoints (which return days) are renamed to `/days`, freeing
`/programs` for the container. Doing this now is free — no client consumes the API yet —
and permanently confusing if deferred.

## 3. Versioning model *(decided)*

Two layers that serve different purposes and must not be conflated:

**Internal revisions — automatic, invisible.** Every day edit archives a snapshot
(the existing `PROGRAM_VERSION#` mechanism, renamed `DAY_REVISION#`). Sessions stamp the
revision they ran against so historical targets resolve correctly. This is the mechanism
adopted in the 2026-08-24 01:15 update and it stays exactly as built. Users never see it.

**Named versions — explicit, user-facing.** Editing a program edits it *in place*; no new
row. A new row appears only when the user explicitly marks a new version, which creates a
new Program record linked to its parent. Branch lineage *is* the user-visible version
history — one mechanism, not two.

Storage is not the constraint here: a full five-day program serialises to ~7.6 KB, so a
thousand snapshots is ~7.4 MB (≈$0.002/month). The reason edits don't auto-create versions
is that a version list full of trivial entries is unusable, not that it is expensive.

## 4. Branch semantics *(decided)*

Branching copies the program: new `programId`, **new `dayId`s**, **preserved `slotId`s**.

These two are separable because they are keyed differently, and the split is deliberate:

- **Session logs follow `dayId`** → new ids mean each program keeps its own session history
- **Exercise history follows `slotId`** → preserved ids mean progression carries across the
  branch: open the branched program's Leg Press slot and your prior Leg Press history is there

That combination gives independent session logs without losing progression, which is
usually the entire point of branching rather than starting fresh.

## 5. Schema

| Entity | PK | SK | Notes |
|---|---|---|---|
| Program | `USER#<sub>` | `PROGRAM#<programId>` | `name`, `description`, `parentProgramId?`, `dayIds[]`, soft-deletable |
| Day | `USER#<sub>` | `DAY#<dayId>` | `programId`, `name`, `day` (label), `focus`, `exercises[]`, `revision` |
| Day revision | `USER#<sub>` | `DAY_REVISION#<dayId>#<nnnnn>` | Internal snapshot; renamed from `PROGRAM_VERSION#` |
| Active pointer | `USER#<sub>` | `ACTIVE_PROGRAM` | `{ programId }` |

**Active is a singleton pointer item, not an `isActive` flag on each program.** A flag
would require clearing the old one and setting the new one — two writes that can leave
zero or two programs active if interleaved. A pointer makes switching a single write that
is atomic by construction, and finding the active program a `GetItem` rather than a scan.

**`dayId` must be globally unique.** Sessions are keyed `USER#<sub>#SESSION#<dayId>`, so
two programs each containing a day called `lower-a` would write into the *same partition*
and silently blend their histories. New days get ULIDs.

## 6. Session changes

- `Session.sessionType` → `dayId` (same position in the key, clearer name)
- `Session.programVersion` → `dayRevision` (it always referred to the day, never a program)
- Sessions do not store `programId`; it is reachable via `dayId` → Day → `programId`

All 84 migrated sessions currently carry `programVersion: 1`, so this is a rename with no
data reinterpretation.

## 7. API surface

**Programs (new)**
- `GET /programs` — list, including which is active
- `POST /programs` — create empty, or `{ fromProgramId }` to branch
- `PUT /programs/{id}` — edit name/description in place
- `DELETE /programs/{id}` — soft delete
- `GET /programs/active` / `PUT /programs/active` — read / set the active program

**Days (renamed from the current `/programs`)**
- `GET /days?programId=` · `POST /days` · `PUT /days/{id}` · `DELETE /days/{id}`
- `GET /days/{id}/revisions/{revision}` — internal revision lookup, for historical targets

"New Session" reads the active program and offers its days.

## 8. Migration

Existing data wraps into one program:
- Create `PROGRAM#<ulid>` named "Spring 2026" with a description, set as active
- Attach the five existing days to it
- **Keep the existing human-readable `dayId`s** (`lower-a`, `upper-a`, …) rather than
  reassigning ULIDs. Reassigning would change every session PK, and re-running the
  migration writes new items without deleting the old ones — leaving stale duplicates
  under the previous keys. ULIDs apply to days created from here on. *(open — the
  alternative is a full re-migration plus an explicit cleanup pass; consistency vs. churn)*

## 9. Open questions

- **Logging against a non-active program.** Should a day from an inactive program still
  accept sessions (useful for backfilling a missed workout after switching plans), or is
  "New Session" the only entry point? Recommendation: allow it at the API level and
  restrict only what the client *offers*, matching how `deload` and other client-side
  concerns are handled.
- **Switching active mid-week.** A session already started under the old program stays
  editable; only the "New Session" list changes. Worth confirming that is the desired feel.
- **Deleting a program that owns history.** Soft delete only — its days must stay
  resolvable or past sessions cannot render. Already the established convention.

---

## Update - [2026-09-18 10:40]

# PLAN addendum — resolved questions and a robustness audit of revisions

## A. Session key collision — no resolution rule needed *(resolved)*

The earlier flag proposed handling two programs sharing a `dayId`. With the decided
branch semantics (new `dayId`s on branch, ULIDs for all new days) **two programs can never
share a `dayId`**, so their sessions can never reach the same partition. The problem is
eliminated at the source rather than resolved at read time.

A "prefer the newest program" rule was considered and rejected: sessions are keyed
`USER#<sub>#SESSION#<dayId>` / `DATE#<date>`, so a shared `dayId` on the same date is the
*same item*. The second write would not blend with the first, it would **overwrite and
destroy it**. A read-time preference would tidy query results while leaving silent data
loss underneath, and would additionally require denormalising `programId` onto every
session and filtering every query.

## B. The other three, concretely

**In-place edits vs. historical targets.** Two layers, answering different questions:

| Layer | Trigger | Visible | Purpose |
|---|---|---|---|
| Day revision | every day edit, automatic | no | a past session resolves the targets in effect when it was run |
| Named version | explicit "save as new version" | yes | the version list the user browses and branches from |

Editing a day archives a snapshot to `DAY_REVISION#<dayId>#<nnnnn>` and bumps `revision`;
sessions stamp `dayRevision` at creation and read it back when rendering. This is the
existing mechanism, renamed. "Save as new version" creates a new Program row referencing
its parent. ~1.5 KB per edit.

**Active-flag race.** No per-program flag. One pointer item, `USER#<sub>` /
`ACTIVE_PROGRAM` → `{ programId }`. Switching is a single `PutItem`, atomic by
construction — there is no interleaving that yields zero or two active programs, because
"active" exists in exactly one place. Reading it is a `GetItem`, not a scan-and-filter.

**Naming.** `SESSION_TYPE#` → `DAY#`, `PROGRAM_VERSION#` → `DAY_REVISION#`, type `Program`
→ `Day`, `Session.sessionType` → `dayId`, `Session.programVersion` → `dayRevision`,
`/programs` (days) → `/days`. Session partition keys contain `SESSION#`, **not**
`SESSION_TYPE#`, so they are untouched; only 5 day items and 5 revision snapshots change
keys. Update the migration's key builders, re-run (idempotent), delete the 10 stale items.

## C. Robustness audit of the revision mechanism

Verified against the implemented code. The core is correct: a revision archive for version
N is written only when moving N→N+1, and `getProgramVersion` falls back to the current item
when the requested version equals `current.version` — so the "latest" revision resolves
even though it has not been archived yet. `updateSession` spreads `...previous`, so a
session edited later keeps pointing at the revision it was *performed* under, which is the
correct behaviour. Findings below.

**1. Correction to the plan: drop `dayIds[]` from the Program item.** The plan had Program
store `dayIds[]` while Day stores `programId` — two sources of truth that drift the first
time a day is created and the array is not updated, silently orphaning it. Instead, store
`programId` on the Day only and list a program's days by querying `begins_with(SK, 'DAY#')`
and filtering. At 5–50 days that is one query and a trivial filter, and divergence becomes
structurally impossible.

**2. A session against a non-existent day silently succeeds.** `currentProgramVersion`
returns `program?.version ?? 1` — a typo'd or deleted `dayId` yields `dayRevision: 1` with
no error, and the session renders against a revision that does not exist. Should 404 at
session creation instead of inventing a revision.

**3. Revision padding has a silent cliff.** `padStart(5, '0')` means version 100000 renders
as `"100000"`, which sorts *before* `"99999"` — lexical ordering breaks with no error.
Unreachable in practice (~273 years at one edit per day), but it is a correctness cliff
with no guard. Widen the pad and assert on overflow.

**4. `ACTIVE_PROGRAM` can dangle.** Soft-deleting the active program leaves the pointer
aimed at a deleted record, so "New Session" silently offers nothing. Rule: refuse to delete
the active program, requiring an explicit switch first.

**5. `ACTIVE_PROGRAM` unset on a new account.** Needs defined behaviour rather than an
incidental 404. `GET /programs/active` returns `{ programId: null }` so clients have one
code path.

**6. Target lookup must degrade, not throw.** If a day is edited mid-session, the session
may contain a `slotId` that exists only in the newer revision. Rendering against the
stamped revision then finds no matching slot. This is not fatal — the session stores its
own performed data — but the target lookup must return "no target" rather than error.

**Confirmed correct, stated so nobody "fixes" it later:** a branched day starts at revision
1 and does *not* inherit the parent's revisions. The parent's sessions still reference the
parent's `dayId`s and revisions, which still exist, so the two lineages stay cleanly
separate. And exercise-history continuity across a branch works out: the history key is
`EXERCISE_HISTORY#<slug>#<date>#<sessionType>#<slotId>`, so a branch (new `dayId`, same
`slotId`) writes keys differing only in the `dayId` segment — no collision with the
parent's entries, and a prefix query on the slug returns both lineages. That is exactly the
intended "separate session logs, shared progression".
