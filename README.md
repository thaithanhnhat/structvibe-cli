# StructVibe CLI

`sv` is the open, auditable client for StructVibe product-context repositories. It lets a person or coding agent clone project context, work on an isolated branch, validate deterministic UI source, push commits, and request review only when a branch is ready to merge.

The CLI is deliberately independent from the StructVibe web monorepo:

- no `workspace:*` dependencies
- no telemetry
- no background daemon
- no postinstall script
- no Git executable dependency and no access to `.git`
- no access to your application source repository unless you run it there
- one documented HTTPS/HTTP API surface
- a local copy of the repository validator used before every commit

## Install

Public releases are installed directly from a GitHub release artifact. This does not invoke Git:

```bash
npm install -g https://github.com/thaithanhnhat/structvibe-cli/releases/latest/download/structvibe-cli.tgz
```

For CLI contributors, a source checkout can be built and installed locally:

```bash
git clone https://github.com/thaithanhnhat/structvibe-cli.git
cd structvibe-cli
npm ci
npm run check
npm install -g .
```

Git is used only by contributors obtaining the CLI source. The installed `sv` runtime does not invoke Git. GitHub release artifacts move CLI package delivery away from the StructVibe application server; normal repository synchronization still uses the authenticated StructVibe API.

## Authenticate

For a personal machine, use the browser device flow:

```bash
sv auth login --server https://your-structvibe.example
```

The CLI prints a short code and opens StructVibe in your browser. After you approve the request, the CLI receives an expiring access token. The device code is only a short-lived login transaction; StructVibe does not track whether a machine is online or connected.

For CI or a headless machine, generate an access token in **Workspace > Repository access**, then pass it over stdin or through `STRUCTVIBE_TOKEN`:

```bash
printf '%s' "$STRUCTVIBE_TOKEN" | sv auth login --with-token --server https://your-structvibe.example
```

The credential is written to `~/.structvibe/credentials.json` with mode `0600`. The server stores only its hash and validates the Bearer token, scope, expiry, and revocation state on every repository request.

## Repository Workflow

```bash
sv clone my-project
cd my-project
sv switch -c feature/login

# Edit overview.md, screen HTML/CSS, tokens, or feature Markdown.
sv preview
sv check
sv diff
sv commit -m "Design commercial login flow"
sv push
sv mr create "Commercial login flow"
```

Tasks are operational records, not repository files:

```bash
sv task add "Implement login API" --screen SCR-001 --feature F-003
sv task
```

Branches are lightweight references to immutable commits. `sv branch -d <name>`
soft-deletes a merged branch for 30 days; `sv branch --restore <name>` recovers it.
Server maintenance removes only objects no longer reachable from an active branch
or merge request, so branches do not duplicate the project tree.

`sv restore` operates only on paths tracked in the StructVibe checkout. It never
invokes `git restore`, changes `.git`, or restores application source outside that
checkout.

## Local Preview

Preview the current working tree before committing or pushing anything:

```bash
sv preview
sv preview SCR-001-login
```

The preview server listens on `127.0.0.1`, opens the browser, reloads when a
screen file changes, and follows internal `#SCR-*` links. Screen source runs in a
sandboxed iframe with scripts, network access, forms, popups, and external
navigation disabled. Use `--no-open`, `--port`, or `--host` when needed.

The hidden `.structvibe` directory stores checkout metadata and compressed
content-addressed base objects for offline status, diff, and restore. It does not
contain a second mirrored project tree. Identical base content is stored once and
old `.structvibe/base` checkouts migrate automatically.

## Versioned Source

```text
structvibe.json
overview.md
design/tokens.css
design/screens/SCR-*/screen.json
design/screens/SCR-*/screen.html
design/screens/SCR-*/screen.css
design/screens/SCR-*/features/F-*.md
decisions/DEC-*.md
```

`design/tokens.css` contains shared design tokens only. Each screen owns its
`screen.css`, so tools can read and change one screen without loading a
project-wide stylesheet. Screen source supports a deterministic profile of HTML,
CSS, and inline SVG. Scripts, event handlers, external network URLs, CSS imports,
animation, and raw HTML in Markdown are rejected locally and again by the server.

## License

StructVibe CLI is released into the public domain under [The Unlicense](LICENSE).
Anyone may copy, modify, publish, distribute, sell, or use it for commercial or
non-commercial purposes without asking for permission.
