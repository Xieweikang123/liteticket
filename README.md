# liteticket

A lightweight, API-first ticketing system. One command to run.

> **Status: v0.1 done.** Ticket CRUD, comments, tags, assignment, custom roles
> and permissions, and the REST API all work. Email notification is a non-goal —
> see below.

## What this is

Most open-source ticketing systems are heavy. They ship with CMDB, change management, SLA engines,
knowledge bases, and telephony integrations — and a deployment guide you need an afternoon to read.

`liteticket` goes the other way. It is built for people who want a ticket system, not a platform:

- **One command to run.** No Redis, no Elasticsearch, no worker fleet.
- **API-first.** Every action in the UI is available over the API. Build on it, embed it, script it.
- **Boring on purpose.** SQLite by default, Postgres when you outgrow it.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js (>= 20.11), ESM | Runs from source with no compile step |
| HTTP | [Hono](https://hono.dev) | ~14KB, Web-standard APIs, pure JSON API |
| UI | [React 19](https://react.dev) + Vite | Typed components, client-side routing |
| Data | [Drizzle ORM](https://orm.drizzle.team) + SQLite | Typed SQL, migrations as plain `.sql` files |
| Validation | [Zod](https://zod.dev) | One schema per endpoint, at the boundary |
| Auth | Bearer tokens | One credential for both the UI and scripts |

There is exactly one interface: `/api/*` returns JSON and requires a bearer token. The React client
is just another consumer of it, so the UI and the API cannot drift apart — the UI has no way to do
something the API cannot.

The server holds no rendering logic and no session state. `src/services/tickets.ts` is the only
place business rules live, and both surfaces call it.


## Non-goals

What this project will not do is as important as what it will. These are deliberate omissions, not
missing features:

- CMDB / asset management
- Change management
- Multi-tenant SaaS UI
- Complex SLA engines
- Knowledge base
- Telephony / IVR integration
- **Outbound email** — no notification on create / assign / reply, and no SMTP configuration

If you need those today, use [Zammad](https://zammad.org/), [OTRS](https://otrs.com/), or
[GLPI](https://glpi-project.org/). They are good at it. `liteticket` is not trying to be them.

Email is a deliberate omission rather than an unfinished item. Sending mail means an SMTP
dependency, credentials to store, retries, bounce handling, and a template per event — a large
surface that would stop this from being a system you can run with one command. Agents see new work
in the ticket list; the API is there if you want to wire up a notifier of your own.

## Roadmap

### v0.1 — the minimum that is actually useful

Everything here is done.

- [x] Ticket CRUD, list, and detail views
- [x] Status flow: open / pending / closed
- [x] Priority and tags
- [x] Assignment to a user
- [x] User management (create / edit / delete)
- [x] Login with roles — admin / agent
- [x] Custom roles and a fixed permission catalog
- [x] Comments — internal note and public reply
- [x] REST API with bearer-token auth
- [x] Self-service API tokens (mint and revoke your own)
- [x] Menu management — the nav is data, scoped by permission
- [x] Web UI that works without configuration

### Later

- [ ] Attachments
- [ ] Full-text search (SQLite FTS5 is the obvious route)
- [ ] Postgres support
- [ ] Webhooks
- [ ] i18n

## Quick start

```bash
pnpm install
pnpm dev
```

That is the whole thing. `pnpm dev` checks dependencies, picks a free port, creates and migrates the
database, starts the API and the Vite dev server together, and opens your browser.

```
  liteticket 0.1.0
  web    http://127.0.0.1:5173
  api    http://127.0.0.1:8787/api
  db     ./data/liteticket.db

  First run: an admin login and an API token will be printed below.
  Save the token — it is shown once and stored only as a hash.
```

In development the browser talks to the Vite server, which proxies `/api` to the API port — so
there is one origin and no CORS configuration.

On Windows, `start.bat` does the same thing on a double-click.

The web UI requires a login. On first boot an admin is seeded from
`LITETICKET_ADMIN_USERNAME` / `LITETICKET_ADMIN_PASSWORD` (default
`admin` / `1`); the banner prints it once. **Change the password, and set the
env var, before exposing the server on a network.** Changing a password revokes
every token issued under the old one.

The API accepts a bearer token, and nothing else:

```bash
curl http://127.0.0.1:8787/api/tickets \
  -H "Authorization: Bearer $TOKEN"
```

Logging in over the API returns a token bound to your user, which inherits your
role:

```bash
curl -X POST http://127.0.0.1:8787/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"1"}'
```

Tokens for scripts are also available from **我的 Token** in the UI, so nobody
has to read the server console to get one.

### Other ways to run

| Command | What it does |
|---|---|
| `pnpm dev` | API + Vite together, picks free ports, opens the browser |
| `pnpm dev:no-open` | Same, without opening a browser |
| `pnpm reset` | Delete the database and start fresh (new token) |
| `pnpm build && pnpm start` | Build the client and API, then serve both from one port |
| `node bin/liteticket.js` | Runs `dist/` if built, otherwise the TypeScript source |

`pnpm dev` runs two processes. For a single-process deployment, run
`pnpm build` once and then `pnpm start`: the API serves the built client from
`web/dist`, including the fallback that keeps client-side routes working on a
hard refresh.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | API port; the launcher walks forward if it is taken |
| `WEB_PORT` | `5173` | Vite dev-server port (dev only) |
| `HOST` | `127.0.0.1` | Bind address; set `0.0.0.0` to expose on the LAN |
| `LITETICKET_DB` | `./data/liteticket.db` | SQLite file path |
| `LITETICKET_TOKEN` | generated | Seed a known bootstrap token instead of a generated one |
| `LITETICKET_ADMIN_USERNAME` | `admin` | Seed admin's login username |
| `LITETICKET_ADMIN_EMAIL` | `admin@localhost` | Seed admin's email (contact field) |
| `LITETICKET_ADMIN_PASSWORD` | `1` | Seed admin's password — **set this in production** |

## API

Every route below requires `Authorization: Bearer <token>`, except `/api/health`
and `/api/auth/login`. A token bound to a user carries that user's role's
permissions, read live on each request — so a role edit takes effect
immediately. An unbound token is a machine credential and carries every
permission. Routes marked with a permission reject tokens that lack it.

The permission catalog is fixed in code (`tickets.read`, `tickets.write`,
`tickets.delete`, `users.read`, `users.manage`, `roles.manage`, `menus.manage`).
Roles are data: you can create, rename, and re-scope them, but you cannot invent
a permission the server does not check. The built-in `admin` and `agent` roles
are seeded from code on every boot and cannot be edited or deleted, which is what
keeps an upgrade from locking the instance out.

The top navigation is data too. Its tabs live in the `menus` table and are
scoped by permission: a tab with `permission: null` is visible to every signed-in
user, one gated on a permission is returned only to callers that hold it, and a
hidden row is returned to no one. `GET /api/menus` returns the caller's filtered
list (already safe to render); `GET /api/menus?all=true` returns every row for
the management page and requires `menus.manage`. Built-in tabs are reconciled
from code on boot: their `path` and `permission` are pinned to the route and the
permission the page actually enforces, but their label, order, and visibility
are yours to edit.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/health` | Public |
| `POST` | `/api/auth/login` | Public; returns a user-bound token |
| `GET` | `/api/auth/me` | Who the caller is; used to validate a stored token |
| `POST` | `/api/auth/password` | Change **your own** password (`currentPassword`, `newPassword`); revokes your tokens |
| `GET` | `/api/tickets` | `status`, `assigneeId`, `tag`, `q`, `limit`, `offset` |
| `GET` | `/api/tickets/:id` | `?includeInternal=true` to include internal notes |
| `POST` | `/api/tickets` | `subject`, `requesterEmail` required |
| `PATCH` | `/api/tickets/:id` | `status`, `priority`, `assigneeId`, `tags`, … |
| `DELETE` | `/api/tickets/:id` | **admin** |
| `GET` | `/api/tickets/:id/comments` | internal notes hidden unless requested |
| `POST` | `/api/tickets/:id/comments` | `isInternal: true` for an internal note |
| `GET` | `/api/users` · `/api/users/:id` | `users.read` |
| `POST` | `/api/users` | `users.manage`; `username`, `email`, `name`, optional `role`, `password` |
| `PATCH` | `/api/users/:id` | `users.manage`; `username`, `email`, `name`, `role`, `password` |
| `DELETE` | `/api/users/:id` | `users.manage`; unassigns their tickets rather than deleting history |
| `GET` | `/api/roles` | `users.read`; the role list |
| `GET` | `/api/permissions` | `users.read`; the fixed permission catalog |
| `POST` | `/api/roles` | `roles.manage`; `name`, `label`, `permissions[]` |
| `PATCH` | `/api/roles/:id` | `roles.manage`; `label`, `description`, `permissions[]` |
| `DELETE` | `/api/roles/:id` | `roles.manage`; only when no user holds it |
| `GET` | `/api/menus` | the caller's visible tabs (filtered by permission + visibility) |
| `GET` | `/api/menus?all=true` | `menus.manage`; every tab, including hidden ones |
| `POST` | `/api/menus` | `menus.manage`; `name`, `label`, `path`, `permission`, `sort` |
| `PATCH` | `/api/menus/:id` | `menus.manage`; label / sort / visible / permission (path pinned for built-ins) |
| `DELETE` | `/api/menus/:id` | `menus.manage`; custom menus only |
| `GET` | `/api/tokens` | your own tokens (never the secret) |
| `POST` | `/api/tokens` | mint one; the plaintext is returned **once** |
| `DELETE` | `/api/tokens/:id` | revoke one of your own |
| `GET` | `/api/tags` · `/api/stats` | |

The last user holding `roles.manage` cannot be moved off that permission, and a
role still assigned to users cannot be deleted, so the instance cannot lock
itself out. Built-in roles are reconciled from code on boot; a new permission is
granted to `admin` automatically.

Internal notes are excluded at the query level, not filtered in a view, so they cannot leak through
an endpoint that forgot to check.

## Development

```bash
pnpm dev          # API + Vite, reload on change
pnpm typecheck    # tsc --noEmit for the server
pnpm build        # compile the API to dist/ and build the client to web/dist
pnpm reset        # wipe the database and start over
pnpm db:generate  # regenerate migrations after editing src/db/schema.ts
pnpm db:studio    # browse the database
```

Verification runs at two levels, because HTTP checks cannot catch a client that
renders a blank page:

```bash
node scripts/verify.mjs <token> [baseUrl] [adminUsername] [adminPassword]  # API checks
node scripts/probe-ui.mjs [baseUrl]                                      # browser checks
```

`probe-ui.mjs` drives a real browser (Playwright, using the installed Chrome) through login, ticket
creation, status changes, replies, internal notes, token minting, menu editing, the agent role,
logout, and deep links. It needs the seeded admin's credentials; set `PROBE_USERNAME` /
`PROBE_PASSWORD` when they are not the defaults (`admin` / `1`).

### Layout

```
src/
  app.ts              route composition and static serving
  server.ts           bootstrap: seed admin, seed token, listen
  auth.ts             password hashing, token mint/verify, SYSTEM_ROLES
  config.ts           environment
  time.ts             one timestamp format (ISO-8601 UTC) for SQL and JS
  db/                 schema, connection, migrations
  routes/api.ts       the only HTTP surface (JSON)
  services/tickets.ts business rules — the single source of truth
web/
  src/api.ts          typed client, the one place the token is attached
  src/auth.tsx        session state + permissions from /api/auth/me, and the nav
  src/pages/          tickets, ticket detail, users, roles, menus, tokens, account, login
```

## Contributing

Early days — the architecture is still moving. Issues and design feedback are welcome now;
large pull requests are better once v0.1 lands.

## License

MIT — see [LICENSE](LICENSE).
