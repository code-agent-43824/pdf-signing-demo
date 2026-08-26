(function attachCryptoProAdapter(root) {
  const certificates = root.PdfSigningCertificates;

  async function createObject(plugin, name) {
    if (!plugin) throw new Error('cadesplugin не загружен');
    if (plugin.CreateObjectAsync) return plugin.CreateObjectAsync(name);
    return plugin.CreateObject(name);
  }

  async function getProp(object, asyncGetterName, syncGetterName) {
    if (typeof object[asyncGetterName] === 'function') return object[asyncGetterName]();
    if (syncGetterName in object) return object[syncGetterName];
    throw new Error(`Property ${asyncGetterName}/${syncGetterName} not available`);
  }

  async function setProp(object, asyncSetterName, syncSetterName, value) {
    if (typeof object[asyncSetterName] === 'function') return object[asyncSetterName](value);
    object[syncSetterName] = value;
  }

  function normalizeBase64(value) {
    return String(value || '')
      .replace(/-----BEGIN [^-]+-----/g, '')
      .replace(/-----END [^-]+-----/g, '')
      .replace(/\s+/g, '');
  }

  async function inspectSigningCapability(certificate) {
    const validFromDate = await getProp(certificate, 'ValidFromDate', 'ValidFromDate');
    const validToDate = await getProp(certificate, 'ValidToDate', 'ValidToDate');
    const hasPrivateKey = Boolean(await getProp(certificate, 'HasPrivateKey', 'HasPrivateKey'));
    const keyUsage = await getProp(certificate, 'KeyUsage', 'KeyUsage');
    const usage = {
      present: Boolean(await getProp(keyUsage, 'IsPresent', 'IsPresent')),
      digitalSignature: Boolean(await getProp(keyUsage, 'IsDigitalSignatureEnabled', 'IsDigitalSignatureEnabled')),
      nonRepudiation: Boolean(await getProp(keyUsage, 'IsNonRepudiationEnabled', 'IsNonRepudiationEnabled')),
    };
    return {
      validFromDate,
      validToDate,
      hasPrivateKey,
      keyUsageAllowed: certificates.isSigningKeyUsageAllowed(usage),
    };
  }

  async function enumerateCertificates(plugin) {
    const store = await createObject(plugin, 'CAdESCOM.Store');
    await store.Open(
      plugin.CADESCOM_CURRENT_USER_STORE,
      plugin.CAPICOM_MY_STORE,
      plugin.CAPICOM_STORE_OPEN_MAXIMUM_ALLOWED,
    );
    try {
      const collection = await getProp(store, 'Certificates', 'Certificates');
      const count = await getProp(collection, 'Count', 'Count');
      const result = [];
      for (let index = 1; index <= count; index += 1) {
        const certificate = await collection.Item(index);
        const subjectName = await getProp(certificate, 'SubjectName', 'SubjectName');
        const issuerName = await getProp(certificate, 'IssuerName', 'IssuerName');
        const thumbprint = await getProp(certificate, 'Thumbprint', 'Thumbprint');
        const serialNumber = await getProp(certificate, 'SerialNumber', 'SerialNumber');
        let capability;
        try {
          capability = await inspectSigningCapability(certificate);
        } catch (_error) {
          continue;
        }
        if (!certificates.isCertificateDateWindowValid(capability.validFromDate, capability.validToDate)
          || !capability.hasPrivateKey
          || !capability.keyUsageAllowed) continue;
        const publicKey = await certificate.PublicKey();
        const algorithm = await publicKey.Algorithm;
        const friendlyName = await getProp(algorithm, 'FriendlyName', 'FriendlyName');
        result.push({
          label: certificates.getCertificateCommonName(subjectName),
          commonName: certificates.getCertificateCommonName(subjectName),
          subjectName,
          issuerName,
          issuerLabel: certificates.getCertificateIssuerLabel(issuerName),
          thumbprint,
          serialNumber,
          validFromDate: capability.validFromDate,
          validToDate: capability.validToDate,
          hasPrivateKey: true,
          keyUsageAllowed: true,
          algorithm: friendlyName,
          certificate,
        });
      }
      return result;
    } finally {
      await store.Close();
    }
  }

  async function getCspVersion(plugin) {
    const about = await createObject(plugin, 'CAdESCOM.About');
    const version = await getProp(about, 'CSPVersion', 'CSPVersion');
    return version ? String(version.toString?.() || version) : '';
  }

  function detectHashAlgorithmConstant(certificate, plugin) {
    const name = `${certificate.algorithm} ${certificate.label}`.toLowerCase();
    if (name.includes('2012') && name.includes('512')) return plugin.CADESCOM_HASH_ALGORITHM_CP_GOST_3411_2012_512;
    if (name.includes('2012') && name.includes('256')) return plugin.CADESCOM_HASH_ALGORITHM_CP_GOST_3411_2012_256;
    return plugin.CADESCOM_HASH_ALGORITHM_CP_GOST_3411;
  }

  async function sign(plugin, certificate, contentToSignBase64) {
    const hashedData = await createObject(plugin, 'CAdESCOM.HashedData');
    await setProp(hashedData, 'propset_Algorithm', 'Algorithm', detectHashAlgorithmConstant(certificate, plugin));
    await setProp(hashedData, 'propset_DataEncoding', 'DataEncoding', plugin.CADESCOM_BASE64_TO_BINARY);
    await hashedData.Hash(contentToSignBase64);
    const signer = await createObject(plugin, 'CAdESCOM.CPSigner');
    await setProp(signer, 'propset_Certificate', 'Certificate', certificate.certificate);
    const signedData = await createObject(plugin, 'CAdESCOM.CadesSignedData');
    const cmsSignature = await signedData.SignHash(hashedData, signer, plugin.CADESCOM_CADES_BES);
    return normalizeBase64(cmsSignature);
  }

  async function exportCertificate(plugin, certificate) {
    if (certificate.certificateBase64) return normalizeBase64(certificate.certificateBase64);
    if (!certificate.certificate) throw new Error('Выбранный сертификат нельзя экспортировать для серверной проверки.');
    const exported = await certificate.certificate.Export(plugin.CADESCOM_ENCODE_BASE64);
    const normalized = normalizeBase64(exported);
    if (!normalized) throw new Error('Не удалось экспортировать выбранный сертификат.');
    return normalized;
  }

  function getErrorMessage(plugin, error) {
    return plugin?.getLastError ? plugin.getLastError(error) : error?.message;
  }

  function createEnvironment({ loadScript, setDiagnostic }) {
    const diagnostic = (key, state, text) => setDiagnostic(key, state, text);

    function describeError(error) {
      return getErrorMessage(root.cadesplugin, error);
    }

    function isOperational(provider) {
      return Boolean(provider?.client)
        && provider.diagnostics?.extension?.state === 'ready'
        && provider.diagnostics?.plugin?.state === 'ready'
        && provider.diagnostics?.csp?.state === 'ready';
    }

    async function initialize() {
      diagnostic('extension', 'pending', 'Проверка…');
      diagnostic('plugin', 'pending', 'Проверка…');
      diagnostic('csp', 'pending', 'Проверка…');
      try {
        await loadScript();
        const plugin = root.cadesplugin;
        if (!plugin) throw new Error('Скрипт cadesplugin_api.js не загрузился');
        diagnostic('extension', 'ready', 'доступно');

        await Promise.resolve(plugin);
        diagnostic('plugin', 'ready', 'доступен');

        let cspText = 'доступен';
        try {
          const cspVersion = await getCspVersion(plugin);
          if (cspVersion) cspText = String(cspVersion.toString?.() || cspVersion);
        } catch (_error) {
          // Версия необязательна: доступность CSP подтверждается чтением сертификатов.
        }
        diagnostic('csp', 'ready', cspText);

        return {
          ready: true,
          client: plugin,
          certificates: await enumerateCertificates(plugin),
        };
      } catch (error) {
        diagnostic('plugin', 'error', 'недоступен');
        diagnostic('csp', 'error', 'недоступен');
        if (!root.cadesplugin) diagnostic('extension', 'error', 'не найдено');
        throw error;
      }
    }

    return Object.freeze({ describeError, initialize, isOperational });
  }

  root.PdfSigningCryptoPro = Object.freeze({
    createEnvironment,
    enumerateCertificates,
    exportCertificate,
    getCspVersion,
    getErrorMessage,
    sign,
  });
}(window));
