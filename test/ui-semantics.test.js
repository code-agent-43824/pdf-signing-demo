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
  assert.match(
    app,
    /Доверие сертификату и квалифицированный статус не проверялись/,
  );
  assert.match(
    styles,
    /@media \(max-width: 980px\)[\s\S]*?\.verification-item-head\s*\{\s*flex-direction: column;/,
  );
});
