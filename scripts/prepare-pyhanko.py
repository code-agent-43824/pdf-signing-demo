#!/usr/bin/env python3
import json
import re
import sys
import unicodedata
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

from pyhanko import stamp
from pyhanko.pdf_utils import layout, text
from pyhanko.pdf_utils.font.basic import SimpleFontEngineFactory
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.sign import fields
from pyhanko.sign.fields import enumerate_sig_fields
from pyhanko.sign.signers import cms_embedder, pdf_byterange

STAMP_MARGIN = 24
STAMP_WIDTH = 190
STAMP_HEIGHT = 64
STAMP_GAP = 10
MAX_SIGNATURES = 4
BYTES_RESERVED = 16000
APPEARANCE_FONT = SimpleFontEngineFactory('Helvetica', 0.52)
APPEARANCE_LAYOUT = layout.SimpleBoxLayoutRule(
    x_align=layout.AxisAlignment.ALIGN_MIN,
    y_align=layout.AxisAlignment.ALIGN_MID,
    margins=layout.Margins(left=8, right=8, top=7, bottom=7),
)


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


CYRILLIC_TO_LATIN = str.maketrans({
    'А': 'A', 'Б': 'B', 'В': 'V', 'Г': 'G', 'Д': 'D', 'Е': 'E', 'Ё': 'E', 'Ж': 'Zh', 'З': 'Z', 'И': 'I',
    'Й': 'Y', 'К': 'K', 'Л': 'L', 'М': 'M', 'Н': 'N', 'О': 'O', 'П': 'P', 'Р': 'R', 'С': 'S', 'Т': 'T',
    'У': 'U', 'Ф': 'F', 'Х': 'Kh', 'Ц': 'Ts', 'Ч': 'Ch', 'Ш': 'Sh', 'Щ': 'Sch', 'Ъ': '', 'Ы': 'Y',
    'Ь': '', 'Э': 'E', 'Ю': 'Yu', 'Я': 'Ya',
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e', 'ж': 'zh', 'з': 'z', 'и': 'i',
    'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't',
    'у': 'u', 'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'sch', 'ъ': '', 'ы': 'y',
    'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
})


def to_appearance_text(value, fallback=''):
    normalized = normalize(value, fallback).translate(CYRILLIC_TO_LATIN)
    ascii_text = unicodedata.normalize('NFKD', normalized).encode('ascii', 'ignore').decode('ascii')
    ascii_text = re.sub(r'\s+', ' ', ascii_text).strip(' ,;:-')
    return ascii_text or fallback


def ellipsize(value, limit):
    value = str(value or '')
    return value if len(value) <= limit else f"{value[:limit - 1]}…"


def build_metadata(signer):
    name = normalize(extract_dn_field(signer.get('subjectName'), 'CN') or signer.get('subjectName'), 'Kirill')
    issuer = normalize(extract_dn_field(signer.get('issuerName'), 'CN') or signer.get('issuerName'), 'не указан')
    cert_id = normalize(signer.get('thumbprint') or signer.get('serialNumber'), 'не указан')
    return {
        'name': name,
        'issuer': issuer,
        'cert_id': cert_id,
        'appearance_name': ellipsize(to_appearance_text(name, 'Signer'), 26),
        'appearance_issuer': ellipsize(to_appearance_text(issuer, 'Issuer'), 24),
        'appearance_cert_id': ellipsize(to_appearance_text(cert_id, 'n/a'), 20),
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
            border_width=1,
            border_color=(0.22, 0.44, 0.80),
            stamp_text='SIGNED ELECTRONICALLY\nSigner: %(signer)s\nIssuer: %(issuer)s\nCert: %(cert_id)s',
            text_box_style=text.TextBoxStyle(
                font=APPEARANCE_FONT,
                font_size=7,
                leading=9,
                text_color=(0.10, 0.16, 0.28),
            ),
            inner_content_layout=APPEARANCE_LAYOUT,
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
                    name=metadata['appearance_name'],
                    text_params={
                        'issuer': metadata['appearance_issuer'],
                        'cert_id': metadata['appearance_cert_id'],
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
