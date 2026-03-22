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

## Deployment

```bash
cd api
npm run deploy
```

The API deploys to Cloudflare Workers with a D1 database. Configure environment variables in `wrangler.toml` or the Cloudflare dashboard:

- `JWT_SECRET` — signing key for auth tokens
- `GOOGLE_CLIENT_ID` — for Google OAuth
- `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUDIENCE` — for Cloudflare Access service tokens

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, React Router 7, Tailwind CSS 4, Lucide icons, Vite |
| Backend | Hono, Zod + OpenAPI, Drizzle ORM |
| Database | Cloudflare D1 (SQLite) |
| Auth | JWT, Google OAuth, Cloudflare Access |
| Deployment | Cloudflare Workers |
