#!/usr/bin/env python3
import hashlib
import json
from pathlib import Path

from pypdf import PdfWriter
from pypdf.generic import (
    ArrayObject,
    BooleanObject,
    DecodedStreamObject,
    DictionaryObject,
    NameObject,
    NumberObject,
    TextStringObject,
)


FIXTURE_ROOT = Path(__file__).resolve().parent
PDF_ROOT = FIXTURE_ROOT / 'pdf'
INVALID_ROOT = FIXTURE_ROOT / 'invalid'
MANIFEST_PATH = FIXTURE_ROOT / 'manifest.json'


def write_pdf(path, page_specs, *, acroform=False, geometry=None):
    writer = PdfWriter()
    for width, height in page_specs:
        page = writer.add_blank_page(width=width, height=height)
        empty_contents = DecodedStreamObject()
        empty_contents.set_data(b'')
        page[NameObject('/Contents')] = writer._add_object(empty_contents)

    writer.add_metadata({
        '/Title': f'Golden fixture: {path.stem}',
        '/Author': 'pdf-signing-demo test suite',
        '/Creator': 'test/fixtures/generate.py',
        '/Producer': 'pypdf deterministic fixture generator',
    })

    if acroform:
        acroform_object = DictionaryObject({
            NameObject('/Fields'): ArrayObject(),
            NameObject('/NeedAppearances'): BooleanObject(False),
        })
        writer._root_object[NameObject('/AcroForm')] = writer._add_object(acroform_object)

    if geometry:
        page = writer.pages[0]
        page.cropbox.lower_left = geometry['crop_lower_left']
        page.cropbox.upper_right = geometry['crop_upper_right']
        page.rotate(geometry['rotation'])

    with path.open('wb') as output:
        writer.write(output)


def add_empty_signature_field(source_path, output_path):
    writer = PdfWriter(clone_from=source_path)
    page = writer.pages[0]
    widget = DictionaryObject({
        NameObject('/Type'): NameObject('/Annot'),
        NameObject('/Subtype'): NameObject('/Widget'),
        NameObject('/FT'): NameObject('/Sig'),
        NameObject('/Rect'): ArrayObject([
            NumberObject(40),
            NumberObject(40),
            NumberObject(240),
            NumberObject(120),
        ]),
        NameObject('/T'): TextStringObject('ExistingEmptySignature'),
        NameObject('/F'): NumberObject(4),
        NameObject('/P'): page.indirect_reference,
    })
    widget_ref = writer._add_object(widget)
    page[NameObject('/Annots')] = ArrayObject([widget_ref])

    acroform = DictionaryObject({
        NameObject('/Fields'): ArrayObject([widget_ref]),
        NameObject('/SigFlags'): NumberObject(3),
    })
    writer._root_object[NameObject('/AcroForm')] = writer._add_object(acroform)
    with output_path.open('wb') as output:
        writer.write(output)


def file_record(path, *, pages=None, signature_fields=None, expected_valid=None):
    payload = path.read_bytes()
    record = {
        'sha256': hashlib.sha256(payload).hexdigest(),
        'size': len(payload),
    }
    if pages is not None:
        record['pages'] = pages
    if signature_fields is not None:
        record['signatureFields'] = signature_fields
    if expected_valid is not None:
        record['expectedValid'] = expected_valid
    return record


def main():
    PDF_ROOT.mkdir(parents=True, exist_ok=True)
    INVALID_ROOT.mkdir(parents=True, exist_ok=True)

    simple_path = PDF_ROOT / 'simple.pdf'
    write_pdf(simple_path, [(595, 842)])
    write_pdf(PDF_ROOT / 'multipage.pdf', [(595, 842), (612, 792), (420, 600)])
    write_pdf(PDF_ROOT / 'acroform.pdf', [(595, 842)], acroform=True)
    write_pdf(
        PDF_ROOT / 'nonstandard-geometry.pdf',
        [(420, 600)],
        geometry={
            'crop_lower_left': (20, 30),
            'crop_upper_right': (390, 560),
            'rotation': 90,
        },
    )
    add_empty_signature_field(simple_path, PDF_ROOT / 'empty-signature-field.pdf')

    (INVALID_ROOT / 'malformed.pdf').write_bytes(
        b'%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n'
    )
    (INVALID_ROOT / 'malformed-cms.der').write_bytes(b'\x30\x03\x02\x01')

    files = {
        'pdf/simple.pdf': file_record(simple_path, pages=1, signature_fields=0),
        'pdf/multipage.pdf': file_record(
            PDF_ROOT / 'multipage.pdf', pages=3, signature_fields=0
        ),
        'pdf/acroform.pdf': file_record(
            PDF_ROOT / 'acroform.pdf', pages=1, signature_fields=0
        ),
        'pdf/empty-signature-field.pdf': file_record(
            PDF_ROOT / 'empty-signature-field.pdf', pages=1, signature_fields=1
        ),
        'pdf/nonstandard-geometry.pdf': file_record(
            PDF_ROOT / 'nonstandard-geometry.pdf', pages=1, signature_fields=0
        ),
        'invalid/malformed.pdf': file_record(
            INVALID_ROOT / 'malformed.pdf', expected_valid=False
        ),
        'invalid/malformed-cms.der': file_record(
            INVALID_ROOT / 'malformed-cms.der', expected_valid=False
        ),
    }

    manifest = {
        'schemaVersion': 1,
        'generator': 'test/fixtures/generate.py',
        'files': files,
        'dynamicScenarios': {
            'incrementalSignatures': {
                'input': 'pdf/simple.pdf',
                'signatureCounts': [1, 2, 3, 4],
                'validators': ['OpenSSL CMS', 'pyHanko PDF'],
                'privateKeysCommitted': False,
            }
        },
    }
    MANIFEST_PATH.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + '\n',
        encoding='utf-8',
    )


if __name__ == '__main__':
    main()
