(function attachRutokenAdapter(root) {
  const certificates = root.PdfSigningCertificates;

  function normalizeBase64(value) {
    return String(value || '')
      .replace(/-----BEGIN [^-]+-----/g, '')
      .replace(/-----END [^-]+-----/g, '')
      .replace(/\s+/g, '');
  }

  function normalizeDn(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(normalizeDn).filter(Boolean).join(', ');
    if (typeof value === 'object') {
      const preferred = value.commonName || value.CN || value.title || value.name;
      if (preferred) return String(preferred);
      if ('rdn' in value && 'value' in value) return `${value.rdn}=${value.value}`;
      return Object.entries(value)
        .filter(([, item]) => item !== undefined && item !== null && item !== '')
        .map(([key, item]) => {
          if (Array.isArray(item)) return item.map(normalizeDn).filter(Boolean).join(', ');
          if (item && typeof item === 'object' && 'rdn' in item && 'value' in item) return `${item.rdn}=${item.value}`;
          return `${key}=${normalizeDn(item)}`;
        })
        .filter(Boolean)
        .join(', ');
    }
    return String(value);
  }

  function getDnField(value, fieldNames = []) {
    const wanted = new Set(fieldNames.map((field) => String(field).toLowerCase()));
    if (!value || typeof value === 'string') return '';
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = getDnField(item, fieldNames);
        if (found) return found;
      }
      return '';
    }
    for (const [key, item] of Object.entries(value)) {
      if (wanted.has(String(key).toLowerCase()) && item !== undefined && item !== null && item !== '') return String(item);
    }
    if ('rdn' in value && 'value' in value && wanted.has(String(value.rdn).toLowerCase())) return String(value.value);
    for (const item of Object.values(value)) {
      const found = getDnField(item, fieldNames);
      if (found) return found;
    }
    return '';
  }

  function getCommonName(value) {
    return getDnField(value, ['commonName', 'CN']) || normalizeDn(value);
  }

  function parseDate(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return new Date(value * 1000);
    if (typeof value === 'string' && value.trim()) {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    return null;
  }

  function detectHashAlgorithmConstant(certificate, plugin) {
    const name = `${certificate.algorithm || ''} ${certificate.label || ''}`.toLowerCase();
    if (name.includes('2012') && name.includes('512')) return plugin.HASH_TYPE_GOST3411_12_512;
    if (name.includes('2012') && name.includes('256')) return plugin.HASH_TYPE_GOST3411_12_256;
    if (name.includes('sha-512') || name.includes('sha512')) return plugin.HASH_TYPE_SHA512;
    if (name.includes('sha-384') || name.includes('sha384')) return plugin.HASH_TYPE_SHA384;
    if (name.includes('sha-256') || name.includes('sha256') || name.includes('rsa')) return plugin.HASH_TYPE_SHA256;
    return plugin.HASH_TYPE_GOST3411_94;
  }

  function isRsaCertificate(certificate) {
    return `${certificate.algorithm || ''} ${certificate.label || ''}`.toLowerCase().includes('rsa');
  }

  function getErrorMessage(error, plugin) {
    if (!error) return 'Неизвестная ошибка.';
    if (typeof error === 'string') return error;
    if (error.message && Number.isNaN(Number(error.message))) return error.message;
    if (plugin?.errorCodes && error?.message) {
      const code = Number(error.message);
      const matched = Object.entries(plugin.errorCodes).find(([, value]) => Number(value) === code);
      if (matched) return `${matched[0]} (${error.message})`;
    }
    return error.message || String(error);
  }

  function getErrorCode(error) {
    const message = typeof error === 'string' ? error : String(error?.message || error || '');
    const prefix = message.match(/^\s*(-?\d+)/);
    if (prefix) return Number(prefix[1]);
    const numericOnly = Number(message);
    return Number.isFinite(numericOnly) ? numericOnly : null;
  }

  function isAlreadyLoggedInError(error, plugin) {
    const message = getErrorMessage(error, plugin);
    const rawMessage = typeof error === 'string' ? error : String(error?.message || error || '');
    const code = getErrorCode(error);
    const expected = Number(plugin?.errorCodes?.ALREADY_LOGGED_IN ?? 93);
    return message.includes('ALREADY_LOGGED_IN')
      || rawMessage.includes('ALREADY_LOGGED_IN')
      || /login has already been performed/i.test(message)
      || /login has already been performed/i.test(rawMessage)
      || (Number.isFinite(code) && Number.isFinite(expected) && code === expected);
  }

  async function enumerateCertificates(plugin) {
    const deviceIds = await plugin.enumerateDevices({ mode: plugin.ENUMERATE_DEVICES_LIST });
    const result = [];
    for (const deviceId of deviceIds || []) {
      let tokenLabel = `Устройство ${deviceId}`;
      try {
        tokenLabel = await plugin.getDeviceInfo(deviceId, plugin.TOKEN_INFO_LABEL);
      } catch (_error) { /* optional label */ }
      const categories = [plugin.CERT_CATEGORY_USER].filter((value) => value !== undefined);
      const seenCertIds = new Set();
      for (const category of categories) {
        const certIds = await plugin.enumerateCertificates(deviceId, category);
        for (const certId of certIds || []) {
          if (seenCertIds.has(certId)) continue;
          seenCertIds.add(certId);
          const pem = await plugin.getCertificate(deviceId, certId);
          const parsed = await plugin.parseCertificateFromString(pem);
          const validFromDate = parseDate(parsed?.notBefore || parsed?.validFrom || parsed?.validNotBefore);
          const validToDate = parseDate(parsed?.notAfter || parsed?.validTo || parsed?.validNotAfter);
          if (!validFromDate || !validToDate
            || !certificates.isCertificateDateWindowValid(validFromDate.toISOString(), validToDate.toISOString())) continue;
          const keyUsageSource = parsed?.keyUsages ?? parsed?.keyUsage;
          const normalizedKeyUsages = certificates.collectKeyUsageTokens(keyUsageSource)
            .map((usage) => String(usage).toLowerCase().replace(/[^a-zа-я0-9]/g, ''));
          const keyUsageAllowed = keyUsageSource === undefined || keyUsageSource === null
            || normalizedKeyUsages.some((usage) => usage.includes('digitalsignature')
              || usage.includes('nonrepudiation')
              || usage.includes('contentcommitment')
              || usage.includes('цифроваяподпись'));
          if (!keyUsageAllowed) continue;
          const subjectNameRaw = normalizeDn(parsed?.subject) || certId;
          const issuerNameRaw = normalizeDn(parsed?.issuer);
          const commonName = getCommonName(parsed?.subject) || subjectNameRaw;
          const issuerCommonName = getCommonName(parsed?.issuer) || issuerNameRaw;
          result.push({
            label: commonName,
            commonName,
            subjectName: commonName,
            issuerName: issuerCommonName,
            subjectNameRaw,
            issuerNameRaw,
            issuerLabel: issuerCommonName,
            thumbprint: parsed?.thumbprint || parsed?.fingerprint || certId,
            serialNumber: parsed?.serialNumber || certId,
            validFromDate: validFromDate.toISOString(),
            validToDate: validToDate.toISOString(),
            hasPrivateKey: true,
            keyUsageAllowed: true,
            algorithm: parsed?.publicKeyAlgorithm || parsed?.signatureAlgorithm || 'Rutoken certificate',
            certificateBase64: normalizeBase64(pem),
            certId,
            deviceId,
            tokenLabel,
          });
        }
      }
    }
    return result;
  }

  async function getDeviceLabels(plugin, deviceIds = []) {
    const labels = [];
    for (const deviceId of deviceIds || []) {
      try {
        const label = await plugin.getDeviceInfo(deviceId, plugin.TOKEN_INFO_LABEL);
        labels.push(label || `Устройство ${deviceId}`);
      } catch (_error) {
        labels.push(`Устройство ${deviceId}`);
      }
    }
    return labels;
  }

  async function sign(plugin, certificate, contentToSignBase64) {
    const options = { detached: true, addSignTime: true, addEssCert: true };
    if (isRsaCertificate(certificate)) options.rsaHashAlgorithm = detectHashAlgorithmConstant(certificate, plugin);
    const cmsSignature = await plugin.sign(
      certificate.deviceId,
      certificate.certId,
      contentToSignBase64,
      plugin.DATA_FORMAT_BASE64,
      options,
    );
    return normalizeBase64(cmsSignature);
  }

  async function getPinRetriesLeft(plugin, deviceId) {
    try {
      const pinsInfo = await plugin.getDeviceInfo(deviceId, plugin.TOKEN_INFO_PINS_INFO);
      if (Number.isFinite(Number(pinsInfo?.retriesLeft))) return Number(pinsInfo.retriesLeft);
    } catch (_error) { /* use legacy fallback */ }
    try {
      const retriesLeft = await plugin.getDeviceInfo(deviceId, plugin.TOKEN_INFO_PIN_RETRIES_LEFT);
      if (Number.isFinite(Number(retriesLeft))) return Number(retriesLeft);
    } catch (_error) { /* no retry metadata */ }
    return null;
  }

  root.PdfSigningRutoken = Object.freeze({
    enumerateCertificates,
    getDeviceLabels,
    getErrorMessage,
    getPinRetriesLeft,
    isAlreadyLoggedInError,
    sign,
  });
}(window));
