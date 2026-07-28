#!/usr/bin/env python3
import json
import sys
from pathlib import Path

from asn1crypto import pem, x509
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.sign.validation import validate_pdf_signature
from pyhanko_certvalidator import ValidationContext


def load_certificate(path):
    payload = Path(path).read_bytes()
    if pem.detect(payload):
        _, _, payload = pem.unarmor(payload)
    return x509.Certificate.load(payload)


def main():
    if len(sys.argv) != 3:
        raise SystemExit('usage: validate_pdf.py <signed.pdf> <trusted-cert.pem>')

    cert = load_certificate(sys.argv[2])
    context = ValidationContext(trust_roots=[cert], allow_fetching=False)

    with Path(sys.argv[1]).open('rb') as source:
        reader = PdfFileReader(source)
        results = []
        for signature in reader.embedded_signatures:
            status = validate_pdf_signature(
                signature,
                signer_validation_context=context,
            )
            results.append({
                'fieldName': signature.field_name,
                'intact': bool(status.intact),
                'valid': bool(status.valid),
                'trusted': bool(status.trusted),
                'bottomLine': bool(status.bottom_line),
                'coverage': status.coverage.name,
            })

    payload = {
        'ok': bool(results) and all(
            item['intact']
            and item['valid']
            and item['trusted']
            and item['bottomLine']
            for item in results
        ),
        'signatures': results,
    }
    print(json.dumps(payload))
    if not payload['ok']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
