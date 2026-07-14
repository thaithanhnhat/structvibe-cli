# Security

## Trust Boundary

The CLI reads and writes only:

- the current StructVibe checkout
- `.structvibe/` metadata inside that checkout
- `~/.structvibe/credentials.json`
- the StructVibe server selected by the user

It does not inspect browser data, IDE configuration, unrelated repositories, cookies, or operating-system credential stores. It contains no telemetry and starts no listener.

## Network Behavior

Every network request is visible in `src/api.ts`. Requests use a 30-second timeout and send the access token only in the `Authorization: Bearer` header to the configured server. Interactive login uses a short-lived OAuth-style device authorization: the browser approves a one-time code, and the access token is returned only to the polling CLI.

## Untrusted Design Source

`sv check` (also available as the compatibility alias `sv validate`) parses screen HTML and CSS without executing it. The accepted profile blocks scripts, event handlers, external URLs, CSS imports, nondeterministic animation, unsafe SVG elements, path traversal, oversized documents, excessive nesting, and unsupported repository paths. The StructVibe server repeats the same checks and remains authoritative.

## Token Handling

Local credentials use file mode `0600`. Device codes are hashed, expire quickly, and can be exchanged only once. Access tokens are also stored hashed on the server and checked independently on every request; no online-machine or connection state is maintained. Operating-system keychain support and a dedicated credential-revocation screen are planned before a stable `1.0` release.

## Reporting

Use the repository's private security advisory form for vulnerabilities. Do not
include active tokens, private project source, or customer data in a public issue.
