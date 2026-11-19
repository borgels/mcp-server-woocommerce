# New server checklist

Steps for turning a repository generated from the MCP server template into a published server. `<name>` is the lowercase server name, `<PREFIX>` the environment variable prefix, `<owner>/<repo>` the GitHub repository and `<package>` the npm package name.

## 1. Rename the placeholder

Run once, right after creating the repository:

```bash
node scripts/rename.mjs <name> [<PREFIX>]
npm ci && npm run typecheck && npm test && npm run build
```

The script has no dependencies. It checks every target path first, then renames the placeholder in all files and paths, sets the npm package name in the README commands to `mcp-server-<name>`, removes the template-only README block and CI job, and deletes itself. Nothing is published (GHCR image, npm, MCP Registry) while `scripts/rename.mjs` exists or the package is still named after the placeholder, so pushes before the rename are safe.

Check that `mcp-server-<name>` is free on npm (`npm view mcp-server-<name>` should report 404). Otherwise choose another package name and change it everywhere it appears: `name` and the `bin` key in `package.json`, `package-lock.json` (run `npm install` to update it), `server.json` (`packages[].identifier`), `src/version.ts` (User-Agent) and the README commands.

## 2. Metadata the script cannot know

- `package.json`: `description`, `keywords`, `author`, `repository`, `bugs` and `homepage` URLs.
- `package.json` `overrides`: inherited from the template to keep `npm audit` clean; remove entries that are no longer needed (`npm ls <dep>`, then `npm audit --omit=dev`).
- `server.json`: `title`, `description` (at most 100 characters; CI validates it), `repository`, `environmentVariables`. `name` and `package.json` `mcpName` must be `io.github.<owner>/<repo>`, where `<owner>` is the GitHub owner of the repository (the MCP Registry grants that namespace).
- README: the vendor name in the disclaimer, the owner in clone URLs and in `ghcr.io/<owner>/...` image names, the tool table.
- `LICENSE`: the copyright line in the appendix, if you use it.
- `.github/CODEOWNERS`, `glama.json` (maintainers), `SECURITY.md` (contact).

## 3. Implement the upstream API

- `src/<name>/client.ts`: `API_KEY_HEADER` (error text redaction follows it), `UPSTREAM_HOST_SUFFIXES` to pin the hosts the key may be sent to, and a default base URL if the vendor has one fixed host.
- `src/errors.ts`: the vendor's error model and status or error-code hints; credential key names in `BASE_PATTERNS`. Secret values are never registered globally: each client owns a `SecretRedactor` holding its key and key header.
- API calls next to `src/<name>/items.ts`; pass every caller-supplied path segment through `encodePathParam`.
- Tools in the table in `src/tools/<name>.ts`: strict zod input, correct annotations, and `upstream`, every API request the handler may make. It is published in the gateway tool catalog; the catalog test checks it against the requests each tool makes, so add a sample input there for each new tool. Read-only tools receive a client that refuses non-GET requests; give POST-based searches a dedicated method instead of the full client.
- Audit fields in `src/<name>/audit.ts`: ids in clear text, free text hashed, payloads by field name only.
- Policy in `src/<name>/policy.ts`: instance allowlists, if any.
- Tests, README tool and configuration tables, `.env.example` and `server.json` `environmentVariables` alongside.

## 4. Multi-tenant embedding

The `./gateway` export is built for hosts that run several tenants in one process. Keep these properties when adapting it:

- `create<Name>Gateway` requires every tenant-specific credential (the API key, and the base URL when it differs per tenant) as an option and throws when one is missing. The client reads omitted credentials from `credentialEnv`; the gateway passes `{}`, so it never falls back to the environment. A value with a fixed vendor default (for example a single API host) can keep the default.
- The gateway admits a key only through `admitsKey` (`src/key-admission.ts`): printable ASCII, at least 16 characters, and (a cheap first filter) no piece of 6 characters shared with a string literal in `src/`; run `node scripts/fixed-corpus.mjs` after changing a text. The guarantee comes from the sink check: every output (tool list, whole results, audit records and lines, construction errors) passes `leaksSecret` in its final form and is replaced by a fixed fallback from `src/fallbacks.ts` when it holds a piece of the key. A new kind of output needs the same check, and a new fallback goes into `fixedOutputs()`.
- Redaction is per instance: pass the client's `redactor` to everything that formats errors or writes audit records for that instance, and do not add module-level secret registries. The gateway redacts every result it returns, text and data, object keys included.
- No upstream text in an error. `ExampleHttpError` carries the status, our own hint and a parsed Retry-After; the body is discarded unread, the vendor's code and message are not kept, a redirect's `Location` is not quoted, and a network error names only a system error code. Audit records get the HTTP status, never a vendor code. Keep it that way when you map the vendor's errors: choose our own text by status, or by a code from a fixed list you write down.
- A failure kept inside a result that is otherwise returned (one part of a combined read, as `get_item` with `includeHistory`) goes in as `nestedFailureText(error)`: the HTTP status or a fixed text. A failure the API reports inside a successful body (`metadata.error`, `failures[].error`) goes through `nestedFailuresAsStatus`: map the vendor's documented fields.
- An error thrown while reading a successful body is replaced by a fixed text (`readResponseBody`); only timeouts and dropped connections go on, and they are reported as transport errors.
- Redact structured values before they are serialised (`redactDeep`, keys included, numbers and booleans by their string form, replaced by the string `"‹redacted›"` so the JSON stays valid); build any JSON text from the redacted data, after redaction. A serialised key is escaped and no longer matches.
- The redactor removes the key, its URL- and JSON-encoded forms, and any piece of it of `FRAGMENT_LENGTH` (6) characters or more. Never cut a value short before it is redacted, and never echo a configuration value in an error (not even shortened): name the variable only.
- `test/gateway-results.test.ts` proves this through every channel with one key that has a quote and a backslash. Keep it, and add a channel when you add one.
- New tools appear in `<name>ToolCatalog` automatically; declare their `upstream` requests, and `broad: true` on a tool that can read more than its name says (a generic lookup by path or a raw query).
- Instance policy (writes, disabled tools, audit, and any allowlist you add) comes from the host's `policy` option when it is given, through `runInCallScope` in `src/<name>/policy.ts` (every gateway call runs in a scope of its own, with or without a host policy): every policy function reads `currentInstancePolicy()` first and the environment only outside a host policy. Add new policy settings to `InstancePolicy` and `resolveInstancePolicy` as well as to the environment. Limits stay process-wide and environment-based.

## 4a. Threat model (keep it, adapt the names)

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
  Errors never quote a configuration value.
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
key.

**What leaves a gateway holds no piece of the key.** This is checked at
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
refusal is a fixed text that never repeats the key.

The standalone MCP server applies the same redaction to errors
and audit records on a best-effort basis; its successful results are passed
on as the API returned them.

## 5. Container image

The first push to `main` after the rename publishes `ghcr.io/<owner>/<repo>`. A new GHCR package is private: make it public in the package settings if users should pull it, and link it to the repository if GitHub did not.

## 6. First npm release (bootstrap)

npm cannot configure a trusted publisher for a package that does not exist yet.

1. Set the version (`package.json`, `server.json` twice, `src/version.ts`; tests and CI check that they agree) and `CHANGELOG.md`, and merge.
2. Publish that version by hand from a clean checkout of the merged commit: `npm login`, `npm ci`, `npm publish --access public`. Make the repository public before releases from the workflow if the package should carry npm provenance (npm only attaches it for public repositories).
3. Tag the same commit and push the tag (`git tag vX.Y.Z && git push origin vX.Y.Z`). `release.yml` sees the version on npm, skips npm, and publishes `server.json` to the MCP Registry; `publish.yml` pushes the `vX.Y.Z` image.
4. Shortly before the next release, configure trusted publishing (npm 11.15 or later, account 2FA):

   ```bash
   npm trust github <package> --file release.yml --repository <owner>/<repo> --allow-publish
   ```

   A new configuration expires unless it completes a publish within two days.

## 7. Later releases

See "Releasing" in the README: bump the version, update the changelog, merge, push a `vX.Y.Z` tag.

## 8. Listings

Once the repository is public, claim the server on glama.ai (`glama.json` lists the maintainers). The MCP Registry entry is created by the first tagged release.
