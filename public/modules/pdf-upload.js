(function attachPdfUpload(root) {
  const MAX_PDF_BYTES = 10 * 1024 * 1024;

  async function validate(file) {
    if (file.size > MAX_PDF_BYTES) {
      throw new Error('PDF превышает лимит 10 МиБ. Выберите файл меньшего размера.');
    }
    const header = new Uint8Array(await file.slice(0, 5).arrayBuffer());
    if (header.length !== 5 || String.fromCharCode(...header) !== '%PDF-') {
      throw new Error('Это не PDF-файл. Выберите документ PDF.');
    }
  }

  root.PdfSigningPdfUpload = Object.freeze({ validate });
})(window);
