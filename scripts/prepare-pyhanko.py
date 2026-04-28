#!/usr/bin/env python3
import json
import re
import sys
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

from pyhanko import stamp
from pyhanko.pdf_utils import text
from pyhanko.pdf_utils.font import opentype
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.sign import fields
from pyhanko.sign.fields import enumerate_sig_fields
from pyhanko.sign.signers import cms_embedder, pdf_byterange

FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
STAMP_MARGIN = 24
STAMP_WIDTH = 210
STAMP_HEIGHT = 82
STAMP_GAP = 10
MAX_SIGNATURES = 4
BYTES_RESERVED = 16000


def normalize(value, fallback=''):
    clean = ' '.join(str(value or '').split()).strip()
    return clean or fallback


def split_dn(value):
    return [part.strip() for part in re.split(r',(?=(?:[^\\]|\\.)*$)', str(value or '')) if part.strip()]


def extract_dn_field(dn, field_name):
    prefix = f'{field_name}='.upper()
    for part in split_dn(dn):
        if part.upper().startswith(prefix):
            return part[len(field_name) + 1:].strip()
    return ''


def build_metadata(signer):
    name = normalize(extract_dn_field(signer.get('subjectName'), 'CN') or signer.get('subjectName'), 'Kirill')
    issuer = normalize(extract_dn_field(signer.get('issuerName'), 'CN') or signer.get('issuerName'), 'не указан')
    cert_id = normalize(signer.get('thumbprint') or signer.get('serialNumber'), 'не указан')
    return {
        'name': name,
        'issuer': issuer,
        'cert_id': cert_id,
        'reason': f'Выдан: {issuer}',
        'contact_info': f'Cert ID: {cert_id}',
    }


def compute_box(writer, existing_count):
    page = writer.root['/Pages']['/Kids'][0].get_object()
    media = page['/MediaBox']
    width = float(media[2]) - float(media[0])
    right = width - STAMP_MARGIN - (STAMP_WIDTH + STAMP_GAP) * existing_count
    left = right - STAMP_WIDTH
    return int(left), STAMP_MARGIN, int(right), STAMP_MARGIN + STAMP_HEIGHT


def main():
    if len(sys.argv) != 4:
        print('usage: prepare-pyhanko.py <input.pdf> <signer.json> <output.pdf>', file=sys.stderr)
        sys.exit(2)

    input_path = Path(sys.argv[1])
    signer = json.loads(sys.argv[2])
    output_path = Path(sys.argv[3])
    metadata = build_metadata(signer)

    with input_path.open('rb') as inf:
        writer = IncrementalPdfFileWriter(inf)
        existing_count = sum(1 for _ in enumerate_sig_fields(writer, filled_status=None))
        if existing_count >= MAX_SIGNATURES:
            raise ValueError(f'Maximum supported signatures exceeded ({MAX_SIGNATURES}).')

        field_name = f'Signature{existing_count + 1}'
        box = compute_box(writer, existing_count)
        field_spec = fields.SigFieldSpec(field_name, on_page=0, box=box, empty_field_appearance=False)

        emb = cms_embedder.PdfCMSEmbedder(field_spec)
        coroutine = emb.write_cms(field_name, writer)
        next(coroutine)

        style = stamp.TextStampStyle(
            stamp_text='Подписант: %(signer)s\nВыдан: %(issuer)s\nID: %(cert_id)s',
            text_box_style=text.TextBoxStyle(
                font=opentype.GlyphAccumulatorFactory(FONT),
                font_size=8,
            ),
        )

        sig_obj = pdf_byterange.SignatureObject(
            subfilter=fields.SigSeedSubFilter.PADES,
            name=metadata['name'],
            reason=metadata['reason'],
            contact_info=metadata['contact_info'],
            location='Web UI',
            bytes_reserved=BYTES_RESERVED,
        )

        coroutine.send(
            cms_embedder.SigObjSetup(
                sig_placeholder=sig_obj,
                appearance_setup=cms_embedder.SigAppearanceSetup(
                    style=style,
                    timestamp=datetime.now(timezone.utc),
                    name=metadata['name'],
                    text_params={
                        'issuer': metadata['issuer'],
                        'cert_id': metadata['cert_id'],
                    },
                ),
            )
        )

        prepared_digest, output = coroutine.send(
            cms_embedder.SigIOSetup(md_algorithm='sha256', output=BytesIO())
        )

        output_path.write_bytes(output.getvalue())
        print(json.dumps({
            'fieldName': field_name,
            'box': list(box),
            'existingCount': existing_count,
            'reservedStart': prepared_digest.reserved_region_start,
            'reservedEnd': prepared_digest.reserved_region_end,
        }))


if __name__ == '__main__':
    main()
