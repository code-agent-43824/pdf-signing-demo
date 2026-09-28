(function attachPreviewUi(root) {
  function getSignatureCountLabel(count) {
    const absolute = Math.abs(Number(count) || 0) % 100;
    const lastDigit = absolute % 10;
    if (absolute > 10 && absolute < 20) return 'подписей';
    if (lastDigit === 1) return 'подпись';
    if (lastDigit >= 2 && lastDigit <= 4) return 'подписи';
    return 'подписей';
  }

  function validateVerification(verification) {
    const trustChecks = verification?.trust?.checks;
    const trustChecksAreExplicitlyUnknown =
      trustChecks
      && ['chain', 'validity', 'revocation', 'keyUsage'].every(
        (name) => trustChecks[name] === 'not_checked',
      );
    if (
      verification?.schemaVersion !== 1
      || verification?.integrity?.status !== 'valid'
      || verification.integrity.code !== 'CMS_INTEGRITY_VALID'
      || verification.integrity.signerCertificateMatched !== true
      || !Number.isInteger(verification.integrity.signaturesVerified)
      || verification.integrity.signaturesVerified <= 0
      || verification?.trust?.status !== 'not_checked'
      || verification.trust.code !== 'CERTIFICATE_TRUST_NOT_CHECKED'
      || !trustChecksAreExplicitlyUnknown
      || verification?.qualified?.status !== 'not_checked'
      || verification.qualified.code !== 'QUALIFIED_STATUS_NOT_CHECKED'
    ) {
      throw new Error('Сервер не вернул полный и однозначный результат проверки подписи.');
    }
    return verification.integrity.signaturesVerified;
  }

  function validateResult(completeData, now = Date.now()) {
    const resultExpiresAt = new Date(completeData.resultExpiresAt);
    if (
      !/^\.\/api\/results\/[A-Za-z0-9_-]{43}$/.test(completeData.signedPdfUrl)
      || !/^\.\/api\/results\/[A-Za-z0-9_-]{43}$/.test(completeData.downloadUrl)
      || Number.isNaN(resultExpiresAt.getTime())
      || resultExpiresAt.getTime() <= now
    ) {
      throw new Error('Сервер вернул некорректную ссылку на результат.');
    }
    return resultExpiresAt;
  }

  function createPreviewUi(
    document,
    {
      onExpired = () => {},
      onDownloadError = () => {},
      now = Date.now,
      schedule = root.setTimeout.bind(root),
      cancelSchedule = root.clearTimeout.bind(root),
      fetchResult = root.fetch.bind(root),
    } = {},
  ) {
    let currentResult = null;
    let expiryTimer = null;

    function clearExpiryTimer() {
      if (expiryTimer !== null) cancelSchedule(expiryTimer);
      expiryTimer = null;
    }

    function expireResult() {
      if (!currentResult) return;
      currentResult = null;
      clearExpiryTimer();
      document.getElementById('signedPdf').removeAttribute('src');
      const downloadLink = document.getElementById('downloadLink');
      downloadLink.classList.add('hidden');
      downloadLink.removeAttribute('href');
      document.getElementById('signedState').textContent =
        'Срок хранения подписанного файла истёк. Подпишите документ заново.';
      setMode('signed-empty');
      document.getElementById('previewTitle').textContent = 'Результат недоступен';
      onExpired();
    }

    function checkExpiry() {
      if (currentResult && now() >= currentResult.expiresAt.getTime()) expireResult();
    }

    root.addEventListener?.('focus', checkExpiry);
    root.addEventListener?.('pageshow', checkExpiry);
    document.addEventListener?.('visibilitychange', () => {
      if (!document.hidden) checkExpiry();
    });

    document.getElementById('downloadLink').addEventListener('click', async (event) => {
      event.preventDefault();
      checkExpiry();
      if (!currentResult) return;
      const result = currentResult;
      try {
        const response = await fetchResult(result.downloadUrl, { cache: 'no-store' });
        if (currentResult !== result) return;
        if (response.status === 404 || response.status === 410) {
          expireResult();
          return;
        }
        if (!response.ok) throw new Error('Не удалось скачать подписанный файл.');
        const blobUrl = root.URL.createObjectURL(await response.blob());
        if (currentResult !== result) {
          root.URL.revokeObjectURL(blobUrl);
          return;
        }
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = result.downloadName;
        link.click();
        schedule(() => root.URL.revokeObjectURL(blobUrl), 60_000);
      } catch {
        onDownloadError();
      }
    });
    function setMode(mode = 'empty') {
      document.getElementById('sourceEmpty').classList.toggle('hidden', mode !== 'empty');
      document.getElementById('sourcePdf').classList.toggle('hidden', mode !== 'source');
      document.getElementById('signedState').classList.toggle('hidden', mode !== 'signed-empty');
      document.getElementById('signedPdf').classList.toggle('hidden', mode !== 'signed');
      document.getElementById('successBanner').classList.toggle('hidden', mode !== 'signed');
      if (mode === 'signed') {
        document.getElementById('previewTitle').textContent = 'Подписанный документ';
        document.getElementById('previewHint').textContent =
          'Финальная версия PDF после встраивания подписи и штампа';
        return;
      }
      document.getElementById('previewTitle').textContent = 'Предпросмотр документа';
      document.getElementById('previewHint').textContent =
        mode === 'source'
          ? 'Исходный загруженный PDF перед подписанием'
          : 'После загрузки PDF-файла его предпросмотр появится здесь';
    }

    function setDetailsExpanded(expanded) {
      const toggle = document.getElementById('resultInfoToggle');
      toggle.setAttribute('aria-expanded', String(expanded));
      document.getElementById('verificationDetails').classList.toggle('hidden', !expanded);
    }

    function renderVerification(verification) {
      const signatureCount = validateVerification(verification);
      document.getElementById('verificationTitle').textContent = 'Подписанный файл готов';
      document.getElementById('verificationMessage').textContent =
        'Документ доступен для просмотра и скачивания в течение 15 минут.';
      document.getElementById('integrityStatusBadge').textContent = 'Подтверждена';
      document.getElementById('integrityStatusText').textContent =
        `Криптографически проверено ${signatureCount} ${getSignatureCountLabel(signatureCount)} в PDF; `
        + 'сертификат подписанта совпадает с выбранным.';
      document.getElementById('trustStatusBadge').textContent = 'Не проверено';
      document.getElementById('trustStatusText').textContent =
        'Цепочка доверия, срок, отзыв и назначение ключа не проверялись.';
      document.getElementById('qualifiedStatusBadge').textContent = 'Не подтверждён';
      document.getElementById('qualifiedStatusText').textContent =
        'Проверка по политике квалифицированной электронной подписи не выполнялась.';
      setDetailsExpanded(false);
    }

    function showEmpty(message = 'PDF ещё не загружен') {
      setMode('empty');
      document.getElementById('sourcePdf').removeAttribute('src');
      document.getElementById('docMeta').textContent = message;
      document.getElementById('viewerFileName').textContent = 'Документ не загружен';
    }

    function showSource(url, fileName, metaText) {
      document.getElementById('sourcePdf').src = url;
      setMode('source');
      document.getElementById('docMeta').textContent = metaText;
      document.getElementById('viewerFileName').textContent = fileName || 'Загруженный документ';
    }

    function resetSigned(hasSource) {
      currentResult = null;
      clearExpiryTimer();
      document.getElementById('signedPdf').removeAttribute('src');
      setMode(hasSource ? 'source' : 'empty');
      const downloadLink = document.getElementById('downloadLink');
      downloadLink.classList.add('hidden');
      downloadLink.removeAttribute('href');
      setDetailsExpanded(false);
    }

    function showSigned(completeData, now = Date.now()) {
      renderVerification(completeData.verification);
      const resultExpiresAt = validateResult(completeData, now);
      clearExpiryTimer();
      currentResult = {
        downloadUrl: completeData.downloadUrl,
        downloadName: completeData.downloadName || 'document-signed.pdf',
        expiresAt: resultExpiresAt,
      };
      document.getElementById('signedPdf').src = completeData.signedPdfUrl;
      setMode('signed');
      document.getElementById('viewerFileName').textContent = 'Подписанный документ';
      const downloadLink = document.getElementById('downloadLink');
      downloadLink.href = completeData.downloadUrl;
      downloadLink.download = completeData.downloadName || 'document-signed.pdf';
      downloadLink.classList.remove('hidden');
      expiryTimer = schedule(checkExpiry, Math.max(0, resultExpiresAt.getTime() - now));
      return resultExpiresAt;
    }

    function toggleDetails() {
      const toggle = document.getElementById('resultInfoToggle');
      setDetailsExpanded(toggle.getAttribute('aria-expanded') !== 'true');
    }

    return Object.freeze({ resetSigned, showEmpty, showSigned, showSource, toggleDetails });
  }

  root.PdfSigningPreview = Object.freeze({
    createPreviewUi,
    getSignatureCountLabel,
    validateResult,
    validateVerification,
  });
})(window);
