# liteticket

A lightweight, API-first ticketing system. One command to run.

> **Status: v0.1 in progress.** Ticket CRUD, comments, tags, assignment, and the
> REST API all work. Email notification is not built yet.

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
| Runtime | Node.js (>= 20.11), ESM | No build step needed to run from source |
| HTTP | [Hono](https://hono.dev) | ~14KB, Web-standard APIs, returns JSON *and* HTML |
| UI | Server-rendered JSX + [htmx](https://htmx.org) | No frontend build, no SPA framework, ~16KB gzipped |
| Data | [Drizzle ORM](https://orm.drizzle.team) + SQLite | Typed SQL, migrations as plain `.sql` files |
| Validation | [Zod](https://zod.dev) | One schema per endpoint, at the boundary |

The UI and the API are the same operations with two renderings: `/ui/*` returns HTML for the
browser, `/api/*` returns JSON for programs. Both call one service layer, so the API cannot quietly
drift away from what the UI can do.


## Non-goals

What this project will not do is as important as what it will. These are deliberate omissions, not
missing features:

- CMDB / asset management
- Change management
- Multi-tenant SaaS UI
- Complex SLA engines
- Knowledge base
- Telephony / IVR integration

If you need those today, use [Zammad](https://zammad.org/), [OTRS](https://otrs.com/), or
[GLPI](https://glpi-project.org/). They are good at it. `liteticket` is not trying to be them.

## Roadmap

### v0.1 — the minimum that is actually useful

- [x] Ticket CRUD, list, and detail views
- [x] Status flow: open / pending / closed
- [x] Priority and tags
- [x] Assignment to a user
- [x] User management (create / edit / delete)
- [x] Login with roles — admin / agent
- [x] Comments — internal note and public reply
- [x] REST API with token or session auth
- [ ] Email notification on create / assign / reply
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
database, starts the server, and opens your browser.

```
  liteticket 0.1.0
  web    http://127.0.0.1:8787
  api    http://127.0.0.1:8787/api
  db     ./data/liteticket.db

  First run: an API token will be printed below. Save it —
  it is shown once and stored only as a hash.
```

The web UI requires a login. On first boot an admin is seeded from
`LITETICKET_ADMIN_EMAIL` / `LITETICKET_ADMIN_PASSWORD` (default
`admin@localhost` / `1`); the banner prints it once. **Change the password, and
set the env var, before exposing the server on a network.**

The API accepts either the bearer token or a logged-in session cookie.

```bash
curl http://127.0.0.1:8787/api/tickets \
  -H "Authorization: Bearer $TOKEN"
```

### Other ways to run

| Command | What it does |
|---|---|
| `pnpm dev` | Watch mode, picks a free port, opens the browser |
| `pnpm dev:no-open` | Same, without opening a browser |
| `pnpm reset` | Delete the database and start fresh (new token) |
| `pnpm build && pnpm start` | Compile to `dist/` and run the compiled output |
| `node bin/liteticket.js` | Runs `dist/` if built, otherwise the TypeScript source |

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | HTTP port; the launcher walks forward if it is taken |
| `HOST` | `127.0.0.1` | Bind address; set `0.0.0.0` to expose on the LAN |
| `LITETICKET_DB` | `./data/liteticket.db` | SQLite file path |
| `LITETICKET_TOKEN` | generated | Use a known API token instead of a generated one |
| `LITETICKET_ADMIN_EMAIL` | `admin@localhost` | Seed admin's email |
| `LITETICKET_ADMIN_PASSWORD` | `1` | Seed admin's password — **set this in production** |

## API

Every route below requires either `Authorization: Bearer <token>` or a logged-in
session cookie, except `/api/health`. A bearer token carries admin rights; a
session is limited to its user's role. Routes marked **admin** reject sessions
without the admin role.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/health` | Public |
| `GET` | `/api/tickets` | `status`, `assigneeId`, `tag`, `q`, `limit`, `offset` |
| `GET` | `/api/tickets/:id` | `?includeInternal=true` to include internal notes |
| `POST` | `/api/tickets` | `subject`, `requesterEmail` required |
| `PATCH` | `/api/tickets/:id` | `status`, `priority`, `assigneeId`, `tags`, … |
| `DELETE` | `/api/tickets/:id` | **admin** |
| `GET` | `/api/tickets/:id/comments` | internal notes hidden unless requested |
| `POST` | `/api/tickets/:id/comments` | `isInternal: true` for an internal note |
| `GET` | `/api/users` · `/api/users/:id` | |
| `POST` | `/api/users` | **admin**; `email`, `name`, optional `role`, `password` |
| `PATCH` | `/api/users/:id` | **admin**; `email`, `name`, `role`, `password` |
| `DELETE` | `/api/users/:id` | **admin**; unassigns their tickets rather than deleting history |
| `GET` | `/api/tags` · `/api/stats` | |

The last admin cannot be demoted or deleted, so the instance cannot lock itself
out.

Internal notes are excluded at the query level, not filtered in a view, so they cannot leak through
an endpoint that forgot to check.

## Development

```bash
pnpm dev          # run from source, reload on change
pnpm typecheck    # tsc --noEmit
pnpm build        # compile to dist/
pnpm reset        # wipe the database and start over
pnpm db:generate  # regenerate migrations after editing src/db/schema.ts
pnpm db:studio    # browse the database
```

Verify a running instance end to end:

```bash
node scripts/verify.mjs <token>
```


## Contributing

Early days — the architecture is still moving. Issues and design feedback are welcome now;
large pull requests are better once v0.1 lands.

## License

MIT — see [LICENSE](LICENSE).
