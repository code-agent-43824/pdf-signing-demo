#!/usr/bin/env python3
import json
import re
import sys
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from pyhanko import stamp
from pyhanko.pdf_utils import layout, text
from pyhanko.pdf_utils.images import PdfImage
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.sign import fields
from pyhanko.sign.fields import enumerate_sig_fields
from pyhanko.sign.signers import cms_embedder, pdf_byterange

STAMP_MARGIN = 24
STAMP_WIDTH = 176
STAMP_HEIGHT = 82
STAMP_GAP = 5
STAMP_ROW_GAP = 10
MAX_SIGNATURES = 4
MAX_STAMPS_PER_ROW = 3
BYTES_RESERVED = 16000
TITLE_FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf'
BODY_FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
IMAGE_SCALE = 4
BACKGROUND_LAYOUT = layout.SimpleBoxLayoutRule(
    x_align=layout.AxisAlignment.ALIGN_MID,
    y_align=layout.AxisAlignment.ALIGN_MID,
    margins=layout.Margins(left=0, right=0, top=0, bottom=0),
    inner_content_scaling=layout.InnerScaling.NO_SCALING,
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


def build_metadata(signer):
    name = normalize(extract_dn_field(signer.get('subjectName'), 'CN') or signer.get('subjectName'), 'Подписант')
    issuer = normalize(extract_dn_field(signer.get('issuerName'), 'CN') or signer.get('issuerName'), 'не указан')
    cert_id = normalize(signer.get('thumbprint') or signer.get('serialNumber'), 'не указан')
    return {
        'name': name,
        'issuer': issuer,
        'cert_id': cert_id,
        'appearance_name': name,
        'appearance_issuer': issuer,
        'appearance_cert_id': cert_id,
        'reason': f'Выдан: {issuer}',
        'contact_info': f'Cert ID: {cert_id}',
    }


def compute_box(writer, existing_count):
    page = writer.root['/Pages']['/Kids'][0].get_object()
    media = page['/MediaBox']
    width = float(media[2]) - float(media[0])
    column = existing_count % MAX_STAMPS_PER_ROW
    row = existing_count // MAX_STAMPS_PER_ROW
    right = width - STAMP_MARGIN - (STAMP_WIDTH + STAMP_GAP) * column
    left = right - STAMP_WIDTH
    bottom = STAMP_MARGIN + (STAMP_HEIGHT + STAMP_ROW_GAP) * row
    top = bottom + STAMP_HEIGHT
    return int(left), int(bottom), int(right), int(top)


def fit_text(draw, value, font, max_width):
    original = str(value or '').strip()
    value = original
    if not value:
        return ''
    while value and draw.textlength(value, font=font) > max_width:
        value = value[:-1].rstrip()
    return value if value == original else f'{value}…'


def wrap_text_lines(draw, value, font, max_width, max_lines=2, break_anywhere=False):
    value = str(value or '').strip()
    if not value:
        return ['']

    units = list(value) if break_anywhere else value.split()
    lines = []
    current = ''
    index = 0

    while index < len(units):
        unit = units[index]
        candidate = f'{current}{unit}' if break_anywhere else f'{current} {unit}'.strip()
        if not current or draw.textlength(candidate, font=font) <= max_width:
            current = candidate
            index += 1
            continue
        lines.append(current)
        current = ''
        if len(lines) >= max_lines - 1:
            break

    if index < len(units):
        remainder = ''.join(units[index:]) if break_anywhere else ' '.join(units[index:])
        current = f'{current}{remainder}' if break_anywhere else f'{current} {remainder}'.strip()

    lines.append(fit_text(draw, current, font, max_width))
    return [line for line in lines[:max_lines] if line]


def render_stamp_image(metadata):
    width = STAMP_WIDTH * IMAGE_SCALE
    height = STAMP_HEIGHT * IMAGE_SCALE
    image = Image.new('RGBA', (width, height), '#F5F8FF')
    draw = ImageDraw.Draw(image)

    border_color = '#3F68B8'
    text_color = '#1A2842'
    accent_color = '#6E87BC'

    draw.rounded_rectangle((0, 0, width - 1, height - 1), radius=18, outline=border_color, width=4, fill='#F5F8FF')
    draw.line((28, 56, width - 28, 56), fill=accent_color, width=3)

    title_font = ImageFont.truetype(TITLE_FONT, 22)
    label_font = ImageFont.truetype(TITLE_FONT, 15)
    value_font = ImageFont.truetype(BODY_FONT, 17)

    content_left = 28
    content_right = width - 28
    y = 16
    draw.text((content_left, y), 'Электронная подпись', font=title_font, fill=text_color)
    y += 42

    rows = [
        ('ФИО', metadata['appearance_name'], False),
        ('УЦ', metadata['appearance_issuer'], False),
        ('ID', metadata['appearance_cert_id'], True),
    ]
    for label, raw_value, break_anywhere in rows:
        label_text = f'{label}:'
        label_width = draw.textlength(label_text, font=label_font)
        value_x = content_left + label_width + 10
        max_width = max(content_right - value_x, 40)
        lines = wrap_text_lines(draw, raw_value, value_font, max_width, max_lines=2, break_anywhere=break_anywhere)
        draw.text((content_left, y), label_text, font=label_font, fill=text_color)
        draw.text((value_x, y - 1), lines[0], font=value_font, fill=text_color)
        if len(lines) > 1:
            y += 16
            draw.text((value_x, y - 1), lines[1], font=value_font, fill=text_color)
        y += 20

    return image


def build_stamp_style(metadata):
    stamp_image = PdfImage(
        render_stamp_image(metadata),
        box=layout.BoxConstraints(width=STAMP_WIDTH, height=STAMP_HEIGHT),
    )
    return stamp.TextStampStyle(
        border_width=0,
        background=stamp_image,
        background_layout=BACKGROUND_LAYOUT,
        background_opacity=1,
        stamp_text='',
        text_box_style=text.TextBoxStyle(font_size=1, leading=1),
    )


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

        style = build_stamp_style(metadata)

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
                    name=None,
                    text_params={},
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
