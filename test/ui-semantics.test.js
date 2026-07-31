const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const PROJECT_ROOT = path.resolve(__dirname, '..');

test('UI separates integrity, trust and qualified status without false success claim', () => {
  const html = fs.readFileSync(
    path.join(PROJECT_ROOT, 'public', 'index.html'),
    'utf8',
  );
  const app = fs.readFileSync(
    path.join(PROJECT_ROOT, 'public', 'app.js'),
    'utf8',
  );
  const styles = fs.readFileSync(
    path.join(PROJECT_ROOT, 'public', 'styles.css'),
    'utf8',
  );

  assert.match(html, /Подписание PDF электронной подписью/);
  assert.match(html, /id="integrityStatusBadge"/);
  assert.match(html, /id="trustStatusBadge"/);
  assert.match(html, /id="qualifiedStatusBadge"/);
  assert.match(html, /Целостность CMS/);
  assert.match(html, /Доверие сертификату/);
  assert.match(html, /Квалифицированный статус/);
  assert.doesNotMatch(
    html,
    /успешно подписан[а-яё\s]*квалифицированной электронной подписью/i,
  );

  assert.match(app, /verification\?\.integrity\?\.status === 'valid'/);
  assert.match(app, /verification\?\.trust\?\.status === 'not_checked'/);
  assert.match(app, /verification\?\.qualified\?\.status === 'not_checked'/);
  assert.match(app, /downloadLink\.href = completeData\.downloadUrl/);
  assert.match(app, /Ссылка на результат действует до.*выгрузка одноразовая/s);
  assert.match(
    app,
    /Доверие сертификату и квалифицированный статус не проверялись/,
  );
  assert.match(
    app,
    /const cmsSignature = await oSignedData\.SignHash\([\s\S]*?return normalizeCmsBase64\(cmsSignature\);/,
  );
  assert.match(
    app,
    /const cmsSignature = await plugin\.sign\([\s\S]*?return normalizeCmsBase64\(cmsSignature\);/,
  );
  assert.match(
    styles,
    /@media \(max-width: 980px\)[\s\S]*?\.verification-item-head\s*\{\s*flex-direction: column;/,
  );
});

test('UI requires an explicit, digest-bound signing confirmation', () => {
  const html = fs.readFileSync(
    path.join(PROJECT_ROOT, 'public', 'index.html'),
    'utf8',
  );
  const app = fs.readFileSync(
    path.join(PROJECT_ROOT, 'public', 'app.js'),
    'utf8',
  );

  assert.match(html, /id="signingConfirmationDialogTemplate"/);
  assert.match(html, /id="confirmationDocumentName"/);
  assert.match(html, /id="confirmationDocumentDigest"/);
  assert.match(html, /id="confirmationCertificateFingerprint"/);
  assert.match(html, /id="confirmSigning"/);
  assert.match(app, /window\.crypto\.subtle\.digest\('SHA-256', bytes\)/);
  assert.match(
    app,
    /await openSigningConfirmationDialog\(\{[\s\S]*documentName:[\s\S]*documentDigest,[\s\S]*certificate: selectedCertificate/,
  );
  assert.ok(
    app.indexOf('await openSigningConfirmationDialog')
      < app.indexOf("fetchJsonOk('./api/sign/prepare'"),
  );
});

test('certificate usability and Rutoken PIN lifecycle are fail-closed', () => {
  const html = fs.readFileSync(
    path.join(PROJECT_ROOT, 'public', 'index.html'),
    'utf8',
  );
  const app = fs.readFileSync(
    path.join(PROJECT_ROOT, 'public', 'app.js'),
    'utf8',
  );

  assert.match(app, /isCertificateDateWindowValid/);
  assert.match(app, /HasPrivateKey/);
  assert.match(app, /IsDigitalSignatureEnabled/);
  assert.match(app, /IsNonRepudiationEnabled/);
  assert.match(
    app,
    /const categories = \[plugin\.CERT_CATEGORY_USER\]/,
  );
  assert.doesNotMatch(
    app.match(/async function enumerateRutokenCertificates[\s\S]*?return result;/)?.[0] || '',
    /CERT_CATEGORY_UNSPEC/,
  );
  assert.match(html, /id="rutokenPinInput"[^>]*data-sensitive-input/);
  assert.match(app, /finally \{\s*pin = '';/);
  assert.match(
    app,
    /querySelectorAll\('\[data-sensitive-input\]'\)[\s\S]*input\.value = ''/,
  );
  assert.doesNotMatch(app, /state\.[A-Za-z0-9_]*pin/i);
});
