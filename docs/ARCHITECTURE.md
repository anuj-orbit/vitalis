# Vitalis: architecture and API contract

This is the contract for three leaders building in parallel. If something you need isn't here, ask the orchestrator before you change a shared contract. Only the owner of a file edits it.

Stack: Node 22 ESM, Express 4, `pg`, `bcryptjs`, vanilla JS SPA in `public/`. Sessions are stateless HMAC-signed cookies, so the app needs no session table.

## 1. Module layout and ownership

| Path | Owner | Purpose |
|---|---|---|
| `package.json`, `package-lock.json` | A | Adds `bcryptjs` and updates the `lint` script (see §8) |
| `src/config.js` | A | `loadConfig(env)` |
| `src/schema.js` | A | `SCHEMA_SQL`, `migrate(pool)`: every table and index |
| `src/db.js` | A | Existing `getPg()`, `dbStatus()`. Adds `withPgTx(pool, fn)` |
| `src/app.js` | A | `createApp(opts)`: middleware and route mounting (§2.1) |
| `src/server.js` | A | Startup: migrate, build stores, seed admin, listen |
| `src/middleware.js` | A | `HttpError`, session, guards, JSON-only, rate limit, error handler |
| `src/auth.js` | A | Password hashing, session tokens, register/login, admin seed |
| `src/routes/auth.js`, `src/routes/providers.js`, `src/routes/admin.js` | A | Routers |
| `src/stores/index.js`, `src/stores/memory.js` | A | Store composition, transactions, in-memory state |
| `src/stores/users.js`, `src/stores/providers.js`, `src/stores/availability.js` | A | Repositories (pg and memory) |
| `src/credits.js`, `src/bookings.js`, `src/payments.js` | B | Domain logic |
| `src/routes/credits.js`, `src/routes/bookings.js` | B | Routers, including admin credit/booking routes and slots |
| `src/stores/bookings.js`, `src/stores/ledger.js` | B | Repositories (pg and memory) |
| `public/**` | C | SPA: HTML, CSS, JS |
| `test/helpers.js`, `test/health.test.js`, `test/auth.test.js`, `test/providers.test.js`, `test/admin.test.js`, `test/schema.test.js` | A | Tests and shared helpers |
| `test/credits.test.js`, `test/bookings.test.js`, `test/slots.test.js`, `test/payments.test.js`, `test/pg.integration.test.js` | B | Tests |
| `test/frontend.test.js` | C | Tests |

**Bootstrap rule:** A and B each start by creating every owned `src/` file as a stub that compiles and exports the names below. Routers start as an empty `express.Router()`. That way `app.js` imports resolve from the start. Do not run git commands.

## 2. Module signatures

Conventions:
- Ids are integers.
- Timestamps are JS `Date` objects in domain objects. `res.json` serialises them to ISO-8601 UTC.
- Money is integer credits.
- Domain and JSON keys are camelCase. SQL columns are snake_case. Repositories do the mapping.
- `deps = { stores, config, payments, now }`, where `now()` returns a `Date` (tests inject a fixed clock).

### 2.1 `src/app.js` (A)
```js
export function createApp({ stores, config, payments, now } = {})
// defaults: config = loadConfig(); stores = getPg() ? createPgStores(getPg()) : createMemoryStores();
//           payments = createSimulatedPaymentProvider(); now = () => new Date()
```
Middleware order:
1. `app.set('trust proxy', 1)`
2. `express.json({ limit: '100kb' })`
3. `express.static(public)`
4. `GET /health` (unchanged)
5. `app.use('/api', jsonOnly, sessionMiddleware(deps))`

Mount order (more specific paths first):
```js
app.get('/api/providers/:id/slots', slotsHandler(deps));       // B
app.use('/api/auth', authRouter(deps));                         // A
app.use('/api/providers', providersRouter(deps));               // A
app.use('/api/credits', creditsRouter(deps));                   // B
app.use('/api/bookings', bookingsRouter(deps));                 // B
app.use('/api/admin/credits', adminCreditsRouter(deps));        // B
app.use('/api/admin/bookings', adminBookingsRouter(deps));      // B
app.use('/api/admin', adminRouter(deps));                       // A
app.use('/api', notFoundApi); app.use(errorHandler);
```

### 2.2 `src/config.js` (A)
`export function loadConfig(env = process.env)` returns:
```js
{ port, databaseUrl, sessionSecret, adminEmail, adminPassword, platformFeePct, creditPriceAed,
  creditPacks: [10,25,50,100], sessionTtlSec: 604800, cancelWindowHours: 24, slotMinutes: 60,
  bookingHorizonDays: 60, bcryptRounds, isProduction }
```

| Env var | Default | Notes |
|---|---|---|
| `PORT` | 3000 | |
| `DATABASE_URL` | unset | If unset, the app uses in-memory stores (dev and tests) |
| `SESSION_SECRET` | random per process (dev) | Required when `NODE_ENV=production`; `loadConfig` throws if it is missing or under 32 characters |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | unset | Admin is seeded at startup if both are set |
| `PLATFORM_FEE_PCT` | 20 | Integer 0–100; anything invalid falls back to 20 |
| `CREDIT_PRICE_AED` | 5 | 1 credit = 5 AED = 500 fils. `amountFils = credits * creditPriceAed * 100` |
| `BCRYPT_ROUNDS` | 10 | Tests use 4 |
| `NODE_ENV` | | `production` adds `Secure` to the cookie |

### 2.3 `src/schema.js` (A)
`export const SCHEMA_SQL` is a string array.

`export async function migrate(pool)` runs it in one transaction after `SELECT pg_advisory_xact_lock(7242024)`. `server.js` calls it only when `DATABASE_URL` is set.
```sql
CREATE TABLE IF NOT EXISTS users (id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  email text NOT NULL UNIQUE, password_hash text NOT NULL, name text NOT NULL,
  role text NOT NULL DEFAULT 'consumer' CHECK (role IN ('consumer','provider','admin')),
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS providers (id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  user_id integer NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('yoga','fitness','doctor')), specialty text NOT NULL,
  bio text NOT NULL DEFAULT '', credentials text NOT NULL, license_no text,
  price_credits integer NOT NULL CHECK (price_credits BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  review_note text, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS providers_status_kind_idx ON providers (status, kind);
CREATE TABLE IF NOT EXISTS availability (id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  provider_id integer NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time time NOT NULL, end_time time NOT NULL, CHECK (start_time < end_time));
CREATE INDEX IF NOT EXISTS availability_provider_idx ON availability (provider_id, weekday);
CREATE TABLE IF NOT EXISTS bookings (id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  consumer_id integer NOT NULL REFERENCES users(id), provider_id integer NOT NULL REFERENCES providers(id),
  starts_at timestamptz NOT NULL, duration_min integer NOT NULL DEFAULT 60 CHECK (duration_min > 0),
  price_credits integer NOT NULL CHECK (price_credits > 0),
  status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','cancelled','completed')),
  meeting_url text NOT NULL, payout_credits integer, cancelled_at timestamptz, completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now());
-- No double booking. The index is partial so a cancelled slot can be booked again.
CREATE UNIQUE INDEX IF NOT EXISTS bookings_provider_slot_uniq ON bookings (provider_id, starts_at) WHERE status <> 'cancelled';
CREATE INDEX IF NOT EXISTS bookings_consumer_idx ON bookings (consumer_id, starts_at);
CREATE INDEX IF NOT EXISTS bookings_provider_idx ON bookings (provider_id, starts_at);
CREATE TABLE IF NOT EXISTS credit_ledger (id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id), delta integer NOT NULL CHECK (delta <> 0),
  reason text NOT NULL CHECK (reason IN ('topup','booking','refund','payout','adjust')),
  booking_id integer REFERENCES bookings(id), balance_after integer NOT NULL CHECK (balance_after >= 0),
  ref text UNIQUE, note text, created_by integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS credit_ledger_user_idx ON credit_ledger (user_id, id DESC);
-- At most one debit, one refund and one payout per booking.
CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_booking_reason_uniq ON credit_ledger (booking_id, reason) WHERE booking_id IS NOT NULL;
```

### 2.4 Store and repository interface (A defines composition; A and B implement repositories)
`src/stores/index.js` exports:
- `createPgStores(pool)`
- `createMemoryStores()`

Both return:
```js
{ users, providers, availability, bookings, ledger, tx: async (fn) => fn(txStores) }
```
`txStores` has the same repositories bound to one transaction, and `txStores.tx = (fn) => fn(txStores)` (re-entrant).

How `tx` works:
- **pg:** `withPgTx(pool, async (client) => ...)` runs BEGIN/COMMIT, rolls back on throw, and releases the client.
- **memory:** a promise-chain mutex serialises every `tx`. It snapshots the state with `structuredClone` and restores it if the callback throws.

Each repository module exports `pgXRepo(q)` and `memXRepo(state)`. `q` is anything with `.query(text, params)`.

`src/stores/memory.js` (A) exports:
- `createMemoryState()`, which returns `{ seq:{users:0,providers:0,availability:0,bookings:0,ledger:0}, users:[], providers:[], availability:[], bookings:[], ledger:[] }`
- `nextId(state, table)`

Memory rows are the camelCase domain objects below. User rows also carry `passwordHash`.

Every method is async. `list*` methods take `limit` (default 50, max 100) and `offset`, and return `{ items, total }`.

Domain shapes:

| Shape | Fields |
|---|---|
| `User` | `{id,email,name,role,createdAt}` |
| `Provider` | `{id,userId,name,email,kind,specialty,bio,credentials,licenseNo,priceCredits,status,reviewNote,createdAt}`, where `name`/`email` are joined from users |
| `Slot` (availability row) | `{id,providerId,weekday,startTime:'HH:MM',endTime:'HH:MM'}` |
| `Booking` | `{id,consumerId,consumerName,providerId,providerName,providerKind,startsAt,durationMin,priceCredits,status,meetingUrl,payoutCredits,cancelledAt,completedAt,createdAt}` |
| `Entry` | `{id,userId,delta,reason,bookingId,balanceAfter,ref,note,createdBy,createdAt}` |

**users (A):**
- `create({email,passwordHash,name,role})` returns a `User`. Throws `HttpError(409,'EMAIL_TAKEN')` (pg maps error 23505).
- `findByEmail(email)` returns `User & {passwordHash}` or null.
- `findById(id)` returns `User` or null.
- `lockById(id)` returns `User` or null. pg: `SELECT ... FROM users WHERE id=$1 FOR UPDATE`. Memory: plain lookup.
- `setRole(id, role)`
- `list({role,q,limit,offset})` returns items of `User & {balance}`. pg gets balance from a latest-`balance_after` subquery, or 0. `q` is an ILIKE on email/name.

**providers (A):**
- `create({userId,kind,specialty,bio,credentials,licenseNo,priceCredits})` returns a `Provider` with status pending.
- `findById(id)` and `findByUserId(userId)` return a `Provider` or null.
- `update(id, patch)` returns a `Provider`. `patch` may contain `specialty,bio,credentials,licenseNo,priceCredits,kind,status,reviewNote`.
- `list({status,kind,specialty,q,limit,offset})` orders by `id` asc. `specialty` is a case-insensitive exact match. `q` is an ILIKE on name, specialty and bio.

**availability (A):**
- `listByProvider(providerId)` returns `Slot[]` ordered by weekday, startTime.
- `replaceForProvider(providerId, rows)` deletes and then inserts. Call it inside `tx`.

**bookings (B):**
- `insert({consumerId,providerId,startsAt,durationMin,priceCredits,meetingUrl})` returns a `Booking` with status confirmed. If an active booking already holds the same provider+startsAt, it throws `HttpError(409,'SLOT_TAKEN')`. pg maps 23505 on `bookings_provider_slot_uniq`; memory checks explicitly.
- `findById(id)` returns a `Booking` or null.
- `lockById(id)` returns a `Booking` or null (`FOR UPDATE`).
- `update(id, {status,cancelledAt,completedAt,payoutCredits})` returns a `Booking`.
- `listActiveForProvider(providerId, from, to)` returns the non-cancelled bookings with `from <= startsAt < to`.
- `list({consumerId,providerId,status,startsFrom,startsBefore,order:'asc'|'desc',limit,offset})` sorts by `startsAt`.

**ledger (B):**
- `getBalance(userId)` returns the latest `balanceAfter`, or 0.
- `insert({userId,delta,reason,bookingId,balanceAfter,ref,note,createdBy})` returns an `Entry`. A duplicate `ref`, or a duplicate `(bookingId,reason)`, throws `HttpError(409,'DUPLICATE_ENTRY')`.
- `findByRef(ref)` returns an `Entry` or null.
- `list({userId,reason,limit,offset})` orders by `id` desc.

### 2.5 `src/middleware.js` (A)
```js
export class HttpError extends Error { constructor(status, code, message = code, details) }
export function sessionMiddleware({ stores, config, now })  // sets req.user = User|null from the cookie
export function requireAuth(req, res, next)                  // otherwise 401 UNAUTHENTICATED
export function requireRole(...roles)                        // 401 if no user, 403 FORBIDDEN on role mismatch
export function jsonOnly(req, res, next)                     // POST/PUT/PATCH/DELETE with a non-empty body
                                                             // and a non-JSON content-type -> 415
export function rateLimit({ windowMs, max, key = (req) => req.ip })  // in-memory fixed window, 429 RATE_LIMITED
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
export function notFoundApi(req, res)                         // 404 NOT_FOUND
export function errorHandler(err, req, res, next)             // HttpError -> its status; JSON SyntaxError -> 400 VALIDATION;
                                                              // anything else -> 500 INTERNAL (logged, no stack in body)
```
Error body: `{"error":{"code":"VALIDATION","message":"password must be 8-128 chars","details":{"field":"password"}}}`.

### 2.6 `src/auth.js` (A)
```js
export const SESSION_COOKIE = 'vitalis_session'
export function hashPassword(password, rounds)                 // bcryptjs.hash
export function verifyPassword(password, hash)                 // bcryptjs.compare
export function signSession({ uid, exp }, secret)              // `${b64url(JSON)}.${b64url(HMAC-SHA256(secret, b64urlJSON))}`
export function verifySession(token, secret, nowMs)            // {uid,exp} | null; timingSafeEqual, exp is in seconds
export function parseCookies(header)                           // { name: value }
export function sessionCookie(token, { secure, maxAgeSec })    // 'vitalis_session=..; Path=/; HttpOnly; SameSite=Lax; Max-Age=..[; Secure]'
export function clearSessionCookie({ secure })                 // same attributes with Max-Age=0
export async function register(deps, { email, password, name }) // returns a User (role consumer)
export async function authenticate(deps, { email, password })  // User | null; on unknown email it still compares
                                                               // against a dummy hash so timing is constant
export async function ensureAdmin(deps)                        // creates the admin from config, or promotes an existing
                                                               // user to admin; never resets a password
```
Validation:
- Email: trimmed, lowercased, matches `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`, at most 254 characters.
- Password: 8–128 characters.
- Name: 1–100 characters after trimming.

Logout is stateless (it clears the cookie). A token stays valid until `exp` (7 days).

### 2.7 Routers
- **A:** `authRouter(deps)`, `providersRouter(deps)`, `adminRouter(deps)` from `src/routes/{auth,providers,admin}.js`.
- **B:** `creditsRouter(deps)` and `adminCreditsRouter(deps)` from `src/routes/credits.js`; `bookingsRouter(deps)`, `adminBookingsRouter(deps)` and `slotsHandler(deps)` from `src/routes/bookings.js`.

Routers never contain a catch-all.

### 2.8 `src/payments.js` (B)
The `PaymentProvider` interface:
```js
charge({ userId, credits, amountFils, currency: 'AED', idempotencyKey })
  -> Promise<{ status: 'succeeded'|'failed', ref, failureReason? }>
```
`export function createSimulatedPaymentProvider({ fail = false } = {})` returns `ref = 'sim_' + randomBytes(8).hex`. It always succeeds unless `fail` is set. A Stripe implementation can later be dropped in behind the same interface.

### 2.9 `src/credits.js` (B)
```js
export const LEDGER_REASONS = ['topup','booking','refund','payout','adjust']
export function packsFor(config)            // [{credits, amountAed, amountFils}]
export async function applyLedgerEntry(txStores, { userId, delta, reason, bookingId = null, ref = null, note = null, createdBy = null })
  // Must run inside tx. Locks the user row, reads the balance, rejects a result < 0 with 402 INSUFFICIENT_CREDITS, inserts. Returns an Entry.
export async function getBalance(deps, userId)
export async function topUp(deps, { userId, pack, idempotencyKey })  // returns { entry, balance, payment:{ref,amountAed}, replayed }
export async function adjustCredits(deps, { adminId, userId, delta, note })  // returns { entry, balance }
export async function listLedger(deps, { userId, reason, limit, offset })
```

### 2.10 `src/bookings.js` (B)
```js
export function makeMeetingUrl()   // `https://meet.jit.si/vitalis-${randomBytes(9).toString('hex')}`
export function computeSlots({ date, availability, bookings, now, slotMinutes = 60 })  // pure; see §5
export async function getSlots(deps, { providerId, date })   // returns { date, timezone:'UTC', slots }
export async function createBooking(deps, { consumer, providerId, startsAt })  // returns { booking, balance }
export async function cancelBooking(deps, { bookingId, actor })   // returns { booking, refundCredits }
export async function completeBooking(deps, { bookingId, actor }) // returns { booking, payoutCredits }
export async function listBookings(deps, { actor, as, scope, status, limit, offset })
export function payoutFor(priceCredits, feePct)  // Math.floor(priceCredits * (100 - feePct) / 100)
```

## 3. REST API
All endpoints are under `/api`. Request and response bodies are JSON. Authentication is the session cookie.

Lists take `?limit=` (1–100, default 50) and `?offset=`, and return `{items,total}`.

Roles: **pub** = anyone, **auth** = any logged-in user, **prov** = logged-in user who has a provider row, **admin** = role admin. "own" means the resource belongs to the caller.

| Method and path | Role | Request | 2xx response | Errors |
|---|---|---|---|---|
| `GET /health` | pub | – | `200 {status,postgres,mongo}` | 503 |
| `POST /auth/register` | pub, rate limited | `{email,password,name}` | `201 {user}` and Set-Cookie | 400 VALIDATION, 409 EMAIL_TAKEN, 429 |
| `POST /auth/login` | pub, rate limited | `{email,password}` | `200 {user}` and Set-Cookie | 400, 401 INVALID_CREDENTIALS, 429 |
| `POST /auth/logout` | pub | – | `204` and cleared cookie | – |
| `GET /auth/me` | pub | – | `200 {user:User\|null, provider:{id,status,kind}\|null}` | – |
| `GET /providers` | pub | `?kind&specialty&q&limit&offset` | `200 {items:Provider[],total}` (approved only, no `email`) | 400 |
| `GET /providers/me` | auth | – | `200 {provider:Provider\|null, availability:Slot[]}` | 401 |
| `POST /providers/apply` | auth, not admin | `{kind,specialty,bio,credentials,licenseNo,priceCredits}` | `201 {provider}` (new) or `200 {provider}` (re-applying after rejection; resets to pending) | 400, 401, 403, 409 ALREADY_APPLIED (pending or approved) |
| `PUT /providers/me` | prov | Partial `{specialty,bio,credentials,licenseNo,priceCredits}` | `200 {provider}` | 400, 401, 404 NOT_FOUND (no provider row) |
| `PUT /providers/me/availability` | prov | `{availability:[{weekday,startTime,endTime}]}` | `200 {availability:Slot[]}` | 400, 401, 404 |
| `GET /providers/:id` | pub | – | `200 {provider, availability}` (approved only) | 404 |
| `GET /providers/:id/slots` | pub | `?date=YYYY-MM-DD` | `200 {date,timezone:'UTC',slots:[{startsAt,endsAt,available}]}` | 400 VALIDATION, 404 |
| `GET /credits/packs` | pub | – | `200 {creditPriceAed, packs:[{credits,amountAed}]}` | – |
| `GET /credits/balance` | auth | – | `200 {balance}` | 401 |
| `POST /credits/topup` | auth, 30/h per user | `{pack:10\|25\|50\|100, idempotencyKey?:string ≤64}` | `201 {entry,balance,payment:{ref,amountAed}}`, or `200` with the same body and `replayed:true` | 400, 401, 402 PAYMENT_FAILED, 429 |
| `GET /credits/ledger` | auth (own) | `?reason&limit&offset` | `200 {items:Entry[],total}` | 400, 401 |
| `POST /bookings` | auth, not admin | `{providerId, startsAt:ISO}` | `201 {booking, balance}` | 400, 401, 403, 404, 402 INSUFFICIENT_CREDITS, 409 SLOT_TAKEN, 422 SLOT_UNAVAILABLE, 422 SELF_BOOKING |
| `GET /bookings` | auth (own) | `?as=consumer\|provider&scope=upcoming\|past\|all&status&limit&offset` | `200 {items:Booking[],total}` | 400, 401, 403 (`as=provider` without a provider row) |
| `GET /bookings/:id` | auth (consumer, provider or admin of that booking) | – | `200 {booking}` | 401, 403, 404 |
| `POST /bookings/:id/cancel` | auth (consumer, provider or admin of that booking) | – | `200 {booking, refundCredits}` | 401, 403, 404, 409 CANCEL_NOT_ALLOWED |
| `POST /bookings/:id/complete` | provider of that booking, or admin | – | `200 {booking, payoutCredits}` | 401, 403, 404, 409 NOT_COMPLETABLE |
| `GET /admin/applications` | admin | `?status=pending\|approved\|rejected\|all` (default pending) | `200 {items:Provider[],total}` | 400, 401, 403 |
| `POST /admin/applications/:id/approve` | admin | `{note?}` | `200 {provider}`. Status becomes approved and the user's role becomes provider | 401, 403, 404, 409 INVALID_STATUS (already approved) |
| `POST /admin/applications/:id/reject` | admin | `{note?}` | `200 {provider}`. Status becomes rejected; if the user's role was provider it goes back to consumer | 401, 403, 404, 409 INVALID_STATUS (already rejected) |
| `GET /admin/users` | admin | `?role&q&limit&offset` | `200 {items:(User&{balance})[],total}` | 401, 403 |
| `GET /admin/bookings` | admin | `?status&providerId&consumerId&limit&offset` | `200 {items:Booking[],total}` | 401, 403 |
| `GET /admin/credits/ledger` | admin | `?userId&reason&limit&offset` | `200 {items:Entry[],total}` | 401, 403 |
| `POST /admin/credits/adjust` | admin | `{userId, delta:int ≠0 \|delta\|≤100000, note:1-200 chars}` | `201 {entry,balance}` | 400, 401, 403, 404, 402 INSUFFICIENT_CREDITS |

Every write may also return 415 UNSUPPORTED_MEDIA_TYPE, and every endpoint may return 500 INTERNAL.

Rate limits: register and login allow 20 requests per 15 minutes per IP.

Validation for `apply` and `PUT /providers/me`:
- `kind` is one of yoga, fitness, doctor. It is fixed after apply.
- `specialty`: 1–80 characters.
- `bio`: at most 2000 characters.
- `credentials`: 1–2000 characters.
- `licenseNo`: at most 80 characters, required when kind is doctor.
- `priceCredits`: integer 1–1000.

Availability rows:
- `weekday` is 0–6 (0 = Sunday, the JS `getUTCDay` convention).
- `startTime` is `"HH:00"` from 00:00 to 23:00, and `endTime` is `"HH:00"` from 01:00 to 24:00, with start < end. Both are in UTC.
- At most 28 rows, and rows must not overlap within a weekday.

## 4. Transactional rules (B; all inside `stores.tx`)

Lock order is always the booking row first, then the user row, so transactions cannot deadlock. Balances are integers, and `balance_after >= 0` is enforced by `applyLedgerEntry` and by a CHECK constraint.

`applyLedgerEntry` steps:
1. `users.lockById(userId)` (`SELECT ... FOR UPDATE`). If there is no row: 404.
2. `bal = ledger.getBalance(userId)`, then `next = bal + delta`.
3. If `next < 0`: throw 402 INSUFFICIENT_CREDITS.
4. `ledger.insert({... balanceAfter: next})`.

The ledger is append-only. Nothing ever updates or deletes a ledger row.

- **Book.**
  1. Validate input.
  2. Load the provider. It must be approved, otherwise 404.
  3. If `provider.userId === consumer.id`: 422 SELF_BOOKING.
  4. `startsAt` must match an `available` slot from `getSlots` for its UTC date, otherwise 422 SLOT_UNAVAILABLE.
  5. In a `tx`:
     1. `users.lockById(consumer.id)` and `getBalance`. If the balance is below `provider.priceCredits`: 402.
     2. `bookings.insert(...)` with `durationMin: 60`, the current `priceCredits` (snapshotted), and `makeMeetingUrl()`. A concurrent booking of the same slot blocks on the unique index and then gets 409 SLOT_TAKEN.
     3. `applyLedgerEntry({delta:-price, reason:'booking', bookingId})`.
- **Cancel.**
  1. `bookings.lockById`. Status must be confirmed and `now < startsAt`, otherwise 409 CANCEL_NOT_ALLOWED.
  2. Refund rule:
     - Consumer cancelling with `startsAt - now >= 24h`: full refund.
     - Consumer cancelling later than that: refund 0 (the cancel is still allowed).
     - Provider or admin cancelling: always a full refund.
  3. Update the booking to `{status:'cancelled', cancelledAt: now}`.
  4. If the refund is greater than 0: `applyLedgerEntry({userId: consumerId, delta:+price, reason:'refund', bookingId})`.
  5. Return `refundCredits`.
- **Complete.**
  1. `bookings.lockById`. The actor must be that booking's provider user or an admin (403 otherwise).
  2. The status must be confirmed and `now >= startsAt + durationMin`, otherwise 409 NOT_COMPLETABLE.
  3. `payout = payoutFor(price, config.platformFeePct)`. The platform keeps `price - payout`; nothing is written to the ledger for the platform's share.
  4. Update the booking to `{status:'completed', completedAt: now, payoutCredits: payout}`.
  5. If the payout is greater than 0: `applyLedgerEntry({userId: provider.userId, delta:+payout, reason:'payout', bookingId})`.

  There is no automatic completion job.
- **Top-up.**
  1. Validate that `pack` is in `config.creditPacks`.
  2. `ref = idempotencyKey ? 'topup:'+userId+':'+idempotencyKey : null`. If `ref` is set and `ledger.findByRef(ref)` exists, return that entry with `replayed:true` (200).
  3. Call `payments.charge(...)` outside the `tx`. If the status is not succeeded: 402 PAYMENT_FAILED.
  4. In a `tx`: `applyLedgerEntry({delta:+pack, reason:'topup', ref: ref ?? 'topup:'+payment.ref, note:'pack '+pack+' credits, '+aed+' AED, gateway '+payment.ref})`.
  5. If that throws DUPLICATE_ENTRY because of a race, return the existing entry as a replay.
- **Refund.** A refund only ever comes from Cancel. The partial unique index on `(booking_id, reason)` ensures at most one refund and one payout per booking.
- **Adjust.** In a `tx`: `applyLedgerEntry({userId, delta, reason:'adjust', note, createdBy: adminId})`. A negative result gives 402.

## 5. Slot computation (B, `computeSlots`, pure)

The input `date` is `YYYY-MM-DD` and is interpreted as a UTC calendar day.

Validation:
- The value must parse.
- It must fall between today (UTC, from `now`) and today + `bookingHorizonDays`, otherwise 400 VALIDATION.

Algorithm:
1. `weekday = new Date(date+'T00:00:00Z').getUTCDay()`.
2. For each availability row on that weekday, emit every `t` from `start` while `t + 60min <= end`, stepping 60 minutes. Each slot is `{startsAt: date+t (UTC), endsAt: startsAt + 60min}`.
3. De-duplicate by `startsAt` and sort ascending.
4. Drop slots with `startsAt <= now`.
5. Set `available = false` when a non-cancelled booking for that provider has the same `startsAt`. Bookings come from `listActiveForProvider(providerId, dayStart, dayStart+24h)`.

All API times are UTC ISO strings.

**Display note:** the frontend shows times in `Asia/Dubai` (GST, UTC+4, no DST) using `Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Dubai',...})`. The date picker sends the UTC date. Because of the offset, slots for UTC date D appear between 04:00 on D and 04:00 on D+1, Dubai time. The availability editor labels its inputs as UTC and shows the Dubai equivalent next to them.

## 6. Frontend (C)

Files:
- `public/index.html`: the shell. It must contain `<html` and `<div id="app">`, a nav, and `<script type="module" src="/js/app.js">`.
- `public/css/app.css`
- `public/js/app.js`: bootstrap, nav and guards. It calls `GET /api/auth/me` on load and on every login/logout.
- `public/js/router.js`, which is pure and imports nothing:
  - `parseHash(hash)` returns `{path, query}`.
  - `matchRoute(routes, path)` returns `{route, params}` or null.
- `public/js/api.js`: `api(method, path, body)`. It uses `fetch` with `credentials:'same-origin'` and a JSON content-type. On an error status it throws `ApiError{status,code,message}`.
- `public/js/format.js`, which is pure:
  - `escapeHtml(s)`
  - `formatDubai(iso)`
  - `aed(credits, priceAed=5)`
  - `kindLabel(kind)`
- `public/js/views/<name>.js`, each exporting `async function render(root, ctx)` where `ctx = {params, query, me, navigate}`.

Rules for views:
- Every user-supplied string is rendered through `escapeHtml` or `textContent`.
- Doctor profiles and doctor booking pages show the medical disclaimer: "Not for emergencies. In an emergency call 999 (UAE)."

Guards: a route marked `auth`, `prov` or `admin` redirects to `#/login?next=<hash>`, or shows a 403 message when the role does not match.

| Hash route | View file | Guard | APIs called |
|---|---|---|---|
| `#/` | `home.js` | – | `GET /providers?limit=6`, `GET /credits/packs` |
| `#/providers?kind&specialty&q` | `providers.js` | – | `GET /providers` |
| `#/providers/:id` | `provider.js` | – (booking needs auth) | `GET /providers/:id`, `GET /providers/:id/slots?date`, `POST /bookings` |
| `#/login`, `#/register` | `auth.js` | – | `POST /auth/login`, `POST /auth/register` |
| `#/apply` | `apply.js` | auth | `GET /providers/me`, `POST /providers/apply` |
| `#/dashboard` | `dashboard.js` | auth | `GET /credits/balance`, `GET /bookings?scope=upcoming&limit=5` |
| `#/credits` | `credits.js` | auth | `GET /credits/packs`, `POST /credits/topup` (`idempotencyKey = crypto.randomUUID()` per click) |
| `#/bookings` | `bookings.js` | auth | `GET /bookings?scope=upcoming\|past`, `POST /bookings/:id/cancel`. Shows `meetingUrl`, and warns before a cancel inside 24h that there is no refund |
| `#/transactions` | `transactions.js` | auth | `GET /credits/ledger` |
| `#/provider` | `provider-dashboard.js` | prov | `GET /providers/me`, `GET /bookings?as=provider&scope=upcoming` |
| `#/provider/profile` | `provider-profile.js` | prov | `GET /providers/me`, `PUT /providers/me`, `PUT /providers/me/availability` |
| `#/provider/bookings` | `provider-bookings.js` | prov | `GET /bookings?as=provider`, `POST /bookings/:id/complete`, `POST /bookings/:id/cancel` |
| `#/provider/earnings` | `provider-earnings.js` | prov | `GET /credits/balance`, `GET /credits/ledger?reason=payout` |
| `#/admin/applications` | `admin-applications.js` | admin | `GET /admin/applications`, `POST /admin/applications/:id/approve` and `/reject` |
| `#/admin/users` | `admin-users.js` | admin | `GET /admin/users`, `POST /admin/credits/adjust` |
| `#/admin/bookings` | `admin-bookings.js` | admin | `GET /admin/bookings`, `POST /bookings/:id/cancel` |
| `#/admin/ledger` | `admin-ledger.js` | admin | `GET /admin/credits/ledger` |

Unknown hashes render a "Not found" view.

## 7. Test plan (`node --test`, no DB required, in-memory stores, `BCRYPT_ROUNDS=4`)

`test/helpers.js` (A) exports:
- `startApp({ now, payments, config })`, which returns `{ url, stores, close }`. It uses `createMemoryStores()` and a `loadConfig` override with `sessionSecret: 'x'.repeat(32)` and `bcryptRounds: 4`.
- `client(url)`, which returns `{get, post, put}`. It returns `{status, body, headers}` and keeps the cookie between calls.
- `registerAs(c, {email, role})`. For the provider and admin roles it creates the user and then sets the role directly through `stores.users.setRole`. For provider it also creates an approved provider row.

**A:**
- `auth.test.js`:
  - sign/verify round trip
  - tampered, expired and malformed tokens are rejected
  - cookie attributes (HttpOnly, SameSite=Lax, Path, Max-Age; Secure only in production)
  - register, me, logout, then me again
  - duplicate email gives 409
  - wrong password gives 401
  - validation errors
  - 415 on a non-JSON POST
  - rate limit gives 429
  - `ensureAdmin` is idempotent and promotes an existing user
- `providers.test.js`:
  - apply rules (doctor needs `licenseNo`; 409 on a second apply; re-apply after rejection)
  - the list shows only approved providers, with kind/specialty/q filters
  - detail returns 404 when the provider is not approved
  - `PUT /me` partial update
  - availability validation (overlap, bounds, `HH:00`)
- `admin.test.js`:
  - non-admin gets 403
  - approve flips status and role
  - reject reverts the role
  - INVALID_STATUS
  - user list includes balance
- `schema.test.js`:
  - `SCHEMA_SQL` contains all 5 tables, `bookings_provider_slot_uniq ... WHERE status <> 'cancelled'`, and `balance_after >= 0`
  - `migrate` with a fake pool sends BEGIN, the advisory lock, every statement, and COMMIT
- `health.test.js`: kept as is.

**B:**
- `slots.test.js` covers `computeSlots` as a pure function:
  - weekday mapping
  - 60-minute stepping and a partial tail dropped
  - multiple rows
  - past slots removed
  - booked slots marked unavailable
  - cancelled bookings free the slot
  - date outside the horizon gives 400
- `credits.test.js`:
  - top-up credits the balance and writes `balance_after`
  - the idempotency key replays
  - PAYMENT_FAILED with `createSimulatedPaymentProvider({fail:true})`
  - adjust rejects going negative
  - `applyLedgerEntry` rollback: the memory tx restores state when a later step throws
  - the ledger is ordered and `balanceAfter` is a running sum
- `bookings.test.js`:
  - booking debits the price
  - 402 when the balance is short
  - SELF_BOOKING
  - SLOT_UNAVAILABLE for an off-grid time
  - two concurrent `POST /bookings` for the same slot: exactly one 201 and one 409, and only one debit
  - cancel at 25h gives a full refund
  - cancel at 23h gives no refund
  - provider cancel gives a refund
  - cancel after the start gives 409
  - complete before the end gives 409
  - complete after the end pays `floor(price*0.8)` with fee 20, and respects `PLATFORM_FEE_PCT=10`
  - completing twice gives 409, with no double payout
  - access control on GET/cancel/complete
- `payments.test.js`: simulated provider success and failure shapes.
- `pg.integration.test.js`:
  - skipped unless `TEST_DATABASE_URL` is set
  - runs `migrate` twice to confirm it is idempotent
  - concurrent booking race on the real unique index
  - `FOR UPDATE` prevents a negative balance under 10 parallel bookings

**C:**
- `frontend.test.js` imports `public/js/router.js` and `public/js/format.js` in Node. It covers:
  - `parseHash` and `matchRoute` with params and query
  - `escapeHtml`
  - `formatDubai('2026-01-01T06:00:00Z')` contains `10:00`
  - `aed(25)` gives `125 AED`
  - `GET /` serves HTML containing `id="app"`
  - every view file listed in §6 exists and exports `render`
- Frontend modules must not use DOM globals at import time.

## 8. Dependencies and scripts (A)

Add only `"bcryptjs": "^2.4.3"` to `dependencies`. A runs `npm install bcryptjs@^2.4.3` so that `package-lock.json` updates. No other runtime or dev dependencies are added.

Leave `mongodb` and `db.js` Mongo support untouched.

Set:
```json
"lint": "find src public/js test -name '*.js' -print0 | xargs -0 -n1 node --check"
```
`test` stays `node --test`. Add `SESSION_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `PLATFORM_FEE_PCT=20` and `CREDIT_PRICE_AED=5` to `.env.example`, with placeholder values only.

## 9. Notes from B (implemented behaviour)

- Slot objects from `computeSlots`/`getSlots` are `{startsAt: Date, endsAt: Date, available}`; `computeSlots` also accepts an optional `horizonDays` (default 60; `getSlots` passes `config.bookingHorizonDays`).
- `POST /bookings`: a slot that exists but is already booked gives 409 SLOT_TAKEN; past, off-grid or out-of-horizon times give 422 SLOT_UNAVAILABLE.
- `GET /bookings?scope=upcoming` defaults to `status=confirmed` when `status` is not given; other scopes return all statuses, newest first (upcoming is soonest first).
- `src/credits.js` also exports `parsePaging(query)` (400 on a bad `limit`/`offset`), used by B's routers.
- B's tests live in `test/b-*.test.js` (+ `test/b-support.js`); the Postgres test is `test/b-pg.test.js` and runs only with `TEST_DATABASE_URL`.
