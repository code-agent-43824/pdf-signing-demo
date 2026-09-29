(function attachApiClient(root) {
  function createApiClient(fetchImpl = root.fetch.bind(root)) {
    async function requestJson(url, options, fallbackMessage) {
      const response = await fetchImpl(url, options);
      const data = await response.json();
      if (!response.ok || !data.ok) {
        const message = data.message || fallbackMessage;
        // `reason` is the verifier code of a failed CMS or certificate check.
        const error = new Error(data.reason ? `${message} Код причины: ${data.reason}.` : message);
        error.code = data.code;
        error.reason = data.reason;
        error.requestId = data.requestId;
        throw error;
      }
      return data;
    }

    return Object.freeze({
      loadStampConfig: () =>
        requestJson('./api/stamp-config', undefined, 'Не удалось загрузить конфиг штампа.'),
      loadFonts: () =>
        requestJson('./api/fonts', undefined, 'Не удалось загрузить список шрифтов.'),
      prepare: (payload) =>
        requestJson(
          './api/sign/prepare',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          },
          'Не удалось подготовить PDF.',
        ),
      complete: (payload) =>
        requestJson(
          './api/sign/complete',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          },
          'Не удалось встроить подпись в PDF.',
        ),
    });
  }

  root.PdfSigningApi = Object.freeze({ createApiClient });
})(window);
