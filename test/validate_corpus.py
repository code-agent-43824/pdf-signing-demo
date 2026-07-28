#!/usr/bin/env python3
import hashlib
import json
from pathlib import Path

from asn1crypto import cms
from pypdf import PdfReader


ROOT = Path(__file__).resolve().parent / 'fixtures'
MANIFEST = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))


def count_signature_fields(reader):
    acroform = reader.trailer['/Root'].get('/AcroForm')
    if not acroform:
        return 0
    return sum(
        1
        for field in acroform.get_object().get('/Fields', [])
        if field.get_object().get('/FT') == '/Sig'
    )


def main():
    for relative_path, expected in MANIFEST['files'].items():
        path = ROOT / relative_path
        payload = path.read_bytes()
        assert len(payload) == expected['size'], relative_path
        assert hashlib.sha256(payload).hexdigest() == expected['sha256'], relative_path

        if relative_path.endswith('.pdf') and expected.get('expectedValid') is not False:
            reader = PdfReader(path, strict=True)
            assert len(reader.pages) == expected['pages'], relative_path
            assert count_signature_fields(reader) == expected['signatureFields'], relative_path

    malformed_pdf = ROOT / 'invalid' / 'malformed.pdf'
    try:
        PdfReader(malformed_pdf, strict=True)
    except Exception:
        pass
    else:
        raise AssertionError('malformed.pdf unexpectedly parsed as a valid PDF')

    malformed_cms = (ROOT / 'invalid' / 'malformed-cms.der').read_bytes()
    try:
        cms.ContentInfo.load(malformed_cms, strict=True)
    except Exception:
        pass
    else:
        raise AssertionError('malformed-cms.der unexpectedly parsed as valid CMS')

    print(json.dumps({
        'ok': True,
        'fixtures': len(MANIFEST['files']),
        'dynamicSignatureCounts': (
            MANIFEST['dynamicScenarios']['incrementalSignatures']['signatureCounts']
        ),
    }))


if __name__ == '__main__':
    main()
