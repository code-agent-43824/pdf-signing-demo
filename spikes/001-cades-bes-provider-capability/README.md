# CAdES-BES provider capability spike

## Verdict: PARTIAL

Question: can the installed CryptoPro Browser Plugin and Rutoken Plugin create
canonical CAdES-BES attached and detached CMS over the same exact binary bytes?

Prepared evidence:

- one 36-byte binary fixture containing NUL, non-UTF-8 bytes and mixed CR/LF;
- `browser-runner.js`, executed only through Browser Relay on the existing
  production page, calls the real provider APIs without changing application
  code or sending data to a new endpoint; signing calls return only a safe
  completion status, while raw CMS requires a separate explicit export;
- `analyze.py` requires exactly four results, checks canonical DER, packaging,
  byte-for-byte embedded content, one `signingCertificateV2`, certificate
  inclusion and cryptographic validity through the existing RSA/GOST verifier;
- `self-test.sh` exercises both packaging modes with ephemeral RSA material and
  deletes all temporary keys, certificates and CMS on exit.

What remains: run `runCryptoPro()` and `runRutoken()` with the user's real
certificates. The returned bundle is stored only in a temporary local file,
analyzed, reduced to the safe report fields above and then deleted. Personal
CMS, certificate names, serials and fingerprints must not be committed.

Provider contract under test:

- CryptoPro: set `ContentEncoding=CADESCOM_BASE64_TO_BINARY` before `Content`,
  then call `SignCades(signer, CADESCOM_CADES_BES, detached)`;
- Rutoken: call `plugin.sign(deviceId, certId, fixtureBase64,
  DATA_FORMAT_BASE64, { detached, addUserCertificate: true, addSignTime: true,
  addEssCert: true })`. `addEssCert` is accepted by the currently used adapter,
  but is not documented in the public Rutoken API; the CMS attribute itself is
  therefore the authoritative capability check.

Do not promote this spike code into the production adapters. Rewrite the two
small signing methods normally after the verdict becomes `VALIDATED`.
