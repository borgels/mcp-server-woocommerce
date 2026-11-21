# Changelog

## 0.3.1

- Licensor and copyright holder corrected to Borgels Services ApS in `LICENSE`,
  `NOTICE` and `CONTRIBUTING.md`. The license is unchanged (FSL-1.1-ALv2).

## 0.3.0

- License changed from Apache-2.0 to the Functional Source License, Version 1.1,
  ALv2 Future License (FSL-1.1-ALv2). You may read, run, modify and use the code
  internally and contribute changes; offering it as a competing commercial
  product or service is not allowed. Each version becomes Apache-2.0 two years
  after its release. Versions released before 0.3.0 remain under Apache-2.0
  (see `NOTICE`).

## 0.2.0

- Gateway error results carry failure metadata: when the upstream API
  answered with an HTTP error, the result has `failure: { httpStatus,
  requestId? }`, so a host can count failures by status without reading
  their text. `requestId` is the vendor's own id from a response header
  (`REQUEST_ID_HEADERS`: the common request-id headers), kept only
  when it is a hex id of 8 to 64 characters (one run of hex digits,
  or groups of four or more joined by single hyphens, as in a UUID) and does not hold the
  shape of a personal number. It is checked again after redaction, so an id
  that shared a piece with the key is dropped. Never the body, the vendor's
  error code or message. The shared helpers are in `src/errors.ts`
  (`vendorRequestId`, `requestIdFrom`, `failureMetadata`).

## 0.1.0

First version, built from `mcp-server-template` after the WooCommerce REST
API v3 documentation (https://woocommerce.github.io/woocommerce-rest-api-docs/).

- Access to one shop with a REST API consumer key and secret, sent as HTTP
  Basic auth over HTTPS to `<shop>/wp-json/wc/v3`. The shop address must be
  https with a public host name; a name that resolves to a private address
  is refused before each request. One gateway instance per shop; credentials
  are never read from the environment by a gateway, and a gateway never
  allows a private address.
- Read tools: connection check, sales report, orders (without the customer's
  IP address and browser, order key, cart hash, transaction id and meta
  data), order notes and refunds, products, customers (without username,
  role and meta data).
- Write tools, off by default: change an order's status, add a private order
  note (`customer_note` always false), record a refund in the shop without
  paying money back (`api_refund` and `api_restock` always false; refused
  above the total less earlier refunds, for another currency or an order
  that is not processing, on-hold or completed; serialised per shop and
  order), create a draft product, update a product, update a customer's name
  and addresses (never e-mail, password or role).
- No DELETE, no batch endpoints, no coupons, settings, payment gateways or
  new customers: the client sends only a fixed list of writes.
- Answers not shaped as documented (a record without an integer id, a list
  with an invalid entry, a write answer without the changed record) are
  errors, not partial results.
- Gateway catalog with `requiresConfirmation` (record_refund) and `change`
  per write tool, and `resolveWooCommerceChange` / `gateway.resolveChange`
  for a host that logs a change before it is sent. Audit records keep ids,
  statuses, amounts and currency, hash searches, SKUs and product names, and
  leave out names, addresses, notes and refund reasons.
- Built with the lessons of an earlier server's review: results redacted on
  the standalone MCP path as on the gateway, rejected calls audited with
  fixed codes, the change resolution runs the tool's own checks.
- After review: the built-in fetch checks the shop's addresses in the
  connection's own lookup, for every new connection, and connects to the
  address checked (DNS rebinding); addresses are classified by value
  (ipaddr.js), embedded IPv4 included. Answers are parsed with a schema per
  resource, sub-objects and lists included; a record must have the id asked
  for. The audit keeps the caller and the request id only as pseudonyms
  (`policy.pseudonymKey`, which is redacted like the shop's key). A write is
  reported as done only when the answer confirms it: a private note, the
  refund amount asked for with no money moved by the payment gateway, a
  draft product, a product or customer update with every value sent. The
  pseudonym key is at least 32 characters or bytes, admitted like the
  shop's key, and known to the error guard before anything is validated;
  registering it cannot throw (text that is not valid UTF-16 included).
  Prices are confirmed as exact decimals at the precision sent. The refunds
  of an order are read page by page (100 a page, up to 1,000, with
  `complete`).
- Not yet run against a live WooCommerce shop: the tests use answers shaped
  as the documentation shows them.
