(function attachDialogs(root) {
  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }

  function createDialogManager(document, { formatCertificateDate, getCertificateKey }) {
    let activeDialog = null;

    function close() {
      activeDialog?.querySelectorAll?.('[data-sensitive-input]').forEach((input) => {
        input.value = '';
      });
      activeDialog?.remove();
      activeDialog = null;
    }

    function rejectAndClose(reject, message) {
      close();
      reject(new Error(message));
    }

    function openPin({ title = 'Введите PIN-код токена.', errorMessage = '' } = {}) {
      return new Promise((resolve, reject) => {
        close();
        const fragment = document.getElementById('rutokenPinDialogTemplate').content.cloneNode(true);
        const backdrop = fragment.querySelector('.dialog-backdrop');
        const prompt = fragment.querySelector('#rutokenPinPrompt');
        const input = fragment.querySelector('#rutokenPinInput');
        const error = fragment.querySelector('#rutokenPinError');
        const confirm = fragment.querySelector('#confirmRutokenPin');
        const cancel = fragment.querySelector('#cancelRutokenPin');
        activeDialog = backdrop;
        prompt.textContent = title;
        if (errorMessage) {
          error.textContent = errorMessage;
          error.classList.remove('hidden');
        }
        const submit = () => {
          let pin = String(input.value || '').replace(/\D+/g, '');
          if (!pin) {
            error.textContent = 'PIN-код пустой.';
            error.classList.remove('hidden');
            input.focus();
            return;
          }
          input.value = '';
          close();
          resolve(pin);
          pin = '';
        };
        fragment.querySelectorAll('.pin-key').forEach((button) => {
          button.addEventListener('click', () => {
            if (button.dataset.key) input.value = `${input.value}${button.dataset.key}`;
            if (button.dataset.action === 'clear') input.value = '';
            if (button.dataset.action === 'backspace') input.value = input.value.slice(0, -1);
            error.classList.add('hidden');
            input.focus();
          });
        });
        input.addEventListener('input', () => {
          input.value = input.value.replace(/\D+/g, '');
          error.classList.add('hidden');
        });
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            submit();
          }
        });
        confirm.addEventListener('click', submit);
        cancel.addEventListener('click', () => rejectAndClose(reject, 'Ввод PIN-кода отменён.'));
        backdrop.addEventListener('click', (event) => {
          if (event.target === backdrop) rejectAndClose(reject, 'Ввод PIN-кода отменён.');
        });
        document.body.appendChild(backdrop);
        root.requestAnimationFrame(() => input.focus());
      });
    }

    function openSigningConfirmation({ documentName, documentDigest, certificate }) {
      return new Promise((resolve, reject) => {
        close();
        const fragment = document.getElementById('signingConfirmationDialogTemplate').content.cloneNode(true);
        const backdrop = fragment.querySelector('.dialog-backdrop');
        fragment.querySelector('#confirmationDocumentName').textContent = documentName;
        fragment.querySelector('#confirmationDocumentDigest').textContent = documentDigest;
        fragment.querySelector('#confirmationCertificateName').textContent = certificate.commonName || certificate.label || '—';
        fragment.querySelector('#confirmationCertificateFingerprint').textContent = certificate.thumbprint || '—';
        const confirm = fragment.querySelector('#confirmSigning');
        const cancel = fragment.querySelector('#cancelSigning');
        activeDialog = backdrop;
        confirm.addEventListener('click', () => { close(); resolve(); });
        cancel.addEventListener('click', () => rejectAndClose(reject, 'Подписание отменено пользователем.'));
        backdrop.addEventListener('click', (event) => {
          if (event.target === backdrop) rejectAndClose(reject, 'Подписание отменено пользователем.');
        });
        document.body.appendChild(backdrop);
        root.requestAnimationFrame(() => confirm.focus());
      });
    }

    function renderCertificateCard(certificate, index, isSelected) {
      return `
        <button type="button" class="certificate-card${isSelected ? ' is-selected' : ''}"
          data-index="${index}" role="option" aria-selected="${isSelected ? 'true' : 'false'}">
          <dl class="certificate-meta">
            <dt>Common Name</dt><dd>${escapeHtml(certificate.commonName || certificate.label || '—')}</dd>
            <dt>Issuer</dt><dd>${escapeHtml(certificate.issuerLabel || certificate.issuerName || '—')}</dd>
            <dt>Срок действия</dt><dd>${escapeHtml(formatCertificateDate(certificate.validToDate))}</dd>
          </dl>
        </button>`;
    }

    function openCertificate(certificates, preselectedCertificate = null) {
      return new Promise((resolve, reject) => {
        if (!certificates.length) {
          reject(new Error('Не найдено доступных сертификатов.'));
          return;
        }
        close();
        const fragment = document.getElementById('certificateDialogTemplate').content.cloneNode(true);
        const backdrop = fragment.querySelector('.dialog-backdrop');
        const list = fragment.querySelector('#certificateList');
        const confirm = fragment.querySelector('#confirmCertificate');
        const cancel = fragment.querySelector('#cancelCertificate');
        const preselectedKey = getCertificateKey(preselectedCertificate);
        let selectedIndex = Math.max(0, certificates.findIndex(
          (certificate) => getCertificateKey(certificate) === preselectedKey,
        ));
        activeDialog = backdrop;
        const render = () => {
          list.innerHTML = certificates
            .map((certificate, index) => renderCertificateCard(certificate, index, index === selectedIndex))
            .join('');
          list.querySelectorAll('.certificate-card').forEach((card) => {
            card.addEventListener('click', () => {
              selectedIndex = Number(card.dataset.index);
              render();
            });
          });
        };
        render();
        confirm.addEventListener('click', () => {
          const picked = certificates[selectedIndex];
          close();
          resolve(picked);
        });
        cancel.addEventListener('click', () => rejectAndClose(reject, 'Выбор сертификата отменён.'));
        backdrop.addEventListener('click', (event) => {
          if (event.target === backdrop) rejectAndClose(reject, 'Выбор сертификата отменён.');
        });
        document.body.appendChild(backdrop);
      });
    }

    return Object.freeze({ close, openCertificate, openPin, openSigningConfirmation });
  }

  root.PdfSigningDialogs = Object.freeze({ createDialogManager });
}(window));
