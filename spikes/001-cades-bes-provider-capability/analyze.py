#!/usr/bin/env python3
import base64
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

from asn1crypto import cms


ROOT = Path(__file__).resolve().parents[2]
FIXTURE_PATH = Path(__file__).with_name('fixture.hex')
EXPECTED_COMBINATIONS = {
    ('cryptopro', 'attached'),
    ('cryptopro', 'detached'),
    ('rutoken', 'attached'),
    ('rutoken', 'detached'),
}
SIGNING_CERTIFICATE_V2_OID = '1.2.840.113549.1.9.16.2.47'


def load_verifier():
    path = ROOT / 'scripts' / 'verify-cms.py'
    spec = importlib.util.spec_from_file_location('pdf_signing_cms_verifier', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def strict_base64(value):
    if not isinstance(value, str) or not value:
        raise ValueError('cmsBase64 must be a non-empty string')
    return base64.b64decode(value, validate=True)


def detached_copy(content_info):
    copy = cms.ContentInfo.load(content_info.dump(), strict=True)
    copy['content']['encap_content_info']['content'] = None
    return copy.dump()


def analyze_result(verifier, item, fixture):
    provider = item.get('provider')
    packaging = item.get('packaging')
    if (provider, packaging) not in EXPECTED_COMBINATIONS:
        raise ValueError('unexpected provider or packaging')

    cms_der = strict_base64(item.get('cmsBase64'))
    content_info = cms.ContentInfo.load(cms_der, strict=True)
    if content_info.dump() != cms_der:
        raise ValueError('non-canonical CMS DER')
    if content_info['content_type'].native != 'signed_data':
        raise ValueError('CMS is not SignedData')

    signed_data = content_info['content']
    embedded = signed_data['encap_content_info']['content'].native
    expected_attached = packaging == 'attached'
    if expected_attached != (embedded is not None):
        raise ValueError('CMS packaging does not match the requested mode')
    if expected_attached and embedded != fixture:
        raise ValueError('embedded content differs from the fixture')

    verify_der = detached_copy(content_info) if expected_attached else cms_der
    verification = verifier.verify_cms(verify_der, fixture)
    signer_infos = signed_data['signer_infos']
    signed_attrs = signer_infos[0]['signed_attrs']
    attribute_oids = [attribute['type'].dotted for attribute in signed_attrs]
    certificates = [
        item.chosen
        for item in signed_data['certificates']
        if item.name == 'certificate'
    ]

    return {
        'provider': provider,
        'packaging': packaging,
        'cmsBytes': len(cms_der),
        'canonicalDer': True,
        'embeddedContentPresent': embedded is not None,
        'embeddedContentMatched': embedded == fixture if embedded is not None else None,
        'certificateCount': len(certificates),
        'signingCertificateV2': attribute_oids.count(SIGNING_CERTIFICATE_V2_OID) == 1,
        'digestAlgorithm': verification['digestAlgorithm'],
        'signatureAlgorithm': verification['signatureAlgorithm'],
        'cryptographicIntegrity': 'valid',
    }


def main():
    if len(sys.argv) != 2:
        raise SystemExit('usage: analyze.py <transient-provider-results.json>')
    bundle = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    fixture = bytes.fromhex(FIXTURE_PATH.read_text(encoding='ascii').strip())
    fixture_sha256 = hashlib.sha256(fixture).hexdigest()
    if bundle.get('version') != 1 or bundle.get('fixtureSha256') != fixture_sha256:
        raise ValueError('fixture identity mismatch')
    items = bundle.get('results')
    if not isinstance(items, list):
        raise ValueError('results must be an array')
    combinations = [(item.get('provider'), item.get('packaging')) for item in items]
    if len(combinations) != 4 or set(combinations) != EXPECTED_COMBINATIONS:
        raise ValueError('all four unique provider/packaging results are required')

    verifier = load_verifier()
    report = {
        'verdict': 'VALIDATED',
        'fixtureBytes': len(fixture),
        'fixtureSha256': fixture_sha256,
        'results': [analyze_result(verifier, item, fixture) for item in items],
    }
    if not all(item['signingCertificateV2'] for item in report['results']):
        report['verdict'] = 'INVALIDATED'
    sys.stdout.write(json.dumps(report, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()
