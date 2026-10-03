#!/usr/bin/env python3
import base64
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

from asn1crypto import cms, core


ROOT = Path(__file__).resolve().parents[2]
FIXTURE_PATH = Path(__file__).with_name('fixture.hex')
EXPECTED_COMBINATIONS = {
    ('cryptopro', 'attached'),
    ('cryptopro', 'detached'),
    ('rutoken', 'attached'),
    ('rutoken', 'detached'),
}
SIGNING_CERTIFICATE_V2_OID = '1.2.840.113549.1.9.16.2.47'
NULL_DER = b'\x05\x00'


class AnySequence(core.SequenceOf):
    _child_spec = core.Any


def describe_parameters(encoded):
    if not encoded:
        return 'absent'
    if encoded == NULL_DER:
        return 'null'
    try:
        if encoded[0] == 0x06:
            return [core.ObjectIdentifier.load(encoded).dotted]
        return [
            core.ObjectIdentifier.load(item.dump()).dotted for item in AnySequence.load(encoded)
        ]
    except (TypeError, ValueError):
        return 'present'


def certificate_key(certificate):
    # asn1crypto has no public-key spec for GOST, so the SPKI is read raw.
    spki = AnySequence.load(certificate['tbs_certificate']['subject_public_key_info'].dump())
    algorithm = AnySequence.load(spki[0].dump())
    return {
        'algorithm': core.ObjectIdentifier.load(algorithm[0].dump()).dotted,
        'parameters': describe_parameters(algorithm[1].dump() if len(algorithm) > 1 else b''),
    }


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
    signer_info = signed_data['signer_infos'][0]
    attribute_oids = [attribute['type'].dotted for attribute in signer_info['signed_attrs']]
    certificates = [
        item.chosen for item in signed_data['certificates'] if item.name == 'certificate'
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
        'signedAttributeOids': attribute_oids,
        'digestAlgorithm': verification['digestAlgorithm'],
        'digestAlgorithmParameters': describe_parameters(
            signer_info['digest_algorithm']['parameters'].dump()
        ),
        'signatureAlgorithm': verification['signatureAlgorithm'],
        'signatureAlgorithmParameters': describe_parameters(
            signer_info['signature_algorithm']['parameters'].dump()
        ),
        'certificateKeys': [certificate_key(certificate) for certificate in certificates],
        'cryptographicIntegrity': 'valid',
    }


def load_results(paths, fixture_sha256):
    # One file per browser: the plugins may live in different browsers.
    items = []
    for path in paths:
        bundle = json.loads(Path(path).read_text(encoding='utf-8'))
        if bundle.get('version') != 1 or bundle.get('fixtureSha256') != fixture_sha256:
            raise ValueError('fixture identity mismatch')
        results = bundle.get('results')
        if not isinstance(results, list):
            raise ValueError('results must be an array')
        items.extend(results)
    return items


def main():
    # --partial analyses a subset, such as one provider whose plugin lives on
    # another machine; its verdict is never VALIDATED.
    partial = '--partial' in sys.argv[1:]
    paths = [argument for argument in sys.argv[1:] if argument != '--partial']
    if not paths:
        raise SystemExit('usage: analyze.py [--partial] <transient-provider-results.json>...')
    fixture = bytes.fromhex(FIXTURE_PATH.read_text(encoding='ascii').strip())
    fixture_sha256 = hashlib.sha256(fixture).hexdigest()
    items = load_results(paths, fixture_sha256)
    combinations = [(item.get('provider'), item.get('packaging')) for item in items]
    if partial:
        if (
            not combinations
            or len(set(combinations)) != len(combinations)
            or not set(combinations) <= EXPECTED_COMBINATIONS
        ):
            raise ValueError('partial results must be unique known provider/packaging pairs')
    elif len(combinations) != 4 or set(combinations) != EXPECTED_COMBINATIONS:
        raise ValueError('all four unique provider/packaging results are required')

    verifier = load_verifier()
    missing = EXPECTED_COMBINATIONS - set(combinations)
    report = {
        'verdict': 'PARTIAL' if missing else 'VALIDATED',
        'fixtureBytes': len(fixture),
        'fixtureSha256': fixture_sha256,
        'missing': sorted(f'{provider}:{packaging}' for provider, packaging in missing),
        'results': [analyze_result(verifier, item, fixture) for item in items],
    }
    if not all(item['signingCertificateV2'] for item in report['results']):
        report['verdict'] = 'INVALIDATED'
    sys.stdout.write(json.dumps(report, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()
