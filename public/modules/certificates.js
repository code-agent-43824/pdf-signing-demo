(function attachCertificateHelpers(root) {
  function isCertificateDateWindowValid(validFromDate, validToDate, now = Date.now()) {
    const validFrom = new Date(validFromDate);
    const validTo = new Date(validToDate);
    return (
      !Number.isNaN(validFrom.getTime())
      && !Number.isNaN(validTo.getTime())
      && validFrom.getTime() <= now
      && validTo.getTime() > now
    );
  }

  function isSigningKeyUsageAllowed({ present, digitalSignature, nonRepudiation }) {
    return present === false || digitalSignature === true || nonRepudiation === true;
  }

  function collectKeyUsageTokens(value, result = []) {
    if (typeof value === 'string' || typeof value === 'number') {
      result.push(String(value));
      return result;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => {
        collectKeyUsageTokens(item, result);
      });
      return result;
    }
    if (value && typeof value === 'object') {
      Object.entries(value).forEach(([key, item]) => {
        if (item === true) {
          result.push(key);
        } else if (item !== false && item !== null && item !== undefined) {
          collectKeyUsageTokens(item, result);
        }
      });
    }
    return result;
  }

  function parseDistinguishedName(value) {
    const source = String(value || '').trim();
    if (!source) return {};

    return source
      .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
      .map((part) => part.trim())
      .filter(Boolean)
      .reduce((accumulator, part) => {
        const separatorIndex = part.indexOf('=');
        if (separatorIndex === -1) return accumulator;
        const key = part.slice(0, separatorIndex).trim();
        const valuePart = part
          .slice(separatorIndex + 1)
          .trim()
          .replace(/^"|"$/g, '');
        if (key) accumulator[key] = valuePart;
        return accumulator;
      }, {});
  }

  function getCertificateCommonName(subjectName) {
    const parsed = parseDistinguishedName(subjectName);
    return parsed.CN || parsed.commonName || parsed.name || String(subjectName || '').trim();
  }

  function getCertificateIssuerLabel(issuerName) {
    const parsed = parseDistinguishedName(issuerName);
    return parsed.CN || parsed.O || parsed.OU || String(issuerName || '').trim();
  }

  function formatCertificateDate(value) {
    if (!value) return '—';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return String(value);
    return new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(parsed);
  }

  const SKIPPED_REASON_LABELS = [
    ['validity', 'срок действия истёк или не начался'],
    ['keyUsage', 'не предназначен для подписи'],
    ['privateKey', 'нет закрытого ключа'],
    ['unreadable', 'не удалось прочитать'],
  ];

  // Adapters report every certificate they do not offer, so the page can
  // explain a list shorter than the store or the token.
  function createSkippedCounter() {
    const counts = {};
    return {
      counts,
      onSkipped(reason) {
        counts[reason] = (counts[reason] || 0) + 1;
      },
    };
  }

  function describeSkippedCertificates(counts) {
    // No-break spaces keep «— 2» on the line of its reason.
    const parts = SKIPPED_REASON_LABELS.filter(([reason]) => counts?.[reason] > 0).map(
      ([reason, label]) => `${label}\u00a0—\u00a0${counts[reason]}`,
    );
    return parts.length ? `Не показаны: ${parts.join(', ')}.` : '';
  }

  root.PdfSigningCertificates = Object.freeze({
    collectKeyUsageTokens,
    createSkippedCounter,
    describeSkippedCertificates,
    formatCertificateDate,
    getCertificateCommonName,
    getCertificateIssuerLabel,
    isCertificateDateWindowValid,
    isSigningKeyUsageAllowed,
    parseDistinguishedName,
  });
})(window);
