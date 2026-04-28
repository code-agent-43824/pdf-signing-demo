async function boot() {
  const response = await fetch('/api/form');
  const data = await response.json();
  document.getElementById('sourcePdf').src = data.pdfUrl;
  document.getElementById('docMeta').textContent = `${Math.round(data.size / 1024)} KB`;
}

document.getElementById('signButton').addEventListener('click', async () => {
  const button = document.getElementById('signButton');
  const state = document.getElementById('signedState');
  button.disabled = true;
  state.textContent = 'Подготовка PAdES-контура ещё в работе. Следующий этап — реальная подготовка документа и вызов CryptoPro.';
  try {
    const response = await fetch('/api/sign/prepare', { method: 'POST' });
    const data = await response.json();
    state.textContent = data.message;
  } catch (error) {
    state.textContent = `Ошибка: ${error.message}`;
  } finally {
    button.disabled = false;
  }
});

boot().catch((error) => {
  document.getElementById('docMeta').textContent = `Ошибка загрузки: ${error.message}`;
});
