# Browser crypto vendor assets

The browser loads crypto adapters only from `public/vendor`. Runtime network
loading of third-party JavaScript is prohibited by the application CSP.
`public/vendor/SHA256SUMS` is checked by the test suite, while `public/app.js`
also pins each dynamically inserted script with SHA-384 Subresource Integrity.

## Pinned artifacts

### CryptoPro `cadesplugin_api.js`

- Source:
  `https://www.cryptopro.ru/sites/default/files/products/cades/cadesplugin_api.js`
- Retrieved: 2026-07-30.
- Source response `Last-Modified`: 2025-11-23 08:05:01 UTC.
- Size: 42,363 bytes.
- SHA-256:
  `d54cfe9186c4b6dbe9ed73d83f289d31da7b50000b48ba3e7c278e820578086b`.
- SHA-384 SRI:
  `sha384-5w5a3gj2rEglmho8SnY3toHnjMQcHhMaXB5mtbfOLeQlxELCBi7zLlvwgG5pvUwT`.

This is CryptoPro's loader. On supported browsers it communicates with, or
loads code from, the installed CryptoPro browser extension. The CSP therefore
permits the `chrome-extension:` script scheme but no Internet script hosts.

### Rutoken adapter

- Package: `@aktivco/rutoken-plugin@1.0.9`.
- Registry:
  `https://registry.npmjs.org/@aktivco/rutoken-plugin/-/rutoken-plugin-1.0.9.tgz`.
- Upstream: `https://github.com/AktivCo/rutoken-plugin-js`.
- License: BSD-2-Clause; local copy:
  `public/vendor/LICENSE.rutoken-plugin.txt`.
- Size: 2,897 bytes.
- SHA-256:
  `612514f867c0b54db498edf470908696e1eec3389914db5740e0c2252b339ce2`.
- SHA-384 SRI:
  `sha384-Lu5PgN+MfVF7y+8cpsOnSbHd03PcEWEAJPQYmsRlhDX3u1NuI/eR3N4r9z16f8YQ`.

## Update procedure

1. Download the candidate artifact into a temporary directory. Never overwrite
   the checked-in file before review.
2. Confirm the source URL/package owner and review the diff, upstream release
   notes, and browser-extension compatibility.
3. Copy the exact reviewed bytes into `public/vendor`.
4. Recalculate SHA-256 in `public/vendor/SHA256SUMS` and SHA-384 SRI in
   `public/app.js`.
5. Run `npm test` and browser smoke tests with both real providers.
6. Commit the artifact, checksum, provenance note, and SRI update together.

An upstream change with the same URL is not accepted automatically: the local
copy changes only through this review procedure.
