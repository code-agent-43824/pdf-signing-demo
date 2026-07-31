# Dependency locks, audits and SBOM

## Supported runtimes

- Node.js: `22.22.2`; `.node-version` is authoritative and
  `package.json#engines` rejects other major versions.
- npm: `10.9.8`, recorded in `package.json#packageManager`.
- Python: `3.12` through `3.14`. CI exercises 3.12 and production uses
  3.14.

## Node dependencies

`package-lock.json` is the installation authority. Runtime installation
must use:

```bash
npm ci --omit=dev
```

Update dependencies with the pinned Node/npm toolchain, run
`npm install --package-lock-only`, then `npm ci` and `npm run verify`.
Do not use an uncommitted lockfile in a release.

## Python dependencies

`requirements.in` contains direct runtime packages.
`requirements.constraints.txt` pins the known-good production
transitive closure. `requirements.txt` is the generated install lock and
includes hashes for every accepted distribution.

Regenerate with Python 3.12, `pip==26.1` and `pip-tools==7.6.0`
(`pip-tools` 7.6.0 is not compatible with pip 26.2):

```bash
python -m piptools compile \
  --generate-hashes \
  --strip-extras \
  --resolver=backtracking \
  --output-file requirements.txt \
  requirements.in
```

Install only with:

```bash
python -m pip install \
  --require-hashes \
  --requirement requirements.txt
```

An intentional Python package update must change the direct pin or
constraint first, regenerate the lock, pass the complete golden suite on
Python 3.12 and the production Python 3.14 runtime, and preserve all
existing PDF signature validation invariants.

## SBOM and audits

`npm run sbom:generate` produces deterministic CycloneDX 1.5 manifests:

- `sbom/node.cdx.json` from `package-lock.json`, omitting dev packages;
- `sbom/python.cdx.json` from the complete hashed Python lock.

Volatile timestamps and UUIDs are deliberately omitted, both optional in
CycloneDX, so `npm run sbom:check` can fail CI on a stale manifest.

The CI supply-chain gates are:

1. `npm ci`;
2. hashed Python lock installation;
3. committed fixture and SBOM reproducibility checks;
4. complete test suite;
5. `npm audit --omit=dev --audit-level=high`;
6. `pip-audit` against the complete Python lock.

Browser vendor scripts are not npm runtime dependencies. Their separate
origin, version, checksum and SRI update rules are in
`docs/VENDOR_ASSETS.md`.
