(function attachSigningOrchestrator(root) {
  function createSigningOrchestrator({
    apiClient,
    confirm,
    ensureRutokenLogin,
    exportCertificate,
    getContext,
    refreshRutoken,
    sha256,
    showResult,
    signCryptoPro,
    signRutoken,
    status,
    updateAction,
    workflow,
  }) {
    async function run() {
      workflow.transition('start');
      try {
        let context = getContext();
        if (context.mode === 'rutoken') await refreshRutoken();
        context = getContext();
        if (!context.pluginReady) throw new Error(`${context.providerLabel} plugin не готов.`);
        if (!context.pdfBase64) throw new Error('Сначала загрузите PDF-документ для подписи.');
        if (!context.certificate) throw new Error('Сначала выберите сертификат для подписи.');

        const documentDigest = await sha256(context.pdfBase64);
        await confirm({
          documentName: context.pdfName || 'Документ.pdf',
          documentDigest,
          certificate: context.certificate,
        });
        const certificateBase64 = await exportCertificate(context.certificate);
        workflow.transition('confirmed');

        status('Подготавливаю PDF под PAdES…');
        const prepared = await apiClient.prepare({
          pdfBase64: context.pdfBase64,
          stampConfig: context.stampConfig,
          requestedStampPosition: context.stampPosition,
          signer: { certificateBase64 },
        });
        workflow.transition('prepared');

        status(`Прошу ${context.providerLabel} подписать хеш сертификатом: ${context.certificate.label}`);
        let cmsSignatureBase64;
        try {
          if (context.mode === 'rutoken') await ensureRutokenLogin(context.certificate.deviceId);
          cmsSignatureBase64 = context.mode === 'rutoken'
            ? await signRutoken(context.certificate, prepared.contentToSignBase64)
            : await signCryptoPro(context.certificate, prepared.contentToSignBase64);
        } finally {
          if (context.mode === 'rutoken') await context.logoutRutoken(context.certificate.deviceId);
        }
        workflow.transition('signed');

        status('Встраиваю CMS-подпись обратно в PDF…');
        const completed = await apiClient.complete({
          sessionId: prepared.sessionId,
          cmsSignatureBase64,
        });
        const resultExpiresAt = showResult(completed);
        status(
          'Готово. Подписанный PDF можно просматривать и скачивать несколько раз '
          + `до ${resultExpiresAt.toLocaleTimeString('ru-RU', {
            hour: '2-digit',
            minute: '2-digit',
          })} (15 минут).`,
        );
        workflow.transition('completed');
        return completed;
      } catch (error) {
        if (workflow.can('failed')) workflow.transition('failed');
        throw error;
      } finally {
        updateAction();
      }
    }

    return Object.freeze({ run });
  }

  root.PdfSigningOrchestrator = Object.freeze({ createSigningOrchestrator });
}(window));
