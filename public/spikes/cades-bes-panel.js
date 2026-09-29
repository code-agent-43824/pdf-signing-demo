// Page panel for the CAdES-BES provider spike: the owner signs the test
// fixture with each plugin and downloads the result for the agent, without a
// developer console. app.js mounts it only for ?spike=cades-bes.
(function attachCadesBesSpikePanel(root) {
  'use strict';

  const FILE_NAME = 'cades-bes-spike.json';
  const PROVIDERS = [
    ['cryptopro', 'CryptoPro'],
    ['rutoken', 'Рутокен'],
  ];
  const STEPS = [
    'Выберите плагин и сертификат, как для обычной подписи.',
    'Нажмите «Подписать тестовые данные». Рутокен попросит PIN, CryptoPro может спросить разрешение или пароль контейнера.',
    'Переключите плагин и повторите.',
    'Нажмите «Скачать результат» и отправьте файл агенту.',
  ];

  function createNode(document, tag, { className, id, text, type } = {}) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (id) node.id = id;
    if (type) node.type = type;
    if (text) node.textContent = text;
    return node;
  }

  function describeProgress({ completed, total }) {
    const providers = PROVIDERS.map(([provider, label]) => {
      const done = completed.filter((key) => key.startsWith(`${provider}:`)).length;
      if (done === 0) return `${label} — нет`;
      return `${label} — ${done === 2 ? 'готово' : `${done} из 2`}`;
    });
    return `Готово ${completed.length} из ${total}: ${providers.join(', ')}.`;
  }

  function mount(document, { anchor, describeError, getProviderLabel, runner }) {
    const section = createNode(document, 'section', {
      className: 'panel spike-panel',
      id: 'cadesBesSpikePanel',
    });
    section.setAttribute('aria-labelledby', 'cadesBesSpikeTitle');
    const intro = createNode(document, 'p', {
      className: 'muted',
      text: 'Служебная проверка для разработки. Подписывается только короткий тестовый набор байт: PDF не нужен, на сервер ничего не отправляется. Подписи хранятся только в этой вкладке — не перезагружайте её, пока не скачаете файл.',
    });
    const steps = createNode(document, 'ol');
    steps.append(...STEPS.map((text) => createNode(document, 'li', { text })));
    const progress = createNode(document, 'p', { id: 'cadesBesSpikeProgress' });
    progress.setAttribute('aria-live', 'polite');
    const runButton = createNode(document, 'button', {
      className: 'primary',
      id: 'cadesBesSpikeRun',
      text: 'Подписать тестовые данные',
      type: 'button',
    });
    const downloadButton = createNode(document, 'button', {
      className: 'secondary',
      id: 'cadesBesSpikeDownload',
      text: 'Скачать результат',
      type: 'button',
    });
    const actions = createNode(document, 'div', { className: 'topbar-actions' });
    actions.append(runButton, downloadButton);
    const message = createNode(document, 'p', { className: 'muted', id: 'cadesBesSpikeMessage' });
    message.setAttribute('aria-live', 'polite');
    section.append(
      createNode(document, 'h2', { id: 'cadesBesSpikeTitle', text: 'Проверка CAdES-BES' }),
      intro,
      steps,
      progress,
      actions,
      message,
    );

    let objectUrl = null;

    function render() {
      const current = runner.status();
      progress.textContent = describeProgress(current);
      downloadButton.disabled = current.completed.length === 0;
    }

    runButton.addEventListener('click', async () => {
      const label = getProviderLabel();
      runButton.disabled = true;
      message.textContent = `${label}: подписываю тестовые данные…`;
      try {
        await runner.run();
        message.textContent = `${label}: тестовые данные подписаны.`;
      } catch (error) {
        message.textContent =
          error?.code === 'USER_CANCELLED'
            ? `${label}: отменено.`
            : `${label}: ошибка — ${describeError(error)}`;
      } finally {
        runButton.disabled = false;
        render();
      }
    });

    downloadButton.addEventListener('click', async () => {
      try {
        const bundle = await runner.exportBundle();
        const blob = new root.Blob([`${JSON.stringify(bundle, null, 2)}\n`], {
          type: 'application/json',
        });
        if (objectUrl) root.URL.revokeObjectURL(objectUrl);
        objectUrl = root.URL.createObjectURL(blob);
        const link = createNode(document, 'a');
        link.href = objectUrl;
        link.download = FILE_NAME;
        link.hidden = true;
        document.body.append(link);
        link.click();
        link.remove();
        message.textContent = `Файл ${FILE_NAME} сохранён: подписей ${bundle.results.length} из 4. Отправьте его агенту.`;
      } catch (error) {
        message.textContent = `Не удалось сохранить файл: ${error.message}`;
      }
    });

    render();
    anchor.after(section);
    return section;
  }

  root.PdfSigningCadesBesSpikePanel = Object.freeze({ mount });
})(window);
