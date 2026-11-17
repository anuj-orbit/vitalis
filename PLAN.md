# Vitalis: online yoga/fitness trainer and doctor marketplace (credits)

slug: vitalis | db: vitalis (Postgres) | repo anuj-orbit/vitalis

## Goal / audience
Marketplace to empanel yoga/fitness trainers and doctors for online classes and consultations. Consumers buy credits (1 credit = 5 AED) and spend them on bookings.

## Roles
- Consumer: sign up, browse/filter providers, buy credits, book a slot, join session, cancel, review history
- Provider (trainer or doctor): apply with credentials, set profile, price in credits per session, weekly availability, see bookings, earnings in credits
- Admin: review/approve/reject applications, view users, bookings, credit ledger, manually adjust credits

## Pages
Public: home, provider directory (filter by type: yoga, fitness, doctor; specialty), provider profile, login/register, provider application
Consumer: dashboard (balance, upcoming), buy credits, book, my bookings, transactions
Provider: dashboard, profile and availability, bookings, earnings
Admin: applications queue, users, bookings, ledger

## API (JSON, session-cookie auth, bcrypt, CSRF-safe via SameSite + JSON-only)
auth (register, login, logout, me); providers (list, detail, apply, update profile, availability); slots; bookings (create, cancel, list); credits (balance, top-up, ledger); admin (applications, approve/reject, users, adjust credits); GET /health

## Data model (Postgres, auto-migrated at startup)
users(id, email unique, password_hash, name, role[consumer|provider|admin], created_at)
providers(id, user_id, kind[yoga|fitness|doctor], specialty, bio, credentials, license_no, price_credits, status[pending|approved|rejected], created_at)
availability(id, provider_id, weekday, start_time, end_time)
credit_ledger(id, user_id, delta, reason[topup|booking|refund|payout|adjust], booking_id, balance_after, created_at) (append-only; balance derived/checked transactionally)
bookings(id, consumer_id, provider_id, starts_at, duration_min, price_credits, status[confirmed|cancelled|completed], meeting_url, created_at)
Rules: 1 credit = 5 AED (constant 500 fils); booking debits consumer atomically (row lock, no negative balance, no double-booking of a slot); cancel 24h+ before = full refund, later = no refund; on completion provider is credited 80% (platform keeps 20%, configurable via env PLATFORM_FEE_PCT).
Top-up: simulated gateway behind a PaymentProvider interface (credits packs 10/25/50/100; shows AED amount); Stripe swap-in later.
Meeting: Jitsi link `https://meet.jit.si/vitalis-<random>` generated per booking.
Medical disclaimer shown on doctor pages (not for emergencies).
Seed: admin from env ADMIN_EMAIL/ADMIN_PASSWORD at first start.

## Stack
Node 22 + Express, pg, bcryptjs, express-session with connect-pg-simple (or signed cookie JWT), vanilla HTML/CSS/JS SPA-lite in public/, rate limits, parameterised queries.

## Team (complex)
1. lead-deep: architecture and API contract only (docs/ARCHITECTURE.md)
2. then 3 lead: (a) backend auth+providers+admin, (b) backend credits+bookings+payments, (c) frontend
Workers: DeepSeek for code/tests.

## Acceptance
lint + tests pass in CI; transactional tests for credits/booking logic with fake/in-memory store; works on live DB; no secrets in git; /health ok after deploy.

## Estimated cost
About 2.00-3.50 USD (limit 5 USD; will pause at 4.00)
