# liteticket

A lightweight, API-first ticketing system. One command to run.

> **Status: early development.** Nothing works yet. Watch this repo or check the roadmap below.

## What this is

Most open-source ticketing systems are heavy. They ship with CMDB, change management, SLA engines,
knowledge bases, and telephony integrations — and a deployment guide you need an afternoon to read.

`liteticket` goes the other way. It is built for people who want a ticket system, not a platform:

- **One command to run.** No Redis, no Elasticsearch, no worker fleet.
- **API-first.** Every action in the UI is available over the API. Build on it, embed it, script it.
- **Boring on purpose.** SQLite by default, Postgres when you outgrow it.

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

- [ ] Ticket CRUD, list, and detail views
- [ ] Status flow: open / pending / closed
- [ ] Priority and tags
- [ ] Assignment to a user
- [ ] Comments — internal note and public reply
- [ ] REST API with token auth
- [ ] Email notification on create / assign / reply
- [ ] Web UI that works without configuration

### Later

- [ ] Attachments
- [ ] Full-text search
- [ ] Postgres support
- [ ] Webhooks
- [ ] i18n

## Quick start

Not available yet. This section will be filled in when v0.1 ships.

## Contributing

Early days — the architecture is still moving. Issues and design feedback are welcome now;
large pull requests are better once v0.1 lands.

## License

MIT — see [LICENSE](LICENSE).
