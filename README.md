# Trips

A travel itinerary management app for organizing group trips. Plan flights, lodging, restaurants, activities, and more — with role-based access so trip owners control who can view or edit.

## Architecture

Monorepo with two packages:

- **`web/`** — React 19 SPA (Vite, Tailwind CSS, React Router)
- **`api/`** — Hono REST API on Cloudflare Workers (D1 SQLite, Drizzle ORM)

The web app proxies `/api` requests to the API server during development.

## Getting Started

### Prerequisites

- Node.js 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm i -g wrangler`)

### Setup

```bash
# Install dependencies
cd api && npm install
cd ../web && npm install
```

### Database

```bash
cd api

# Generate migrations from schema
npm run db:generate

# Apply migrations locally
npm run db:migrate:local

# (Optional) Open Drizzle Studio
npm run db:studio
```

### Development

Run both servers in separate terminals:

```bash
# Terminal 1 — API (port 8787)
cd api
npm run dev

# Terminal 2 — Web (port 5173)
cd web
npm run dev
```

Open http://localhost:5173. The first registered user is automatically an admin.

## Roles & Permissions

### Global roles (set by admins)

| Role | Access |
|---|---|
| **admin** | Full system access, user management |
| **editor** | Can be granted edit access to trips |
| **viewer** | Default for new/invited users |

### Trip-level roles (per participant)

| Role | Can do |
|---|---|
| **Owner** | Full control — edit trip, manage participants & invites, CRUD all items |
| **Editor** | CRUD itineraries, expenses, documents. Cannot manage participants or invites |
| **Viewer** | Read-only. Sensitive fields (confirmation numbers, ticket numbers) are stripped from API responses via dedicated view schemas |

## Data Model

All trip content is stored in a single `itineraries` table with type-specific JSON content:

- **Flight** — supports multiple legs, per-leg seat assignments, timezone-aware times
- **Lodging** — check-in/check-out with planned arrival/departure
- **Rail** — train operator, stations, carriage/seat assignments
- **Car** — rental with driver roles per participant
- **Restaurant** — reservation time, party size
- **Transport** — buses, ferries, shuttles
- **Activity** — events with location and time

Other tables: `trips`, `participants`, `users`, `expenses`, `documents`, `invites`, `service_identities`.

## API

OpenAPI docs available at `/docs` when the API is running.

Key endpoint groups:

- `POST /auth/login` | `/auth/register` | `/auth/google` — authentication
- `GET/POST /trips` — trip CRUD
- `GET/POST/PUT/DELETE /trips/:tripId/itineraries` — itinerary management
- `GET/POST/PUT/DELETE /trips/:tripId/participants` — participant management (owners only)
- `GET/POST/DELETE /trips/:tripId/invites` — invite management (owners only)
- `GET/POST/PUT/DELETE /trips/:tripId/expenses` — expense tracking
- `GET/POST/PUT/DELETE /trips/:tripId/documents` — document attachments
- `GET/POST/PUT/DELETE /admin/*` — user & service identity management (admins only)

## Authentication & Access Control

Authentication is handled by Cloudflare Access with an External Evaluation rule that restricts access to known users only. New users can only be created through invite acceptance or account linking.

### How it works

1. **Known users** — the eval endpoint checks if the authenticating email exists in the `userEmails` table. If so, access is granted.
2. **Invite/link flow** — the eval endpoint checks the `request_url` claim from the CF Access JWT. If the path contains `/invite` or `/link`, unknown emails are allowed through. The app-level `jwtOnlyMiddleware` then validates the actual invite/link token before creating a user.
3. **Unknown users with no token** — blocked. External Evaluation returns `success: false` and CF Access denies access.

### Cloudflare Access configuration

Two CF Access applications are required:

| Application | Path | Policy | Purpose |
|---|---|---|---|
| Trips - Eval | `trips.prenticew.com/api/eval/*` | **Bypass** | Allows CF Access to call the eval endpoints without triggering another eval (no user auth, no AUD conflict) |
| Trips | `trips.prenticew.com` | **Allow — External Evaluation** | User-facing authentication with eval gate |

The External Evaluation rule on the "Trips" application should be configured with:

- **Evaluate URL**: `https://trips.prenticew.com/api/eval/evaluate`
- **Keys URL**: `https://trips.prenticew.com/api/eval/keys`

The eval endpoint uses the `request_url` claim in the CF Access JWT to determine whether to allow unknown users (for invite/link paths) or block them.

### Worker secrets

The eval endpoint signs response JWTs with an RSA private key. Generate and store it:

```bash
# Generate RSA key pair (PKCS#8 format required by jose)
openssl genpkey -algorithm RSA -out private.pem -pkeyopt rsa_keygen_bits:4096

# Store as Worker secret
cd api
npx wrangler secret put EXTERNAL_EVAL_PRIVATE_KEY < private.pem
```

### Environment variables

Configured in `wrangler.toml` under `[vars]`:

| Variable | Description |
|---|---|
| `CF_ACCESS_TEAM_DOMAIN` | Cloudflare Access team domain (e.g., `yourteam.cloudflareaccess.com`) |
| `CF_ACCESS_AUDIENCE` | Application Audience (AUD) tag from CF Access |
| `BOOTSTRAP_ADMIN_EMAIL` | Email that gets admin role on first login |
| `EXTERNAL_EVAL_KEY_ID` | Key ID for the eval JWKS (default: `eval-key-1`) |

Secrets (set via `wrangler secret put`):

| Secret | Description |
|---|---|
| `EXTERNAL_EVAL_PRIVATE_KEY` | RSA private key (PEM) for signing eval response JWTs |

## Deployment

Deployment is automated via GitHub Actions on push to `main`:

- **API** (`.github/workflows/deploy-api.yml`) — triggers on changes to `api/`, deploys to Cloudflare Workers
- **Web** (`.github/workflows/deploy-web.yml`) — triggers on changes to `web/`, deploys to Cloudflare Pages

GitHub Actions secrets required:

| Secret | Description |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Workers and D1 permissions |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `CLOUDFLARE_D1_DATABASE_ID` | D1 database ID (injected into `wrangler.toml` at deploy time) |
| `BOOTSTRAP_ADMIN_EMAIL` | Passed as a var override during API deploy |

Manual deploy:

```bash
cd api
npm run deploy
```

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, React Router 7, Tailwind CSS 4, Lucide icons, Vite |
| Backend | Hono, Zod + OpenAPI, Drizzle ORM |
| Database | Cloudflare D1 (SQLite) |
| Auth | JWT, Google OAuth, Cloudflare Access |
| Deployment | Cloudflare Workers |
