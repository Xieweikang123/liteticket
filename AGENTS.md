# AGENTS.md

Guidance for AI coding agents working in this repository. For what the project *is*, read
[README.md](README.md) — this file covers how to work in it.

## Working agreement

### Ask before a task grows into tooling work

The failure mode this guards against: a small, well-understood change quietly turns into building
infrastructure to complete it — scaffolding a harness, writing a throwaway script, working around an
environment limitation — and the user's time is spent on the agent's convenience rather than on
their request.

**When the task starts expanding, stop and ask.** Put the choice in front of the user with a
recommendation and an estimate, rather than deciding unilaterally:

> 截图被沙箱挡住了。三个选择:
> **A.** 我直接改代码,你自己刷新看 —— 最快
> **B.** 我花几分钟绕过限制,拿到截图和自动化验证
> **C.** 你先解除沙箱限制,我再顺手验证
>
> 你要哪个?

Triggers — any of these means "ask first":

- Building a harness, driver, or test rig **in order to** make the change (not as the deliverable).
- Writing a one-off script the user did not ask for.
- Working around a sandbox, permission, port, or environment restriction.
- The same operation has failed twice; do not silently try a third variation.
- You are about to modify a dependency (e.g. inside `node_modules`) to unblock yourself.
- You notice you have been working for a while without producing anything the user asked for.

Not triggers — just do the work:

- The change itself, however large, when the path is known.
- Running the project's existing verification (`scripts/verify.mjs`, `scripts/probe-ui.mjs`).
- Reading files, searching, typechecking, and building.

### Prefer shipping the change over self-verification

Self-verification is worth it when it is cheap and the repo already provides it. It is not worth
building from scratch. If the user can see the result by refreshing a page in a second, hand it over
and let them look — do not spend their time constructing a way for *you* to look first.

### Ask before touching things that are the user's, not the repo's

Killing or restarting a running server, deleting a database, changing a global config, or committing
without being asked. A dev server that is already running is probably the user's; if the port is
taken, say so rather than killing the process.

### Be honest about what was verified

State plainly what was checked and what was not. Do not describe something as verified on the basis
of it having compiled. If a claim came from reasoning rather than execution, say so.

## Project conventions

### Architecture rules that matter

- **`/api/*` is the only interface.** The React client is just another consumer. The UI must not be
  able to do anything the API cannot — if a feature needs a new server capability, add the endpoint.
- **`src/services/tickets.ts` is the single source of truth for business rules.** Both the HTTP
  routes and anything else call into it. Do not put business logic in `src/routes/api.ts`.
- **Internal notes are excluded at the query level, not filtered in a view,** so they cannot leak
  through an endpoint that forgot to check. Preserve this when touching comments.
- **Auth is bearer-token only.** A user-bound token carries that user's role, read live per request,
  so role changes take effect immediately. The last admin cannot be demoted or deleted.
- The server holds no rendering logic and no session state.

### Code style

- ESM, TypeScript, `strict`. Two tsconfigs: `tsconfig.json` (server) and `tsconfig.web.json` (client).
- Comments explain **why**, not what. The existing code comments the reasoning behind non-obvious
  decisions (see `src/auth.ts`, `web/src/auth.tsx`); match that register and do not narrate
  self-evident code.
- UI copy is **Chinese**; code, identifiers, and comments are English. Keep both consistent — a
  user-facing English string in the Chinese UI is a bug.
- Prefer no new dependencies. The project deliberately ships without an icon library, a CSS
  framework, or a state manager.

### Layout

```
src/
  app.ts              route composition and static serving
  server.ts           bootstrap: seed admin, seed token, listen
  auth.ts             password hashing, token mint/verify
  routes/api.ts       the only HTTP surface (JSON)
  services/tickets.ts business rules — the single source of truth
web/
  src/api.ts          typed client, the one place the token is attached
  src/auth.tsx        session state, validated against /api/auth/me
  src/styles.css      all styling; scoped class prefixes per surface
  src/pages/          tickets, ticket detail, users, tokens, login
```

## Verification

Run what the repo already provides; do not invent a new layer.

```bash
pnpm typecheck                                                          # server
npx tsc --noEmit -p tsconfig.web.json                                   # client
pnpm build                                                              # API to dist/, client to web/dist
node scripts/verify.mjs <token> [baseUrl] [adminUsername] [adminPassword]  # 81 API checks
node scripts/probe-ui.mjs [baseUrl]                                     # 39 browser checks
```

- `probe-ui.mjs` needs a **running server** and the seeded admin credentials (default
  `admin` / `1`; override with `PROBE_USERNAME` / `PROBE_PASSWORD`).
- The client is served from `web/dist` by the API server. **A client change requires
  `pnpm build:web` before a browser check will see it** — the server does not rebuild on its own.
- The seeded admin default (`admin` / `1`) is safe to use in local checks.

### Environment notes

- `pnpm dev` needs to spawn `esbuild`, which requires named pipes. In a restricted sandbox this
  fails with `spawn EPERM`, and Playwright's default Chrome launch fails the same way. This is an
  environment limit, not a project bug — **report it and ask, do not patch `node_modules`.**
- `pnpm build` and the production server (`node bin/liteticket.js`) avoid `esbuild` at runtime and
  generally work where `pnpm dev` does not.
- `data/*.db-wal` is touched on every request, which is why the API watcher is scoped to
  `--include src/**/*`. Do not widen it.
