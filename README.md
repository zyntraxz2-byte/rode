# Rode

Bookings, ledger and client-inspo app for a nail studio, with a real backend: shared data, sign-in, and an admin who creates users and controls what each person can access.

Stack: Node 20+ (tested on 22), Express, SQLite (`better-sqlite3`, WAL), vanilla JS frontend served by the same process. Three runtime dependencies: `express`, `better-sqlite3`, `helmet`.

## Run it

```bash
npm install
cp .env.example .env        # optional; set ADMIN_PASSWORD
npm start                   # http://localhost:3000
```

First start creates the database in `./data` and an administrator (`admin`). If `ADMIN_PASSWORD` is empty, a random password is **printed once in the server log** and you must change it at first sign-in. Locked out later: `npm run create-admin -- <username> [password]`.

Docker: `docker compose up -d --build` (data in the `rode-data` volume). Not exercised in the build environment, so check the first build on your side.

Tests: `npm test` (57 API tests: auth, password reset, PWA files, permissions, bookings, payments, uploads, sample data, quick book with a mocked upstream). Browser smoke test: `python3 scripts/e2e-smoke.py` (needs `pip install playwright && playwright install chromium`).

## Users, roles and access

Admins manage people in the **Users** tab: add a user, choose a role, tune per-section access, set or generate a temporary password (shown once, with a copy button), edit, reset password, deactivate, delete.

| Role | Preset | What they can do |
|---|---|---|
| Administrator | everything | all of the below + manage users |
| Team member | overview read, bookings/inspo/money write, setup read | run the day; each section can be tuned to none / view / edit |
| View only | read everything | look, never change |
| **Customer** | bookings: own, inspo: own, rest none | sign in, book from the service menu, cancel their own upcoming bookings, attach photos to their own bookings. They never see other clients, money, balances or setup |

Section levels: `none`, `own` (only records they created; customers), `read`, `write`. Admins can narrow a customer (for example no photo uploads) but cannot widen one beyond customer limits; the server rejects it.

Customer-specific server rules: name is forced to the account name; price and duration come from the service menu (spoofed values are ignored); no custom services; no past times; they cannot override a clash and get an opaque "time no longer available" (no names leaked); capped at 20 upcoming bookings (`CUSTOMER_MAX_ACTIVE_BOOKINGS`); others' bookings return 404.

Permission changes apply on the next request; the open page picks them up within ~5 s. Deactivating or resetting a user signs them out everywhere. The last active admin cannot be demoted, deactivated or deleted, and admins cannot do that to themselves.

## Password reset by email

Set `SMTP_HOST`, `MAIL_FROM` and `PUBLIC_URL` (plus `SMTP_USER`/`SMTP_PASS`) and a **Forgot password?** link appears on the sign-in page. A user enters their username or email; the mail goes to the email saved on their account (admins set it in the Users tab) or to their username if that is an email address.

- The response is always the same, so it never reveals whether an account exists. Limits: 10 requests/hour per IP, 3 mails/hour per account.
- Links are random 256-bit tokens, stored only as a hash, valid 60 minutes (`RESET_TOKEN_MINUTES`), single use, and only the newest link per account works. The token sits in the URL fragment (`/#reset=…`), so it never reaches server logs or Referer headers.
- Setting a new password signs the account out everywhere; an admin reset or a password change voids any outstanding link.
- Link host comes from `PUBLIC_URL`, never from the request `Host` header (prevents reset-link poisoning). Production refuses to start with SMTP set but no `PUBLIC_URL`.
- Without SMTP in development the link is written to the server log; in production the feature is hidden.

## Install as an app (PWA)

Rode is an installable web app: open it over HTTPS (or `localhost`) and use the browser's **Install** / **Add to Home Screen**. A service worker (`public/sw.js`) caches only the app shell so it opens offline with a friendly offline page. Bookings, takings and photos (`/api`, `/_blob`) are never cached. Regenerate icons with `node scripts/make-icons.js`.

## Architecture

```
browser (public/: index.html, app.css, app.js)
   │  JSON over HTTPS, httpOnly session cookie, X-Requested-With header
   ▼
Express app (src/app.js)  ── helmet CSP, request id + JSON logs, rate limits, CSRF guard
   ├─ routes/auth.js   login, logout, me, change password, forgot/reset password
   ├─ routes/users.js  admin-only user management
   ├─ routes/data.js   state, sync, appts, txns, settings, sample, quick-parse, assets
   └─ GET /_blob/:id   authenticated photo download (same rules as the booking)
services/*  business rules + permission checks (the only layer that touches SQL)
SQLite (data/rode.db, WAL)  +  data/uploads/<id> for photos
```

Data flow: the UI loads `GET /api/state` (already filtered to what the user may see), then polls the tiny `GET /api/sync` every 5 s and reloads only when the global revision (or the user's own record) changed. Every write bumps the revision inside the same transaction.

Key decisions
- Money is stored as integer minor units, never floats.
- Payments are atomic server-side (`/appts/:id/pay` writes the income row and marks the booking in one transaction; undo and delete reverse it). The original frontend did this as two separate writes.
- Passwords: scrypt (N=16384) with per-user salt, timing-equalised login, policy (10+ chars, not common, not containing the username). Sessions: 256-bit random token, only its SHA-256 is stored; 7-day idle / 30-day absolute expiry.
- Login throttling per IP+username (default 8 failures / 15 min) and per IP, so an attacker cannot lock the real admin out from another address.
- CSRF: SameSite=Lax cookie + required `X-Requested-With` header + Origin / Sec-Fetch-Site checks.
- Uploads: magic-byte sniffing (JPEG/PNG/GIF/WebP only, never trusts the declared type), size cap, per-user quota, random file names, served with `sandbox` CSP; orphaned uploads are swept after 24 h.
- Strict CSP (`script-src 'self'`), no inline scripts, `frame-ancestors 'none'`.
- Structured JSON logs with request ids; `/healthz`, `/readyz`; graceful shutdown with WAL checkpoint.

## Operations

- **Backups:** `npm run backup` (online-safe SQLite backup + photos, keeps 14). Run it from cron/systemd and copy off the machine. Restore = stop the app, put `rode.db` and `uploads/` back in `DATA_DIR`.
- **HTTPS:** terminate TLS at a reverse proxy, then set `TRUST_PROXY=1`, `ENABLE_HSTS=true`. `COOKIE_SECURE=auto` then sets the Secure flag. Pass the `Host` header through. 
- **Time zone:** the server decides "today" using `APP_TIMEZONE` (default Asia/Colombo). The page uses the browser's clock for display, so run the server in the same zone as the studio.
- **Upgrades:** schema migrations run automatically at start (`src/db.js`, append-only).

## Trade-offs and limits (stated assumptions)

- Single process with SQLite is right for one studio (thousands of bookings). For multiple app instances you would move rate-limit state to Redis and SQLite to Postgres; the service layer is the only place to change.
- Polling instead of WebSockets/SSE: simpler through proxies, at most ~5 s staleness. Fine for a salon; SSE is the upgrade path.
- `/api/state` returns the whole ledger each time. Fine for years of one salon's data; add date-range pagination if you outgrow it.
- No self-service signup (customers are created by the studio). "Forgot password?" works only when SMTP is configured (see `.env.example`); otherwise the admin resets passwords from the Users tab.
- Quick book (speak/type a booking) is optional and server-side: it needs `ANTHROPIC_API_KEY` and is hidden otherwise. It was tested against a mocked upstream only; set `ANTHROPIC_MODEL` if your account uses a different model id.
- "Customer" is interpreted as a studio client who logs in to book for themselves. If you meant something else (for example customers who also see their payment history), it is a one-line change in `src/permissions.js`.

## Frontend changes (from `rode-standalone.html`)

Added: sign-in, forced first-login password change, account dialog, Users admin tab, permission-aware navigation/forms/buttons, customer booking mode, live sync.
Fixed:
- Data layer rewritten from `localStorage` / the `window.claude` runtime to the API; split into `index.html`, `app.css`, `app.js` so a strict CSP works.
- Marking a booking paid was two non-atomic writes (could leave income with an unpaid booking); now one server transaction.
- Rebooking a cancelled/no-show appointment ignored double-booking; now checked with a confirm step.
- Failed bookings left uploaded photos orphaned; they are now discarded.
- Transparent PNGs turned black when resized to JPEG; now flattened on white.
- CSV export allowed spreadsheet formula injection (`=`, `+`, `-`, `@` cells); now neutralised. Added UTF-8 BOM so Excel shows names correctly.
- Record ids were inserted into HTML attributes unescaped; now escaped (ids are also validated server-side).
- A non-string `time` from the quick-book parser could throw; guarded.
- Removing the last team member left bookings with no valid staff; now blocked.
- Private data is wiped from the DOM on sign-out.
