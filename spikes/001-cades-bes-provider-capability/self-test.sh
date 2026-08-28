#!/usr/bin/env bash
set -euo pipefail

spike_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(cd -- "$spike_dir/../.." && pwd)
temp_dir=$(mktemp -d)
trap 'rm -rf -- "$temp_dir"' EXIT

node - "$spike_dir/browser-runner.js" <<'JS'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const calls = [];
const signedData = {
  async propset_ContentEncoding(value) { calls.push(['cp-encoding', value]); },
  async propset_Content(value) { calls.push(['cp-content', value]); },
  async SignCades(_signer, type, detached) {
    calls.push(['cp-sign', type, detached]);
    return Buffer.from(`cryptopro-${detached}`).toString('base64');
  },
};
const cryptoPro = {
  CADESCOM_BASE64_TO_BINARY: 1,
  CADESCOM_CADES_BES: 1,
  async CreateObjectAsync(name) {
    if (name === 'CAdESCOM.CPSigner') {
      return { async propset_Certificate(value) { calls.push(['cp-certificate', value]); } };
    }
    if (name === 'CAdESCOM.CadesSignedData') return signedData;
    throw new Error(name);
  },
};
const rutoken = {
  DATA_FORMAT_BASE64: 7,
  async sign(deviceId, certId, content, format, options) {
    calls.push(['rt-sign', deviceId, certId, content, format, options]);
    return Buffer.from(`rutoken-${options.detached}`).toString('base64');
  },
  async logout(deviceId) { calls.push(['rt-logout', deviceId]); },
};
const context = {
  atob: (value) => Buffer.from(value, 'base64').toString('binary'),
  btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
  console,
  crypto: webcrypto,
  ensureRutokenLogin: async (deviceId) => calls.push(['rt-login', deviceId]),
  state: {
    activeCryptoStack: 'cryptopro',
    selectedCertificate: { certificate: 'cp-cert' },
    cryptoProviders: {
      cryptopro: { client: cryptoPro },
      rutoken: { client: rutoken },
    },
  },
};
context.window = context;
vm.runInNewContext(fs.readFileSync(process.argv[2], 'utf8'), context);

(async () => {
  const cryptoProStatus = await context.CadesBesProviderSpike.runCryptoPro();
  assert.deepEqual(Array.from(cryptoProStatus.completed), ['cryptopro:attached', 'cryptopro:detached']);
  context.state.activeCryptoStack = 'rutoken';
  context.state.selectedCertificate = { deviceId: 9, certId: 'rt-cert' };
  const rutokenStatus = await context.CadesBesProviderSpike.runRutoken();
  assert.equal(rutokenStatus.completed.length, 4);
  const bundle = await context.CadesBesProviderSpike.exportBundle();
  assert.equal(bundle.results.length, 4);
  assert.deepEqual(
    calls.filter((call) => call[0] === 'cp-sign').map((call) => call.slice(1)),
    [[1, true], [1, false]],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.filter((call) => call[0] === 'rt-sign').map((call) => call[5]))),
    [
      { detached: true, addUserCertificate: true, addSignTime: true, addEssCert: true },
      { detached: false, addUserCertificate: true, addSignTime: true, addEssCert: true },
    ],
  );
  assert.deepEqual(calls.filter((call) => call[0].startsWith('rt-')).map((call) => call[0]), [
    'rt-login', 'rt-sign', 'rt-sign', 'rt-logout',
  ]);
  console.log('CAdES-BES browser runner self-test: PASS');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
JS

xxd -r -p "$spike_dir/fixture.hex" > "$temp_dir/fixture.bin"
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 \
  -subj '/CN=CAdES BES spike self-test' \
  -keyout "$temp_dir/key.pem" -out "$temp_dir/cert.pem" >/dev/null 2>&1
python3 "$repo_dir/test/create_cms.py" \
  "$temp_dir/fixture.bin" "$temp_dir/cert.pem" "$temp_dir/key.pem" \
  "$temp_dir/detached.der"
python3 "$repo_dir/test/create_cms.py" \
  "$temp_dir/fixture.bin" "$temp_dir/cert.pem" "$temp_dir/key.pem" \
  "$temp_dir/attached.der" --attached

python3 - "$spike_dir" "$temp_dir" <<'PY'
import base64
import hashlib
import json
import sys
from pathlib import Path

spike_dir, temp_dir = map(Path, sys.argv[1:])
fixture = bytes.fromhex((spike_dir / 'fixture.hex').read_text().strip())
cms = {
    'attached': base64.b64encode((temp_dir / 'attached.der').read_bytes()).decode(),
    'detached': base64.b64encode((temp_dir / 'detached.der').read_bytes()).decode(),
}
bundle = {
    'version': 1,
    'fixtureSha256': hashlib.sha256(fixture).hexdigest(),
    'results': [
        {'provider': provider, 'packaging': packaging, 'cmsBase64': cms[packaging]}
        for provider in ('cryptopro', 'rutoken')
        for packaging in ('attached', 'detached')
    ],
}
(temp_dir / 'bundle.json').write_text(json.dumps(bundle))
PY

python3 "$spike_dir/analyze.py" "$temp_dir/bundle.json" > "$temp_dir/report.json"
python3 - "$temp_dir/report.json" <<'PY'
import json
import sys

report = json.load(open(sys.argv[1], encoding='utf-8'))
assert report['verdict'] == 'VALIDATED'
assert len(report['results']) == 4
assert all(item['cryptographicIntegrity'] == 'valid' for item in report['results'])
assert all(item['signingCertificateV2'] for item in report['results'])
print('CAdES-BES spike analyzer self-test: PASS')
PY

python3 - "$temp_dir/bundle.json" "$temp_dir/wrong-packaging.json" <<'PY'
import json
import sys

source, target = sys.argv[1:]
bundle = json.load(open(source, encoding='utf-8'))
crypto_pro = [item for item in bundle['results'] if item['provider'] == 'cryptopro']
crypto_pro[0]['cmsBase64'], crypto_pro[1]['cmsBase64'] = (
    crypto_pro[1]['cmsBase64'],
    crypto_pro[0]['cmsBase64'],
)
with open(target, 'w', encoding='utf-8') as output:
    json.dump(bundle, output)
PY
if python3 "$spike_dir/analyze.py" "$temp_dir/wrong-packaging.json" >/dev/null 2>&1; then
  echo 'analyzer accepted wrong packaging' >&2
  exit 1
fi
echo 'CAdES-BES wrong-packaging rejection: PASS'
