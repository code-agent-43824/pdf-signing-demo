#!/usr/bin/env python3
import json
import re
import sys
from io import BytesIO
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.sign import fields
from pyhanko.sign.fields import enumerate_sig_fields
from pyhanko.sign.signers import cms_embedder, pdf_byterange
from reportlab.lib import colors
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

FONT_REGULAR = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
FONT_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
REPORTLAB_FONT_REGULAR = 'WatsonDejaVuSans'
REPORTLAB_FONT_BOLD = 'WatsonDejaVuSansBold'
STAMP_MARGIN = 24
STAMP_WIDTH = 190
STAMP_HEIGHT = 64
STAMP_GAP = 10
MAX_SIGNATURES = 4
BYTES_RESERVED = 16000
STAMP_BG = colors.HexColor('#F4F7FF')
STAMP_BORDER = colors.HexColor('#4D79D8')
STAMP_TEXT = colors.HexColor('#1C2D52')
TITLE_TEXT = 'ПОДПИСАНО ЭЛЕКТРОННО'


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
    name = normalize(extract_dn_field(signer.get('subjectName'), 'CN') or signer.get('subjectName'), 'Кирилл')
    issuer = normalize(extract_dn_field(signer.get('issuerName'), 'CN') or signer.get('issuerName'), 'не указан')
    cert_id = normalize(signer.get('thumbprint') or signer.get('serialNumber'), 'не указан')
    return {
        'name': name,
        'issuer': issuer,
        'cert_id': cert_id,
        'reason': f'Выдан: {issuer}',
        'contact_info': f'Cert ID: {cert_id}',
    }


def ensure_fonts_registered():
    registered = set(pdfmetrics.getRegisteredFontNames())
    if REPORTLAB_FONT_REGULAR not in registered:
        pdfmetrics.registerFont(TTFont(REPORTLAB_FONT_REGULAR, FONT_REGULAR))
    if REPORTLAB_FONT_BOLD not in registered:
        pdfmetrics.registerFont(TTFont(REPORTLAB_FONT_BOLD, FONT_BOLD))


def fit_text(text_value, font_name, font_size, max_width):
    value = str(text_value or '').strip()
    if not value:
        return ''
    while value and pdfmetrics.stringWidth(value, font_name, font_size) > max_width:
        value = value[:-1].rstrip()
    return value if value == str(text_value or '').strip() else f'{value}…'



def wrap_text(value, font_name, font_size, max_width, max_lines=1):
    words = str(value or '').split()
    if not words:
        return ['']
    lines = []
    current = words[0]
    for word in words[1:]:
        candidate = f'{current} {word}'
        if pdfmetrics.stringWidth(candidate, font_name, font_size) <= max_width:
            current = candidate
        else:
            lines.append(fit_text(current, font_name, font_size, max_width))
            current = word
    lines.append(fit_text(current, font_name, font_size, max_width))
    if len(lines) <= max_lines:
        return lines
    kept = lines[:max_lines]
    tail = ' '.join(lines[max_lines - 1:])
    kept[-1] = fit_text(tail, font_name, font_size, max_width)
    return kept


def apply_visual_stamp(source_bytes, box, metadata):
    ensure_fonts_registered()
    reader = PdfReader(BytesIO(source_bytes))
    page = reader.pages[0]
    page_width = float(page.mediabox.right) - float(page.mediabox.left)
    page_height = float(page.mediabox.top) - float(page.mediabox.bottom)

    overlay = BytesIO()
    stamp_canvas = canvas.Canvas(overlay, pagesize=(page_width, page_height))
    x1, y1, x2, y2 = box
    width = x2 - x1
    height = y2 - y1
    inner_x = x1 + 8
    inner_top = y2 - 8
    usable_width = width - 16

    stamp_canvas.setFillColor(STAMP_BG)
    stamp_canvas.setStrokeColor(STAMP_BORDER)
    stamp_canvas.setLineWidth(1)
    stamp_canvas.roundRect(x1, y1, width, height, 6, stroke=1, fill=1)

    stamp_canvas.setFillColor(STAMP_TEXT)
    stamp_canvas.setFont(REPORTLAB_FONT_BOLD, 8)
    stamp_canvas.drawString(inner_x, inner_top - 2, TITLE_TEXT)

    text_y = inner_top - 15
    value_indent = 4
    label_gap = 8
    value_line_gap = 8
    section_gap = 10
    line_specs = [
        ('Подписант:', metadata['name'], 2),
        ('Выдан:', metadata['issuer'], 1),
        ('ID:', metadata['cert_id'], 1),
    ]

    for label, value, max_lines in line_specs:
        stamp_canvas.setFont(REPORTLAB_FONT_BOLD, 7)
        stamp_canvas.drawString(inner_x, text_y, label)
        text_y -= label_gap
        value_lines = wrap_text(value, REPORTLAB_FONT_REGULAR, 7, max(usable_width - value_indent, 32), max_lines=max_lines)
        stamp_canvas.setFont(REPORTLAB_FONT_REGULAR, 7)
        for value_line in value_lines:
            stamp_canvas.drawString(inner_x + value_indent, text_y, value_line)
            text_y -= value_line_gap
        text_y -= max(section_gap - value_line_gap, 0)

    stamp_canvas.save()
    overlay.seek(0)

    overlay_page = PdfReader(overlay).pages[0]
    page.merge_page(overlay_page)
    writer = PdfWriter()
    writer.clone_document_from_reader(reader)
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


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

    source_bytes = input_path.read_bytes()
    with BytesIO(source_bytes) as inf:
        probe_writer = IncrementalPdfFileWriter(inf)
        existing_count = sum(1 for _ in enumerate_sig_fields(probe_writer, filled_status=None))
        if existing_count >= MAX_SIGNATURES:
            raise ValueError(f'Maximum supported signatures exceeded ({MAX_SIGNATURES}).')
        box = compute_box(probe_writer, existing_count)

    stamped_source = apply_visual_stamp(source_bytes, box, metadata)

    with BytesIO(stamped_source) as inf:
        writer = IncrementalPdfFileWriter(inf)
        field_name = f'Signature{existing_count + 1}'
        field_spec = fields.SigFieldSpec(field_name, on_page=0, box=box, empty_field_appearance=False)

        emb = cms_embedder.PdfCMSEmbedder(field_spec)
        coroutine = emb.write_cms(field_name, writer)
        next(coroutine)

        sig_obj = pdf_byterange.SignatureObject(
            subfilter=fields.SigSeedSubFilter.PADES,
            name=metadata['name'],
            reason=metadata['reason'],
            contact_info=metadata['contact_info'],
            location='Web UI',
            bytes_reserved=BYTES_RESERVED,
        )

        coroutine.send(cms_embedder.SigObjSetup(sig_placeholder=sig_obj))

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
