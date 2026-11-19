# mcp-server-example

A [Model Context Protocol](https://modelcontextprotocol.io) server for the Example API. It lets an MCP client (Claude or any other MCP-capable assistant) read data from the Example API and, when enabled, write to it.

> This is an independent, unofficial project. It is not developed, endorsed or supported by &lt;Vendor&gt;.

- Read-only by default; writes are opt-in per instance.
- One set of upstream credentials per server instance; the server does no per-user authorization itself (see [Security model](#security-model)).
- Two transports: stdio for local clients, stateless streamable HTTP for containers and gateways.
- Embeddable: the `./gateway` export exposes the same tools, validation, policy and audit to a host application.

<!-- template:start -->
## Using this template

This repository is a GitHub template for TypeScript MCP servers: a minimal working server for a fictional upstream API (one read tool, one write tool) with hardened transports, client, policy, audit, tests and release workflows. After creating a repository from it, run `node scripts/rename.mjs <name> [PREFIX]` and follow [docs/NEW-SERVER.md](docs/NEW-SERVER.md). The rename removes this section; the checklist stays. Nothing is published from the template repository, or from a generated repository before the rename.
<!-- template:end -->

## Tools

| Tool | Purpose |
|---|---|
| `example_get_item` | Fetch one item by id. |
| `example_create_item` *(write)* | Create an item. |

## Quick start

Requires Node.js 22 or later and an API key for the Example API.

```bash
npx <npm-package>
```

Or build from source:

```bash
git clone https://github.com/borgels/mcp-server-example.git
cd mcp-server-example
npm ci
npm run build
```

Claude Code:

```bash
claude mcp add example \
  --env EXAMPLE_API_KEY=<key> --env EXAMPLE_BASE_URL=<base url> \
  -- npx -y <npm-package>
```

Claude Desktop (`claude_desktop_config.json`), or any client that launches stdio servers:

```json
{
  "mcpServers": {
    "example": {
      "command": "npx",
      "args": ["-y", "<npm-package>"],
      "env": {
        "EXAMPLE_API_KEY": "<key>",
        "EXAMPLE_BASE_URL": "<base url>"
      }
    }
  }
}
```

### Docker and HTTP

Images are published to `ghcr.io/borgels/mcp-server-example`: `latest` and the commit SHA from `main`, and `vX.Y.Z` for release tags. The container serves streamable HTTP at `/mcp` on port 3000, plus an unauthenticated `GET /healthz`.

```bash
TOKEN=$(openssl rand -hex 32); echo "$TOKEN"
docker run -d --name example-mcp -p 127.0.0.1:3000:3000 \
  -e EXAMPLE_API_KEY=<key> \
  -e EXAMPLE_BASE_URL=<base url> \
  -e MCP_HTTP_TOKEN="$TOKEN" \
  ghcr.io/borgels/mcp-server-example:latest

claude mcp add --transport http example http://127.0.0.1:3000/mcp \
  --header "Authorization: Bearer $TOKEN"
```

To keep an audit log in the container, mount a writable directory and point `EXAMPLE_AUDIT_LOG` into it (e.g. `-v example-audit:/audit -e EXAMPLE_AUDIT_LOG=/audit/audit.jsonl`); the image runs as the `node` user and `/app` is not writable.

Clients send `Authorization: Bearer <MCP_HTTP_TOKEN>`. The server will not start on a non-loopback address without a token of at least 32 characters. It does not terminate TLS; run it behind a reverse proxy or gateway that does.

## Configuration

Configuration is read from the environment (see `.env.example`). Invalid numbers, booleans, URLs and unknown tool names stop the server at startup. Booleans accept `true`/`false`, `1`/`0`, `yes`/`no` and `on`/`off`.

### Upstream API

| Variable | Default | Description |
|---|---|---|
| `EXAMPLE_API_KEY` | – | **Required.** API key. |
| `EXAMPLE_BASE_URL` | – | **Required.** Base URL of the API. Must be `https` (loopback `http` is allowed for local mocks). |
| `EXAMPLE_ALLOW_CUSTOM_BASE_URL` | `false` | Allow a base URL outside the hosts the server expects, when such a list is configured. |
| `EXAMPLE_TIMEOUT_MS` | `30000` | Timeout per request attempt. |
| `EXAMPLE_MAX_CONCURRENCY` | `4` | Maximum concurrent upstream requests. |
| `EXAMPLE_MAX_RESPONSE_BYTES` | `10485760` | Largest response body read (at most 100 MB). |

### Access control

| Variable | Default | Description |
|---|---|---|
| `EXAMPLE_ENABLE_WRITES` | `false` | Enable the write tools. |
| `EXAMPLE_DISABLED_TOOLS` | – | Comma-separated tool names to disable, with or without the `example_` prefix. |
| `EXAMPLE_AUDIT_LOG` | – | Path of a JSONL audit log: one record per tool call start, finish and error, with ids in clear text, free text hashed, duration, status and the caller passed by an embedding host. Write tools refuse to run if the log cannot be written. |

### HTTP transport

| Variable | Default | Description |
|---|---|---|
| `MCP_HTTP_TOKEN` | – | Bearer token, at least 32 printable ASCII characters (also on loopback). Required unless bound to loopback. |
| `MCP_HTTP_HOST` or `HOST` | `127.0.0.1` (`0.0.0.0` in the image) | Bind address; `MCP_HTTP_HOST` takes precedence. |
| `PORT` | `3000` | Listen port. |
| `MCP_ALLOWED_ORIGINS` | localhost origins | Comma-separated browser origins allowed to call the server. |
| `MCP_ALLOW_ANY_ORIGIN` | `false` | Allow any origin; requires a token. |
| `MCP_ALLOWED_HOSTS` | loopback names on a loopback bind | Comma-separated accepted `Host` header names. |
| `MCP_MAX_BODY_BYTES` | `10485760` | Maximum request body. |
| `MCP_AUTH_FAILURE_LIMIT`, `MCP_AUTH_FAILURE_WINDOW_MS` | `20`, `60000` | Failed-authentication limit per client address; `0` disables it. |
| `MCP_HTTP_ALLOW_UNAUTHENTICATED` | `false` | Permit a non-loopback bind without a token. Only for isolated networks. |

## Embedding (`./gateway`)

A host application can run the tools in-process instead of over MCP:

```ts
import { createExampleGateway, exampleToolCatalog } from '<npm-package>/gateway';

const gateway = createExampleGateway({ apiKey: tenant.apiKey, baseUrl: tenant.baseUrl });
const result = await gateway.callTool('get_item', { itemId: 'i1' }, { caller: 'user@example.test' });
```

- **Explicit credentials.** `apiKey` and `baseUrl` are required; a missing value throws when the gateway is created. A gateway never reads `EXAMPLE_API_KEY` or `EXAMPLE_BASE_URL` from the environment, so one tenant cannot silently fall back to the process's credentials. The stdio and HTTP transports still read them from the environment.
- **Several tenants in one process.** Create one gateway per set of credentials. Each instance redacts error text, tool results and audit records with its own key only; no secret is kept in a process-wide registry, and a dropped instance releases its key.
- **Instance policy from the host.** Pass `policy` to `createExampleGateway`: `enableWrites` (default false), `disabledTools` (must name known tools) and `audit`, a function that receives each audit record instead of `EXAMPLE_AUDIT_LOG` (without it the instance writes no audit; a write tool does not run if the sink throws on its start record). An instance with `policy` reads none of `EXAMPLE_ENABLE_WRITES`, `EXAMPLE_DISABLED_TOOLS`, `EXAMPLE_AUDIT_LOG` or `EXAMPLE_ALLOW_CUSTOM_BASE_URL`, so tenants in one process can have different settings. Without `policy` the instance uses the environment, like the MCP server. Each call runs in a scope of its own, so a call made from inside another instance's call never inherits its policy, sink or redactor, and every audit record is redacted as a whole with the instance's own key before the sink sees it. The limits (`EXAMPLE_TIMEOUT_MS`, ...) are still read from the environment and apply to every gateway in the process. Per-user and per-tenant authorization is the host's job.
- **Result format.** A successful `callTool` result has `structuredContent` and one text block: a short summary, a blank line, and the same data as compact JSON, as the MCP specification recommends (many clients read only the text). The JSON is built from the redacted result, so it holds exactly `structuredContent`. An error result has only its text.
- **Tool catalog.** `exampleToolCatalog` is a frozen list of every tool: `name` (without the `example_` prefix), `title`, `description`, `riskLevel` (`read`, `write` or `destructive`), `enabledByDefault`, `inputSchema` (JSON Schema), `broad` (true when a tool can read more than its name says, so a host gives it only to roles that may read everything) and `upstream`, the API requests the tool may make (`access`, `method` and path template). It is generated from the same tool table as the MCP server, so it cannot drift from the registered tools. `exampleGatewayTools` holds the same definitions without `upstream` and `broad`; `gateway.tools` lists those enabled on the instance.

## Threat model

What this server guarantees about the API key, and what it does not. It is
the yardstick for every change that touches errors, results or audit.

**Scope.** Guarantees (a), (b) and (c) apply to the embeddable gateway
(`./gateway`), the surface a multi-tenant host uses. The standalone MCP
server, configured from the environment for one key, keeps best-effort
redaction: its errors and audit records are redacted with its key, but it is
not held to these guarantees.

**Guaranteed:**

- **(a) The key never reaches anything persisted or shared:** audit sinks and
  the audit log file, logs, error texts, export hooks or files. Errors are
  our own texts; audit records and everything a gateway instance returns are
  redacted with the instance's own key before they leave it.
- **(b) No vendor-controlled free text in errors.** An error carries our own
  fixed text, the HTTP status, numbers we parse (Retry-After), and codes from
  a fixed list we wrote down; never a response body, a vendor message or
  code, a redirect's `Location`, a type or field name from the vendor, or
  the message of an error thrown while reading a response. A failure kept
  inside an otherwise returned result is the status or a fixed text as well.
  Errors never quote the key, the configured address or a refused configuration value (a timeout names its limit in milliseconds).
- **(c) Results go only to the tenant whose key it is.** One gateway
  instance per tenant; every call runs in a scope of its own; nothing about a
  tenant is kept in process-wide state. The MCP server serves one key.

**Not guaranteed (residual risk):** a vendor that deliberately echoes the
customer's own key back in data. Results are redacted on a best-effort
basis: the exact key, its URL- and JSON-encoded forms and any piece of it of
6 characters or more, in strings, object keys and the string form of
numbers and booleans, are replaced by `"‹redacted›"` before anything is
serialised. A key that comes back otherwise transformed (split into pieces
shorter than 6 characters, reversed, re-encoded, hashed) is not recognised.
Such data reaches only the tenant whose key it is, which already holds the
key. **What leaves a gateway holds no piece of the key.** This is checked at
the sink, not inferred from our texts: every output is checked in its final
form, and one that holds a piece of 6 characters of the key (or of one of
its encoded forms) is replaced by a fixed fallback. The outputs are the tool
list, every tool result as a whole (outer fields such as `isError`
included), audit records and stderr lines, and construction errors. A result becomes a fixed
"withheld" error, an audit record or line becomes a fixed one, and a
construction error becomes the fixed refusal. Every error a gateway throws is a fresh error in final form: no `cause`, a `stack` of only `name: message` (no frames, paths or function names), and name, message and stack masked against the secret. The fallbacks are a small,
closed set (`src/fallbacks.ts`), and a key that shares a piece with any of
them, or with the tool list, is refused when the gateway is created.

**Key admission.** Every key is a secret the vendor issues. A gateway
accepts only printable ASCII (0x21-0x7E) of at least 16 characters, checked
before anything is built from the key. As a cheap first filter it also
refuses a key that shares a piece of 6 characters with a string literal in
`src/` (`src/fixed-corpus.generated.ts`, kept up to date by a test). The
refusal is a fixed text that never repeats the key. The standalone MCP server applies the same redaction to errors
and audit records on a best-effort basis; its successful results are passed
on as the API returned them.

## Security model

- **One shared identity.** Every caller acts with the rights of the configured API key. Give it the least rights that work and rotate it regularly.
- **Per-user authorization belongs in front of the server.** The server checks a single bearer token and does not know the end user. For multi-user use, run it behind an identity-aware gateway that decides which users may call which tools, holds the bearer token, and is the only network path to the server. Hosts can also embed the tools through the `./gateway` module export and pass the caller identity into the audit log.
- **Tool access is not data access.** A gateway controls who may call which tool; every permitted caller still sees everything the API key can see. To separate data, run several instances with different keys.
- **Writes are off by default.** Write tools are annotated as destructive so clients can ask for confirmation. Read-only tools get a client that refuses non-GET requests. When `EXAMPLE_AUDIT_LOG` is set, a write tool does not run unless its start record is written; without it there is no audit record.
- **Upstream content is untrusted input.** Data returned by the API may be written by anyone with access to it. Tool results label it as data; clients that combine this server with other tools should treat it accordingly.
- **The API key stays on the API origin.** Redirects are never followed, the base URL must use `https`, and error messages and audit records are redacted (by each instance, with that instance's key) and size-capped. See the threat model above for what is and is not guaranteed.
- **The HTTP transport fails closed.** It refuses to start on a non-loopback address or with any origin allowed unless a token is set, compares tokens in constant time, throttles failed authentication per client address, checks `Origin` and `Host` (DNS rebinding), and caps request bodies.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Development

```bash
npm run dev          # stdio transport
npm run dev:http     # HTTP transport on 127.0.0.1:3000
npm run typecheck
npm test
npm run build
```

Project layout:

| Path | Contents |
|---|---|
| `src/tools/example.ts` | Shared tool table (MCP and gateway), policy and audit wrapper. |
| `src/example/` | Upstream client, API calls, policy, audit, tool annotations. |
| `src/transports/` | stdio and HTTP entry points; HTTP auth, origin and host checks. |
| `src/gateway.ts` | Embeddable entry point (`./gateway` export). |
| `src/config-env.ts` | Validated environment readers. |

## Releasing

1. Bump the version in `package.json`, `server.json` (`version` and the npm package `version`) and `src/version.ts`; tests and CI check that they agree. Update `CHANGELOG.md`. Merge.
2. Tag the merged commit and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. `release.yml` tests, packs and publishes the tarball to npm through trusted publishing (no stored token; npm adds provenance when the repository is public), then publishes `server.json` to the MCP Registry. Versions already on npm or in the registry are skipped, so a failed run can be re-run. Pre-release tags (`vX.Y.Z-rc.1`) go to the npm dist-tag `next` and not to the registry. `publish.yml` pushes the `vX.Y.Z` image.

The first version of a new package is published by hand; see the header of `.github/workflows/release.yml` (and [docs/NEW-SERVER.md](docs/NEW-SERVER.md)).

## License

Apache-2.0
