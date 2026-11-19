# mcp-server-woocommerce

A [Model Context Protocol](https://modelcontextprotocol.io) server for [WooCommerce](https://woocommerce.com) shops. It lets an MCP client (Claude or any other MCP-capable assistant) read a shop's orders, products, customers and sales figures, and, when enabled, change an order's status, add a private order note, record a refund in the shop without paying money back, create a draft product and update products and customers.

> This is an independent, unofficial project. It is not developed, endorsed or supported by WooCommerce or Automattic.

- Read-only by default; writes are opt-in per instance.
- One shop per server instance, with a REST API key (consumer key and secret) made in that shop.
- No tool deletes anything, asks a payment gateway to refund money, restocks, sends a note to the customer, uses a batch endpoint, or touches coupons, settings, payment methods, users' e-mail, passwords or roles. The client sends only a fixed list of writes and has no DELETE.
- Two transports: stdio for local clients, stateless streamable HTTP for containers and gateways.
- Embeddable: the `./gateway` export exposes the same tools, validation, policy and audit to a host application.

Built against the WooCommerce REST API v3 documentation (<https://woocommerce.github.io/woocommerce-rest-api-docs/>). The tests use answers shaped as that documentation shows them; **they have not been run against a live shop.**

## Tools

Reads (on by default):

| Tool | Purpose |
|---|---|
| `woocommerce_check_connection` | Check the address and key by reading one order; returns only that it works and the number of orders (`X-WP-Total`). |
| `woocommerce_get_sales_report` | Totals for a period (`week`, `month`, `last_month`, `year`) or between two dates: sales, orders, items, tax, shipping, refunds, discounts. No customers. |
| `woocommerce_list_orders` / `woocommerce_get_order` | Orders with the documented filters (status, customer, product, search, after, before), 20 per page by default with the totals; one order with its lines, addresses, the customer's note and refunds. The customer's IP address and browser, the order key, cart hash, transaction id and meta data are left out. |
| `woocommerce_list_order_notes` / `woocommerce_list_order_refunds` | The notes and the refunds of an order. Refunds are read page by page, 100 at a time, up to 1,000; `complete` is false when there are more. |
| `woocommerce_list_products` / `woocommerce_get_product` | Products with prices, stock and categories. |
| `woocommerce_list_customers` / `woocommerce_get_customer` | Registered customers with addresses. Username, role and meta data are left out. |

Writes (off unless `WOOCOMMERCE_ENABLE_WRITES=true`, or `enableWrites` in a host's policy):

| Tool | What it does |
|---|---|
| `woocommerce_update_order_status` | Move an order to `processing`, `on-hold`, `completed` or `cancelled`. Reads it first; refuses the same status, or an order that is refunded, failed or in the trash. WooCommerce may e-mail the customer as the shop's own e-mail settings say. |
| `woocommerce_add_order_note` | A private note on an order. `customer_note` is always `false`, so the customer is never notified; an answer that does not say `false` is reported as a failure. |
| `woocommerce_record_refund` | Record a refund on an order **in the shop only**: `api_refund` is always `false` (WooCommerce's documented default is `true`, which asks the payment gateway to pay the money back) and `api_restock` always `false`. A person refunds the money in the payment provider. Reads the order first; refuses an order that is not processing, on-hold or completed, another currency, an order without its refunds list, or an amount above the total less earlier refunds. Refunds of one order run one at a time per shop in this process, whichever key the call came through. Marked `requiresConfirmation` for hosts. |
| `woocommerce_create_draft_product` | A simple product, always as a draft (the documented default is `publish`). |
| `woocommerce_update_product` | Change the fields given on a product: name, SKU, prices, descriptions, stock, status. Variations are not changed. |
| `woocommerce_update_customer` | Change a customer's name, billing address and phone, or shipping address. Never the e-mail, password or role. |

Ids are positive integers, as the documentation describes them. Every answer is parsed with a schema per resource, after the documentation's property tables, sub-objects and lists (order lines, refunds, categories, addresses) included: a present field must have its documented type, a record must have the id that was asked for (and a changed order the new status), and one entry of a list that does not fit refuses the whole answer. Fields a schema does not name are dropped. An answer that does not fit is an error, never an empty or partial result.

## Getting a key

In WordPress, go to **WooCommerce -> Settings -> Advanced -> REST API**, click **Add key**, choose the user and the permissions (**Read**, or **Read/Write** for the write tools) and click **Generate API key**. Copy the consumer key (`ck_...`) and secret (`cs_...`); the secret is shown once. Revoke the key in the same place. The REST API needs pretty permalinks and HTTPS.

## Quick start

Requires Node.js 22 or later and a REST API key for the shop.

```bash
npx mcp-server-woocommerce
```

Or build from source:

```bash
git clone https://github.com/borgels/mcp-server-woocommerce.git
cd mcp-server-woocommerce
npm ci
npm run build
```

Claude Code:

```bash
claude mcp add woocommerce \
  --env WOOCOMMERCE_SHOP_URL=https://shop.example.com \
  --env WOOCOMMERCE_CONSUMER_KEY=<ck_...> \
  --env WOOCOMMERCE_CONSUMER_SECRET=<cs_...> \
  -- npx -y mcp-server-woocommerce
```

Claude Desktop (`claude_desktop_config.json`), or any client that launches stdio servers:

```json
{
  "mcpServers": {
    "woocommerce": {
      "command": "npx",
      "args": ["-y", "mcp-server-woocommerce"],
      "env": {
        "WOOCOMMERCE_SHOP_URL": "https://shop.example.com",
        "WOOCOMMERCE_CONSUMER_KEY": "<ck_...>",
        "WOOCOMMERCE_CONSUMER_SECRET": "<cs_...>"
      }
    }
  }
}
```

### Docker and HTTP

Images are published to `ghcr.io/borgels/mcp-server-woocommerce`: `latest` and the commit SHA from `main`, and `vX.Y.Z` for release tags. The container serves streamable HTTP at `/mcp` on port 3000, plus an unauthenticated `GET /healthz`.

```bash
TOKEN=$(openssl rand -hex 32); echo "$TOKEN"
docker run -d --name woocommerce-mcp -p 127.0.0.1:3000:3000 \
  -e WOOCOMMERCE_SHOP_URL=https://shop.example.com \
  -e WOOCOMMERCE_CONSUMER_KEY=<ck_...> \
  -e WOOCOMMERCE_CONSUMER_SECRET=<cs_...> \
  -e MCP_HTTP_TOKEN="$TOKEN" \
  ghcr.io/borgels/mcp-server-woocommerce:latest

claude mcp add --transport http woocommerce http://127.0.0.1:3000/mcp \
  --header "Authorization: Bearer $TOKEN"
```

To keep an audit log in the container, mount a writable directory and point `WOOCOMMERCE_AUDIT_LOG` into it (e.g. `-v woocommerce-audit:/audit -e WOOCOMMERCE_AUDIT_LOG=/audit/audit.jsonl`); the image runs as the `node` user and `/app` is not writable.

Clients send `Authorization: Bearer <MCP_HTTP_TOKEN>`. The server will not start on a non-loopback address without a token of at least 32 characters. It does not terminate TLS; run it behind a reverse proxy or gateway that does.

## Configuration

Configuration is read from the environment (see `.env.example`). Invalid numbers, booleans, URLs and unknown tool names stop the server at startup. Booleans accept `true`/`false`, `1`/`0`, `yes`/`no` and `on`/`off`.

### Shop

| Variable | Default | Description |
|---|---|---|
| `WOOCOMMERCE_SHOP_URL` | – | **Required.** The shop's address, e.g. `https://shop.example.com` (a shop in a subfolder keeps its path). The API is at `<address>/wp-json/wc/v3`. Must be `https` with a public host name: no IP address, `localhost`, single label or local suffix (`.local`, `.internal`, ...), no credentials, query or fragment. |
| `WOOCOMMERCE_CONSUMER_KEY` | – | **Required.** The consumer key (`ck_...`). |
| `WOOCOMMERCE_CONSUMER_SECRET` | – | **Required.** The consumer secret (`cs_...`). Key and secret are sent as HTTP Basic auth over HTTPS, as the documentation describes. |
| `WOOCOMMERCE_ALLOW_PRIVATE_HOST` | `false` | Allow a shop on a loopback or private address (and `http` on loopback), for local development. Never honoured by an embedded gateway. |
| `WOOCOMMERCE_TIMEOUT_MS` | `30000` | Timeout per request attempt. |
| `WOOCOMMERCE_MAX_CONCURRENCY` | `4` | Maximum concurrent upstream requests. |
| `WOOCOMMERCE_MAX_RESPONSE_BYTES` | `10485760` | Largest response body read (at most 100 MB). |

### Access control

| Variable | Default | Description |
|---|---|---|
| `WOOCOMMERCE_ENABLE_WRITES` | `false` | Enable the write tools. |
| `WOOCOMMERCE_DISABLED_TOOLS` | – | Comma-separated tool names to disable, with or without the `woocommerce_` prefix. |
| `WOOCOMMERCE_AUDIT_LOG` | – | Path of a JSONL audit log: one record per tool call start, finish and error, with ids, statuses, dates, amounts and currency in clear, searches, SKUs and product names hashed, and names, e-mail addresses, addresses, phone numbers, notes and refund reasons not logged at all; duration, status and the caller passed by an embedding host. Write tools refuse to run if the log cannot be written. |

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

A host application can run the tools in-process instead of over MCP, one instance per shop:

```ts
import { createWooCommerceGateway, wooCommerceToolCatalog, resolveWooCommerceChange } from 'mcp-server-woocommerce/gateway';

const gateway = createWooCommerceGateway({
  shopUrl: connection.shopUrl,
  consumerKey: connection.consumerKey,
  consumerSecret: connection.consumerSecret,
  policy: { enableWrites: true, disabledTools: [], audit: record => log(record) },
});
const result = await gateway.callTool('list_orders', { status: 'processing' }, { caller: 'person-1' });
```

- **Explicit credentials.** `shopUrl`, `consumerKey` and `consumerSecret` are required; a missing value throws when the gateway is created. A gateway never reads `WOOCOMMERCE_SHOP_URL`, `WOOCOMMERCE_CONSUMER_KEY` or `WOOCOMMERCE_CONSUMER_SECRET` from the environment, and never allows a private address. The stdio and HTTP transports still read them from the environment.
- **The shop address is checked twice.** When the gateway is created (https, a public host name), and by every new connection: the built-in fetch (undici) resolves the name in the connection's own `lookup`, refuses the connection unless every address is a public unicast address, and connects to the address it checked, so a DNS answer that changes between connections (DNS rebinding) is checked again. Addresses are parsed, not compared as text: every spelling of loopback, IPv4 inside IPv6 (mapped, compatible, NAT64, 6to4, Teredo), private, link-local, carrier-grade NAT, unique local, multicast and reserved ranges are refused. TLS still verifies the certificate against the host name. A host that passes its own `fetchImpl` decides where requests go, and this check is then the host's.
- **Several shops in one process.** Create one gateway per key. Each instance redacts error text, tool results and audit records with its own key, secret and their Basic form only; no secret is kept in a process-wide registry, and a dropped instance releases them.
- **Instance policy from the host.** Pass `policy` to `createWooCommerceGateway`: `enableWrites` (default false), `disabledTools` (must name known tools), `pseudonymKey` (at least 32 random printable characters or 32 random bytes, admitted like the shop's key: a key that shares a piece of six characters with any text of this server is refused, so no error, fallback or tool description can carry part of it; the caller and request id in audit records become `hmac:` and 16 hex characters with it, else `sha256:`) and `audit`, a function that receives each audit record instead of `WOOCOMMERCE_AUDIT_LOG` (without it the instance writes no audit; a write tool does not run if the sink throws on its start record). An instance with `policy` reads none of `WOOCOMMERCE_ENABLE_WRITES`, `WOOCOMMERCE_DISABLED_TOOLS` or `WOOCOMMERCE_AUDIT_LOG`. Each call runs in a scope of its own. The limits (`WOOCOMMERCE_TIMEOUT_MS`, ...) are still read from the environment and apply to every gateway in the process. Per-user authorization is the host's job.
- **Result format.** A successful `callTool` result has `structuredContent` and one text block: a short summary, a blank line, and the same data as compact JSON. An error result has only its text.
- **Tool catalog.** `wooCommerceToolCatalog` is a frozen list of every tool: `name` (without the `woocommerce_` prefix), `title`, `description`, `riskLevel` (`read` or `write`; no tool is `destructive`), `enabledByDefault`, `inputSchema` (JSON Schema), `broad` (false for every tool), `upstream` (the API requests the tool may make), `requiresConfirmation` (true for `record_refund` only: a host should have a person confirm it outside the chat) and, for write tools, `change`: the action (`set_status`, `add_note`, `record_refund`, `create`, `update`), the record kind, `movesMoney` (always false) and `logFields`.
- **Change resolution.** `resolveWooCommerceChange(tool, input, { pseudonymKey })` (or `gateway.resolveChange`, which also leaves out any value holding a piece of that instance's key or secret) validates the input exactly as the call would, the tool's own checks included, and returns what a write call will change before it is sent, for a host that logs the change first: order, product and customer ids, the refund amount and currency, statuses and flags in clear; a SKU only as a pseudonym (HMAC-SHA-256 with the host's key, else SHA-256); never a name, an address, a note or a reason.

## Threat model

What this server guarantees about the key and secret, and what it does not.
It is the yardstick for every change that touches errors, results or audit.

**Scope.** Guarantees (a), (b) and (c) apply to the embeddable gateway
(`./gateway`), the surface a multi-tenant host uses. The standalone MCP
server, configured from the environment for one shop, applies the same
redaction and the same last leak check to its results and errors.

**Guaranteed:**

- **(a) The key and secret never reach anything persisted or shared:** audit
  sinks and the audit log file, logs, error texts, export hooks or files.
  Errors are our own texts; audit records and everything a gateway instance
  returns are redacted with the instance's own key, secret and their Basic
  form before they leave it.
- **(b) No shop-controlled free text in errors.** An error carries our own
  fixed text, the HTTP status, numbers we parse (Retry-After), and codes from
  a fixed list we wrote down; never a response body, a WooCommerce or plugin
  message or code, a redirect's `Location`, or the message of an error thrown
  while reading a response. A failure kept inside an otherwise returned
  result is the status or a fixed text as well. Errors never quote the key,
  the shop address or a refused configuration value.
- **(c) Results go only to the tenant whose key it is.** One gateway
  instance per tenant; every call runs in a scope of its own; nothing about a
  tenant is kept in process-wide state except the per-order refund lock,
  keyed on a hash of the shop address. The MCP server serves one key.

**Not guaranteed (residual risk):** a shop or plugin that deliberately echoes
the key back in data. Results are redacted on a best-effort basis: the exact
key and secret, their Basic form, their URL- and JSON-encoded forms and any
piece of 6 characters or more, in strings, object keys and the string form
of numbers and booleans, are replaced by `"‹redacted›"` before anything is
serialised. **What leaves a gateway holds no piece of the key.** This is
checked at the sink: every output (the tool list, every tool result as a
whole, audit records and stderr lines, construction errors) is checked in its
final form, and one that holds a piece of 6 characters of the key or secret
(or of an encoded form) is replaced by a fixed fallback from a small, closed
set (`src/fallbacks.ts`).

**Key admission.** A gateway accepts a key and secret of printable ASCII
(0x21-0x7E) of at least 16 characters, checked before anything is built from
them, and refuses one that shares a piece of 6 characters with a string
literal in `src/` (`src/fixed-corpus.generated.ts`, kept up to date by a
test). The refusal is a fixed text that never repeats the key.

**Call context in the audit.** The `caller` a host passes is never logged in clear: it becomes a pseudonym (HMAC-SHA-256 with `policy.pseudonymKey`, else SHA-256). Nor is a `requestId`: any text can hold a name, a phone number or an address, so the audit keeps its pseudonym the same way, which still ties the lines of one call together for a host that knows the key; without one the audit makes its own id. The pseudonym key is a secret of the instance like the shop's key: it is redacted from results, audit records and errors.

**Rejected calls.** A call refused before it runs (an unknown tool or
invalid input) is audited with a fixed code (`unknown_tool`,
`invalid_input`), the argument names the tool's schema knows and the number
of other arguments. An unknown tool name is recorded only as a pseudonym.

**Refunds.** The refund lock covers calls in this process. A refund made in
the shop's admin, by another process or by a payment provider at the same
moment is not seen; the check against the order's total less earlier refunds
is then only as fresh as the order read just before the refund is sent.
Two addresses of one shop that differ by more than a leading `www.` are not
recognised as one shop.

## Security model

- **One shared identity.** Every caller acts with the rights of the configured key, which acts as the WordPress user it was made for. Make it for a user with the least rights that work (a shop manager, not an administrator), choose **Read** unless the write tools are needed, and revoke keys that are no longer used.
- **Per-user authorization belongs in front of the server.** The server checks a single bearer token and does not know the end user. For multi-user use, run it behind an identity-aware gateway that decides which users may call which tools.
- **Tool access is not data access.** Every permitted caller sees everything the key can see, including customers' names, addresses and e-mail addresses.
- **Writes are off by default.** Write tools are not annotated destructive (none deletes anything), but they change orders, products and customers; a client should ask before running them, and `record_refund` is marked for a person's confirmation. Read-only tools get a client that refuses non-GET requests. When `WOOCOMMERCE_AUDIT_LOG` is set, a write tool does not run unless its start record is written.
- **Upstream content is untrusted input.** Order notes, product descriptions and customers' notes are written by customers, staff and plugins. Tool results label them as data.
- **The key stays on the shop.** Redirects are never followed, the address must be https with a public host name, every connection goes only to a public address of the shop, checked by the connection itself, and error messages and audit records are redacted and size-capped.
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
| `src/tools/woocommerce.ts` | Shared tool table (MCP and gateway), policy and audit wrapper. |
| `src/woocommerce/` | Upstream client, API calls, value rules, policy, audit, tool annotations. |
| `src/transports/` | stdio and HTTP entry points; HTTP auth, origin and host checks. |
| `src/gateway.ts` | Embeddable entry point (`./gateway` export). |
| `src/config-env.ts` | Validated environment readers. |

## Releasing

1. Bump the version in `package.json`, `server.json` (`version` and the npm package `version`) and `src/version.ts`; tests and CI check that they agree. Update `CHANGELOG.md`. Merge.
2. Tag the merged commit and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. `release.yml` tests, packs and publishes the tarball to npm through trusted publishing (no stored token; npm adds provenance when the repository is public), then publishes `server.json` to the MCP Registry. Versions already on npm or in the registry are skipped, so a failed run can be re-run. Pre-release tags (`vX.Y.Z-rc.1`) go to the npm dist-tag `next` and not to the registry. `publish.yml` pushes the `vX.Y.Z` image.

The first version of a new package is published by hand; see the header of `.github/workflows/release.yml`.

## License

Apache-2.0
