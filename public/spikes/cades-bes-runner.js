// CAdES-BES provider spike (spikes/001-cades-bes-provider-capability/README.md).
// Signs one small binary fixture with the certificate selected on the page,
// attached and detached, and keeps the CMS only in this tab until exported.
(function attachCadesBesProviderSpike(root) {
  'use strict';

  // The bytes of spikes/001-cades-bes-provider-capability/fixture.hex;
  // test/cades-bes-spike.test.js keeps the two equal.
  const FIXTURE_HEX = '000102037f80feff43416445532d4245530d0a0062696e6172790a666978747572650d0a';
  const COMBINATIONS = [
    'cryptopro:attached',
    'cryptopro:detached',
    'rutoken:attached',
    'rutoken:detached',
  ];
  const PACKAGINGS = [
    ['detached', true],
    ['attached', false],
  ];

  function normalizeBase64(value) {
    return String(value || '').replace(/\s+/g, '');
  }

  function fixtureBytes() {
    return Uint8Array.from(FIXTURE_HEX.match(/../g), (part) => Number.parseInt(part, 16));
  }

  function fixtureBase64() {
    return root.btoa(String.fromCharCode(...fixtureBytes()));
  }

  async function fixtureSha256() {
    const digest = await root.crypto.subtle.digest('SHA-256', fixtureBytes());
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
      '',
    );
  }

  async function createCryptoProObject(plugin, name) {
    return plugin.CreateObjectAsync ? plugin.CreateObjectAsync(name) : plugin.CreateObject(name);
  }

  async function setCryptoProProperty(object, asyncName, syncName, value) {
    if (typeof object[asyncName] === 'function') return object[asyncName](value);
    object[syncName] = value;
    return undefined;
  }

  async function signCryptoPro(plugin, certificate, detached) {
    const signer = await createCryptoProObject(plugin, 'CAdESCOM.CPSigner');
    await setCryptoProProperty(
      signer,
      'propset_Certificate',
      'Certificate',
      certificate.certificate,
    );
    const signedData = await createCryptoProObject(plugin, 'CAdESCOM.CadesSignedData');
    await setCryptoProProperty(
      signedData,
      'propset_ContentEncoding',
      'ContentEncoding',
      plugin.CADESCOM_BASE64_TO_BINARY,
    );
    await setCryptoProProperty(signedData, 'propset_Content', 'Content', fixtureBase64());
    return normalizeBase64(await signedData.SignCades(signer, plugin.CADESCOM_CADES_BES, detached));
  }

  async function signRutoken(plugin, certificate, detached, algorithm) {
    const options = {
      detached,
      addUserCertificate: true,
      addSignTime: true,
      addEssCert: true,
    };
    // Same as the production adapter: RSA keys sign with SHA-256.
    if (algorithm === 'rsa') {
      if (plugin.HASH_TYPE_SHA256 === undefined) {
        throw new Error('Плагин не поддерживает RSA/SHA-256.');
      }
      options.rsaHashAlgorithm = plugin.HASH_TYPE_SHA256;
    }
    return normalizeBase64(
      await plugin.sign(
        certificate.deviceId,
        certificate.certId,
        fixtureBase64(),
        plugin.DATA_FORMAT_BASE64,
        options,
      ),
    );
  }

  // getContext() returns the active plugin mode, its client and the selected
  // certificate; ensureRutokenLogin asks for the PIN and checks the key the
  // way the signing flow does; withBusy covers each provider call.
  function createRunner({
    ensureRutokenLogin,
    getContext,
    rutokenAlgorithm,
    withBusy = (_message, task) => task(),
  }) {
    const results = new Map();

    async function runCryptoPro(plugin, certificate) {
      for (const [packaging, detached] of PACKAGINGS) {
        results.set(
          `cryptopro:${packaging}`,
          await withBusy('CryptoPro подписывает тестовые данные…', () =>
            signCryptoPro(plugin, certificate, detached),
          ),
        );
      }
    }

    async function runRutoken(plugin, certificate) {
      const algorithm = rutokenAlgorithm(certificate);
      await ensureRutokenLogin(certificate.deviceId);
      try {
        for (const [packaging, detached] of PACKAGINGS) {
          results.set(
            `rutoken:${packaging}`,
            await withBusy('Рутокен подписывает тестовые данные…', () =>
              signRutoken(plugin, certificate, detached, algorithm),
            ),
          );
        }
      } finally {
        try {
          await plugin.logout(certificate.deviceId);
        } catch (_error) {
          // The signatures remain useful; logout is best-effort.
        }
      }
    }

    function status() {
      return {
        completed: COMBINATIONS.filter((key) => results.has(key)),
        total: COMBINATIONS.length,
      };
    }

    async function run() {
      const { certificate, client, mode } = getContext();
      if (mode !== 'cryptopro' && mode !== 'rutoken') {
        throw new Error('Неизвестный криптоплагин.');
      }
      if (!client) throw new Error('Плагин не готов.');
      if (!certificate) throw new Error('Сначала выберите сертификат.');
      if (mode === 'cryptopro') await runCryptoPro(client, certificate);
      else await runRutoken(client, certificate);
      return status();
    }

    async function exportBundle() {
      return {
        version: 1,
        fixtureSha256: await fixtureSha256(),
        results: status().completed.map((key) => {
          const [provider, packaging] = key.split(':');
          return { provider, packaging, cmsBase64: results.get(key) };
        }),
      };
    }

    return Object.freeze({ exportBundle, run, status });
  }

  root.PdfSigningCadesBesSpike = Object.freeze({ createRunner });
})(window);
