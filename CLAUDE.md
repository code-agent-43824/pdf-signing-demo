# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

The line above imports the shared agent rules; Claude Code does not read
`AGENTS.md` on its own. This file adds only what is specific to this repository.
Current state, known defects and the production release: `docs/STATUS.md`.

## What this is

A web demo of PAdES PDF signing through the CryptoPro Browser Plugin or the
Rutoken Plugin. A Node.js/Express server serves a static UI and a JSON API;
Python workers (pyHanko, asn1crypto, gostcrypto) prepare PDFs and verify CMS.
Production runs behind Caddy (`deploy/`). UI text and public API error messages
are Russian.

## Commands

Toolchain: Node from `.node-version`, npm from `package.json#packageManager`,
Python in the range given in `docs/SUPPLY_CHAIN.md`, `openssl` (tests create
throwaway certificates and verify CMS) and `prlimit` at `PRLIMIT_PATH`
(`src/runtime/process-runner.js`; readiness fails without it).

```bash
./scripts/bootstrap-and-test.sh   # clean checkout: .venv, hashed pip install, npm ci, npm run verify
```

The script builds `.venv` with whatever `python3` is. If that is outside the
supported range, set up by hand with a supported interpreter:

```bash
python3.12 -m venv .venv
.venv/bin/python -m pip install --require-hashes --requirement requirements.txt
npm ci
```

The server and the tests spawn `python3` from `PATH`, so `.venv/bin` must come
first; otherwise the Python-backed tests fail with `ModuleNotFoundError`.

```bash
export PATH="$PWD/.venv/bin:$PATH"
npm test                                   # all tests (node --test --test-concurrency=1)
node --test test/runtime-controls.test.js  # one file
node --test --test-name-pattern="operation queue" test/runtime-controls.test.js  # one test by name
npm run test:golden                        # golden PAdES corpus only (test/pades-golden.test.js)
npm run verify                             # the CI gate: fixtures, tests, npm audit, SBOM
node src/server.js                         # loopback, PORT/BASE_PATH as in src/server.js
```

- No linter, formatter or build step; `public/` is served as is.
- CI also runs `pip-audit` on `requirements.txt` (step "Audit locked Python
  dependencies" in `.github/workflows/ci.yml`); `npm run verify` does not.
- The committed SBOM records the npm version: run `npm run sbom:generate` and
  `sbom:check` only with the npm from `packageManager` (CI installs it globally;
  or point `NPM_CLI` at that npm's `npm-cli.js`).
- `npm run fixtures:generate` rebuilds `test/fixtures/` deterministically, and
  `verify` fails if the output differs from the commit. A changed corpus is
  committed together with `test/fixtures/manifest.json`.
- Lock and SBOM updates: `docs/SUPPLY_CHAIN.md`. Browser vendor scripts:
  `docs/VENDOR_ASSETS.md`.

## Map of the code

### Two-phase PAdES flow

1. The browser picks a certificate; the user confirms the document name, its
   SHA-256 and the certificate fingerprint → `POST /api/sign/prepare`.
2. `prepare` (`src/routes/signing.js`): Ajv validation, then inside
   `OperationQueue.run`: `inspectCertificate` (stamp data come from the
   certificate, never from the client) → `validatePdfBuffer` (pdf-lib) →
   `stampConfiguration.toServer` → `createPreparedPdf`
   (`scripts/prepare-pyhanko.py`: incremental update, stamp, signature
   placeholder). The in-memory session keeps the exact `/ByteRange` bytes and
   the certificate SHA-256.
3. The browser signs `contentToSignBase64` as detached CAdES (CryptoPro
   `SignHash`, Rutoken `plugin.sign`) → `POST /api/sign/complete`.
4. `complete`: `normalize-cms.py` (canonical DER, GOST parameter fix-up) →
   `verify-cms.py verify` (messageDigest over the ByteRange bytes,
   signed-attributes signature, `signingCertificateV2`, certificate match) →
   `embedCmsSignature` → re-verification of **every** signature in the PDF →
   `results.save` → session `completed`. Which failures keep the session open
   for a retry is decided by `retryable` in the same route.

The response carries a `verification` object built by
`createVerificationResult`; `public/modules/preview-ui.js` rejects any other
shape.

### Backend (`src/`)

- `server.js` is the only place that reads environment variables (clamped by
  `positiveInteger`) and wires dependencies. `application.js` is a
  listener-free Express factory: security headers and CSP, request IDs, abort
  signals, JSON-only POST, routes under `BASE_PATH`. `bootstrap.js` listens on
  loopback only, sets HTTP timeouts and runs periodic cleanup.
- Routers are factories `createXRouter(deps)` with explicit dependencies. Unit
  tests pass fakes (`test/route-boundaries.test.js`);
  `test/server-surface.test.js` starts the real `node src/server.js` on a
  random port.
- Python runs only through `runIsolatedProcess` (`src/runtime/process-runner.js`):
  async spawn in its own process group, minimal environment, `prlimit`
  (mandatory when `NODE_ENV=production`), bounded stdout/stderr, and the whole
  group is killed on timeout or abort. Data pass through private temp
  directories (0700/0600). `verify-cms.py` prints its JSON result to stdout and
  `{"ok": false, "code": ...}` to stderr on failure.
- Errors: throw `HttpError(status, code, publicMessage, details)`.
  `createOperationError` maps queue, worker and storage errors to public codes;
  `sendSafeError` answers `{ok: false, code, message, requestId}`. Paths,
  exceptions, PDF, CMS, PIN, tokens, DNs and fingerprints never reach
  responses, logs or metrics; a result path is logged as
  `/api/results/:capability`.
- Signed PDFs live only in `RESULTS_DIR` outside `public/` (the server refuses
  to start otherwise) and are served through capability tokens; only token
  SHA-256 hashes are stored on disk.
- Stamp config (`config/stamp-config.json`): `src/stamp/configuration.js` maps
  font paths to opaque IDs (`FONT_ID_PATTERN` in `src/http/validation.js`). The
  schemas there are strict (`additionalProperties: false`), so a new stamp
  field needs the schema, `scripts/prepare-pyhanko.py` (`DEFAULT_CONFIG` and
  rendering) and the stamp editor in `public/app.js` and
  `public/modules/stamp-config.js`.

### Frontend (`public/`)

- No bundler or framework: `index.html` loads `public/modules/*.js` as classic
  scripts in a fixed order, then `app.js`. Each module is an IIFE that
  publishes a frozen `window.PdfSigning*` object; `app.js` wires them together
  and owns the DOM and state.
- `test/frontend-modules.test.js` runs the modules in `node:vm` with a fake
  `window`, so a module must not touch the DOM at load time and takes its
  dependencies as factory arguments.
- The CSP forbids inline scripts and `on*=` attributes. The only exception is
  the two inline scripts injected by the Firefox build of the Rutoken
  extension, allowed by hash (`RUTOKEN_FIREFOX_EXTENSION_SCRIPT_HASHES` in
  `src/application.js`; update procedure in `docs/VENDOR_ASSETS.md`). Vendor
  scripts in `public/vendor/` are pinned by `SHA256SUMS` and by SHA-384 SRI in
  `CRYPTO_SCRIPTS` (`app.js`).

### Pitfalls

- `test/ui-semantics.test.js`, `test/vendor-assets.test.js` and
  `test/deployment-pipeline.test.js` assert with regexes on source text: UI
  strings, element IDs, specific lines in `app.js`, the modules and
  `styles.css`, plus `ci.yml`, `scripts/deploy-production.sh` and the Caddy
  config. Renaming a string or moving code between files means updating these
  tests on purpose.
- The allowed runtime dependency set is asserted in `test/supply-chain.test.js`.
- A browser check without the real CryptoPro and Rutoken extensions does not
  exercise how they inject into the page. Verify a CSP change with the
  published extensions in both Chrome and Firefox: the Firefox Rutoken build
  injects inline scripts, the Chrome build does not (`docs/JOURNAL.md`).

### Other documents

- `docs/REMEDIATION_PLAN.md` — the July 2026 audit remediation plan, its
  invariants and its rollout history.
- `docs/CADES_BES_PLAN.md` — the plan for a separate CAdES-BES
  attached/detached signing mode; its provider spike is in
  `spikes/001-cades-bes-provider-capability/`.

## Invariants

- A PDF is only ever updated incrementally: existing signatures must stay valid.
- `/ByteRange` matches exactly the bytes handed to the crypto provider, and only
  a CMS the server has verified is embedded.
- The UI and the API never claim a qualified signature (see below).

## Settled decisions

- **`trust` and `qualified` stay `not_checked`.** The product boundary is
  integrity: chain, validity, revocation, key usage and a qualified-signature
  policy are not checked, so reporting more would be a false success
  (`docs/REMEDIATION_PLAN.md`, invariants and Definition of Done).
- **Loopback-only listener; metrics answer 404 from outside.** External access
  goes only through Caddy, which returns 404 for `health/metrics`: the metrics
  are for local monitoring (`README.md`, `deploy/mescheryakov.pro.caddy`).
- **One signing operation at a time.** The production host is single-core
  (`README.md`); see `SIGNING_CONCURRENCY` in `deploy/pdf-signing-demo.service`.
- **The stamp config is read-only over the API.** A public user must not change
  server configuration; personal changes stay in the browser (`README.md`,
  `docs/REMEDIATION_PLAN.md` PR-2).
- **Result links are reusable until expiry.** By the owner's decision, preview
  and download capabilities work repeatedly for the whole TTL; token hashes are
  stored beside the PDF, so a restart does not shorten it
  (`docs/REMEDIATION_PLAN.md`, "Follow-up lifecycle/UX").
- **A failed CMS check keeps the session; success consumes it.** The user can
  retry signing without preparing again, while replay after success is blocked
  (`docs/REMEDIATION_PLAN.md` §5.2).
- **Spike code stays out of the production adapters.** Provider calls are
  rewritten normally once the spike verdict is `VALIDATED`
  (`spikes/001-cades-bes-provider-capability/README.md`).
- **`requirements.constraints.txt` pins the transitive closure,** so CI and
  production Pythons resolve the same versions (see its header).

## Departures from AGENTS.md

- **§7, vendor binaries in git: `public/vendor/*.js`.** The CSP allows no
  Internet script origins, so the browser loads the crypto adapters only from
  `public/vendor`; `docs/VENDOR_ASSETS.md` makes the reviewed, committed copy
  the release artifact, together with its checksum, provenance and SRI.
- **§7, vendor binaries in git: stamp fonts in `public/assets/fonts/stamp/`**
  (licenses in `LICENSES.md` there). The reason is not recorded; ask the owner
  before moving or removing them.

## Version discipline

Releases are identified by the full commit SHA: the deploy builds
`releases/<sha>` with a `.release-revision` marker
(`scripts/deploy-production.sh`). CI and the deploy never read
`package.json#version`, but `sbom/node.cdx.json` records it, so changing it
needs `npm run sbom:generate`.

## Deployment

- **A push to `main` deploys to production** through CI (job
  `deploy-production` in `.github/workflows/ci.yml`) unless the head commit
  message contains `[skip deploy]`. Commits that do not change runtime (docs,
  spikes) carry `[skip deploy]`.
- `scripts/deploy-production.sh` runs on the server: it builds an immutable
  release, reruns the verify gate there with the production Python
  (`scripts/verify-release.sh`), smoke-tests a canary with
  `scripts/smoke-signing.js`, switches the `current` symlink atomically and
  rolls back on any later failure.
- After a deploy, read the `deploy-production` job log (a successful run
  prints `deployed <sha>`), then check the public `health/ready` and the
  neighbouring site served by the same Caddy block
  (`deploy/mescheryakov.pro.caddy`).
- The deploy installs `deploy/pdf-signing-demo.service`; the Caddy files in
  `deploy/` are reference copies that CI never applies, so changing them is
  manual work on the shared host.
- `scripts/check-observability.js` is the checker behind the production monitor.

## What the owner reviews

Real signing with the CryptoPro and Rutoken plugins needs the owner's browser,
tokens and certificates; the provider tests (`test/frontend-modules.test.js`)
only exercise fakes. Vendor script updates require that check
(`docs/VENDOR_ASSETS.md`, update procedure step 5), and so does the CAdES-BES
provider spike (its README).
