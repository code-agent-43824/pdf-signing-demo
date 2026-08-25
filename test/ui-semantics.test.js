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
  const previewUi = fs.readFileSync(
    path.join(PROJECT_ROOT, 'public', 'modules', 'preview-ui.js'),
    'utf8',
  );
  const orchestrator = fs.readFileSync(
    path.join(PROJECT_ROOT, 'public', 'modules', 'signing-orchestrator.js'),
    'utf8',
  );
  const cryptoProAdapter = fs.readFileSync(
    path.join(PROJECT_ROOT, 'public', 'modules', 'cryptopro-adapter.js'),
    'utf8',
  );
  const rutokenAdapter = fs.readFileSync(
    path.join(PROJECT_ROOT, 'public', 'modules', 'rutoken-adapter.js'),
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
  assert.match(html, /id="resultInfoToggle"[^>]*aria-expanded="false"/);
  assert.match(html, /Информация о подписанном файле/);
  assert.match(html, /id="verificationDetails" class="verification-details hidden"/);
  assert.doesNotMatch(
    html,
    /успешно подписан[а-яё\s]*квалифицированной электронной подписью/i,
  );

  assert.match(previewUi, /verification\?\.integrity\?\.status !== 'valid'/);
  assert.match(previewUi, /verification\?\.trust\?\.status !== 'not_checked'/);
  assert.match(previewUi, /verification\?\.qualified\?\.status !== 'not_checked'/);
  assert.match(previewUi, /downloadLink\.href = completeData\.downloadUrl/);
  assert.match(orchestrator, /можно просматривать и скачивать несколько раз/);
  assert.match(previewUi, /setDetailsExpanded\(false\)/);
  assert.match(app, /resultInfoToggle.*addEventListener\('click'/s);
  assert.match(
    previewUi,
    /Цепочка доверия, срок, отзыв и назначение ключа не проверялись/,
  );
  assert.match(
    cryptoProAdapter,
    /const cmsSignature = await signedData\.SignHash\([\s\S]*?return normalizeBase64\(cmsSignature\);/,
  );
  assert.match(
    rutokenAdapter,
    /const cmsSignature = await plugin\.sign\([\s\S]*?return normalizeBase64\(cmsSignature\);/,
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
  const orchestrator = fs.readFileSync(
    path.join(PROJECT_ROOT, 'public', 'modules', 'signing-orchestrator.js'),
    'utf8',
  );

  assert.match(html, /id="signingConfirmationDialogTemplate"/);
  assert.match(html, /id="confirmationDocumentName"/);
  assert.match(html, /id="confirmationDocumentDigest"/);
  assert.match(html, /id="confirmationCertificateFingerprint"/);
  assert.match(html, /id="confirmSigning"/);
  assert.match(app, /window\.crypto\.subtle\.digest\('SHA-256', bytes\)/);
  assert.match(orchestrator, /await confirm\(\{[\s\S]*documentName:[\s\S]*documentDigest,[\s\S]*certificate: context\.certificate/);
  assert.ok(
    orchestrator.indexOf('await confirm(') < orchestrator.indexOf('apiClient.prepare('),
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
  const cryptoProAdapter = fs.readFileSync(
    path.join(PROJECT_ROOT, 'public', 'modules', 'cryptopro-adapter.js'),
    'utf8',
  );
  const rutokenAdapter = fs.readFileSync(
    path.join(PROJECT_ROOT, 'public', 'modules', 'rutoken-adapter.js'),
    'utf8',
  );
  const certificateHelpers = fs.readFileSync(
    path.join(PROJECT_ROOT, 'public', 'modules', 'certificates.js'),
    'utf8',
  );
  const dialogs = fs.readFileSync(
    path.join(PROJECT_ROOT, 'public', 'modules', 'dialogs.js'),
    'utf8',
  );

  assert.match(certificateHelpers, /isCertificateDateWindowValid/);
  assert.match(cryptoProAdapter, /HasPrivateKey/);
  assert.match(cryptoProAdapter, /IsDigitalSignatureEnabled/);
  assert.match(cryptoProAdapter, /IsNonRepudiationEnabled/);
  assert.match(
    rutokenAdapter,
    /const categories = \[plugin\.CERT_CATEGORY_USER\]/,
  );
  assert.doesNotMatch(
    rutokenAdapter.match(/async function enumerateCertificates[\s\S]*?return result;/)?.[0] || '',
    /CERT_CATEGORY_UNSPEC/,
  );
  assert.match(html, /id="rutokenPinInput"[^>]*data-sensitive-input/);
  assert.match(
    dialogs,
    /querySelectorAll\?\.\('\[data-sensitive-input\]'\)[\s\S]*input\.value = ''/,
  );
  assert.match(app, /finally \{\s*pin = '';/);
  assert.match(
    app,
    /querySelectorAll\('\[data-sensitive-input\]'\)[\s\S]*input\.value = ''/,
  );
  assert.doesNotMatch(app, /state\.[A-Za-z0-9_]*pin/i);
});

test('signing UI is guarded by the explicit client workflow', () => {
  const html = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'app.js'), 'utf8');
  const workflow = fs.readFileSync(
    path.join(PROJECT_ROOT, 'public', 'modules', 'signing-state.js'),
    'utf8',
  );
  const orchestrator = fs.readFileSync(
    path.join(PROJECT_ROOT, 'public', 'modules', 'signing-orchestrator.js'),
    'utf8',
  );

  assert.match(html, /modules\/signing-state\.js/);
  assert.match(app, /signingWorkflow\.can\('start'\)/);
  assert.match(orchestrator, /workflow\.transition\('confirmed'\)[\s\S]*apiClient\.prepare/);
  assert.match(orchestrator, /workflow\.transition\('signed'\)[\s\S]*apiClient\.complete/);
  assert.match(orchestrator, /apiClient\.complete[\s\S]*workflow\.transition\('completed'\)/);
  assert.match(workflow, /Signing transition \$\{phase\} -> \$\{event\} is not allowed/);
});
