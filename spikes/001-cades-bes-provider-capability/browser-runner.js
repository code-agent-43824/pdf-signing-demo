(function attachCadesBesProviderSpike(root) {
  'use strict';

  const FIXTURE_HEX = '000102037f80feff43416445532d4245530d0a0062696e6172790a666978747572650d0a';
  const results = new Map();

  function normalizeBase64(value) {
    return String(value || '').replace(/\s+/g, '');
  }

  function fixtureBase64() {
    const bytes = FIXTURE_HEX.match(/../g).map((part) => Number.parseInt(part, 16));
    return btoa(String.fromCharCode(...bytes));
  }

  async function fixtureSha256() {
    const bytes = Uint8Array.from(FIXTURE_HEX.match(/../g), (part) => Number.parseInt(part, 16));
    const digest = await root.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function selectedCertificate(provider) {
    if (state.activeCryptoStack !== provider || !state.selectedCertificate) {
      throw new Error(`Сначала выберите сертификат ${provider} в основном интерфейсе.`);
    }
    return state.selectedCertificate;
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
    await setCryptoProProperty(signer, 'propset_Certificate', 'Certificate', certificate.certificate);
    const signedData = await createCryptoProObject(plugin, 'CAdESCOM.CadesSignedData');
    await setCryptoProProperty(
      signedData,
      'propset_ContentEncoding',
      'ContentEncoding',
      plugin.CADESCOM_BASE64_TO_BINARY,
    );
    await setCryptoProProperty(signedData, 'propset_Content', 'Content', fixtureBase64());
    return normalizeBase64(await signedData.SignCades(
      signer,
      plugin.CADESCOM_CADES_BES,
      detached,
    ));
  }

  async function runCryptoPro() {
    const certificate = selectedCertificate('cryptopro');
    const plugin = state.cryptoProviders.cryptopro.client;
    if (!plugin) throw new Error('CryptoPro не готов.');
    results.set('cryptopro:detached', await signCryptoPro(plugin, certificate, true));
    results.set('cryptopro:attached', await signCryptoPro(plugin, certificate, false));
    return status();
  }

  async function signRutoken(plugin, certificate, detached) {
    return normalizeBase64(await plugin.sign(
      certificate.deviceId,
      certificate.certId,
      fixtureBase64(),
      plugin.DATA_FORMAT_BASE64,
      {
        detached,
        addUserCertificate: true,
        addSignTime: true,
        addEssCert: true,
      },
    ));
  }

  async function runRutoken() {
    const certificate = selectedCertificate('rutoken');
    const plugin = state.cryptoProviders.rutoken.client;
    if (!plugin) throw new Error('Рутокен не готов.');
    await ensureRutokenLogin(certificate.deviceId);
    try {
      results.set('rutoken:detached', await signRutoken(plugin, certificate, true));
      results.set('rutoken:attached', await signRutoken(plugin, certificate, false));
      return status();
    } finally {
      try {
        await plugin.logout(certificate.deviceId);
      } catch (_error) {
        // The signing result remains useful; logout is best-effort.
      }
    }
  }

  async function exportBundle() {
    return {
      version: 1,
      fixtureSha256: await fixtureSha256(),
      results: Array.from(results, ([key, cmsBase64]) => {
        const [provider, packaging] = key.split(':');
        return { provider, packaging, cmsBase64 };
      }),
    };
  }

  async function status() {
    return {
      fixtureSha256: await fixtureSha256(),
      completed: Array.from(results.keys()).sort(),
    };
  }

  function clear() {
    results.clear();
  }

  root.CadesBesProviderSpike = Object.freeze({ clear, exportBundle, runCryptoPro, runRutoken, status });
}(window));
