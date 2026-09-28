function createDownloadName(sourceName) {
  const leaf = String(sourceName || '')
    .split(/[\\/]/)
    .pop()
    .normalize('NFC');
  const stem = leaf
    .replace(/\.pdf$/i, '')
    .replace(/[\p{Cc}<>:"|?*\p{Cf}]/gu, '')
    .trim();
  const safeStem = Array.from(stem.replace(/[. ]+$/g, ''))
    .slice(0, 120)
    .join('');
  return `${safeStem || 'document'}-signed.pdf`;
}

function contentDisposition(kind, name) {
  const asciiFallback = 'signed-document.pdf';
  return `${kind === 'download' ? 'attachment' : 'inline'}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

module.exports = { contentDisposition, createDownloadName };
