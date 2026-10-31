# Security and privacy review, 2026-10-31

This review covered the public source tree, public `main` history at `5a769e9`,
the six published `@hivemagnus` npm packages at version `1.0.0`, and candidate
package contents built from the fixes below.

## Fixes

- IAM access logging now records method, path, status and duration without query
  strings, which can contain OAuth codes or credentials.
- Launcher setup, status and store diagnostics omit URL userinfo, queries and
  fragments. Rejected env values are no longer included in quoting errors.
  Router and IAM dependency checks also redact their diagnostic URLs.
- Router applies the credential header filter to both caller header forwarding
  and trace redaction. Provider credentials configured by the operator remain
  available to the provider adapter.
- HiveMem rejects malformed optional JWT claims, requires an issued-at claim
  when an explicit maximum lifetime is configured, and reports malformed JWT
  JSON as an authentication failure. Malformed request JSON no longer appears
  in parser error responses. Legacy tokens may still omit optional claims when
  no explicit lifetime limit is configured.
- Skills compares session signature byte lengths before constant-time
  comparison, preventing malformed multibyte cookies from causing server errors.
- Skills now pins `@hono/node-server` to `2.1.5`, removing the dependency audit
  finding for [GHSA-rmxm-3fg6-px4f](https://github.com/advisories/GHSA-rmxm-3fg6-px4f).

Each behavior change has regression coverage, including HTTP authentication
responses, provider header construction and launcher setup/status output.

## Verification

The following checks passed locally:

- Root typechecking, builds and the complete `npm test` suite.
- OpenAPI snapshots, shell syntax and TLS bypass checks.
- Repository secret and private-data scans.
- Production dependency audits: zero reported vulnerabilities in every audited workspace.
- `npm run check:packs` for all six publishable packages.
- `npm run check:npm12`, installing packed servers through the packed launcher
  and into a separate project, including loading their native add-ons.

The six tarballs downloaded from npm were separately inspected for private
paths, unsafe archive entries and matches against the local private-term
denylist. No findings were detected. The same denylist found no matches in 610
content and metadata objects reachable from public `main` at the review base.
The private denylist is intentionally absent from the repository; these scans
do not establish that arbitrary unknown secrets are absent.

This records source and package verification. It does not certify running
installations or publish a new npm release.
