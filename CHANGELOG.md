# Changelog

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
- Not yet run against a live WooCommerce shop: the tests use answers shaped
  as the documentation shows them.
