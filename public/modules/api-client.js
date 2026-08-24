(function attachApiClient(root) {
  function createApiClient(fetchImpl = root.fetch.bind(root)) {
    async function requestJson(url, options, fallbackMessage) {
      const response = await fetchImpl(url, options);
      const data = await response.json();
      if (!response.ok || !data.ok) {
        throw new Error(data.message || fallbackMessage);
      }
      return data;
    }

    return Object.freeze({
      loadStampConfig: () => requestJson(
        './api/stamp-config', undefined, 'Не удалось загрузить конфиг штампа.',
      ),
      loadFonts: () => requestJson(
        './api/fonts', undefined, 'Не удалось загрузить список шрифтов.',
      ),
      prepare: (payload) => requestJson(
        './api/sign/prepare',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
        'Не удалось подготовить PDF.',
      ),
      complete: (payload) => requestJson(
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
}(window));
