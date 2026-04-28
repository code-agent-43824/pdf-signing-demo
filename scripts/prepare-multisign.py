#!/usr/bin/env python3
import base64
import json
import re
import sys
import unicodedata
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (
    ArrayObject,
    ByteStringObject,
    DecodedStreamObject,
    DictionaryObject,
    NameObject,
    NumberObject,
    TextStringObject,
)

DEFAULT_SIGNATURE_LENGTH = 16000
BYTE_RANGE_PLACEHOLDER = '/**********'
STAMP_MARGIN = 24
STAMP_WIDTH = 210
STAMP_HEIGHT = 82
STAMP_GAP = 10
MAX_SIGNATURES = 4


def normalize(value, fallback=''):
    clean = ' '.join(str(value or '').split()).strip()
    return clean or fallback


def split_dn(value):
    return [part.strip() for part in re.split(r',(?=(?:[^\\]|\\.)*$)', str(value or '')) if part.strip()]


def extract_dn_field(dn, field_name):
    prefix = f'{field_name}='.upper()
    for part in split_dn(dn):
      upper = part.upper()
      if upper.startswith(prefix):
        return part[len(field_name) + 1:].strip()
    return ''


def build_metadata(signer):
    name = normalize(extract_dn_field(signer.get('subjectName'), 'CN') or signer.get('subjectName'), 'Kirill')
    issuer = normalize(extract_dn_field(signer.get('issuerName'), 'CN') or signer.get('issuerName'), 'не указан')
    cert_id = normalize(signer.get('thumbprint') or signer.get('serialNumber'), 'не указан')
    return {
        'name': name,
        'issuer': issuer,
        'certId': cert_id,
        'reason': f'Выдан: {issuer}',
        'contactInfo': f'Cert ID: {cert_id}',
    }


def to_ascii(value):
    normalized = unicodedata.normalize('NFKD', value)
    return normalized.encode('ascii', 'ignore').decode('ascii') or 'signed'


def count_signature_fields(writer):
    root = writer.root_object
    acro_ref = root.get('/AcroForm')
    if not acro_ref:
        return 0
    acro = acro_ref.get_object()
    fields = acro.get('/Fields', [])
    count = 0
    for field in fields:
        obj = field.get_object()
        if obj.get('/FT') == '/Sig':
            count += 1
    return count


def get_or_create_acroform(writer):
    root = writer.root_object
    acro_ref = root.get('/AcroForm')
    if acro_ref:
        return acro_ref.get_object()
    acro = DictionaryObject()
    acro[NameObject('/Fields')] = ArrayObject()
    acro[NameObject('/SigFlags')] = NumberObject(3)
    root[NameObject('/AcroForm')] = writer._add_object(acro)
    return acro


def get_reusable_font_ref(writer):
    root = writer.root_object
    acro_ref = root.get('/AcroForm')
    if not acro_ref:
        return None
    acro = acro_ref.get_object()
    for field in reversed(acro.get('/Fields', [])):
        obj = field.get_object()
        ap = obj.get('/AP')
        if not ap:
            continue
        normal = ap.get('/N')
        if not normal:
            continue
        normal_obj = normal.get_object()
        resources = normal_obj.get('/Resources')
        if not resources:
            continue
        fonts = resources.get('/Font')
        if fonts and '/F0' in fonts:
            return fonts['/F0']
    return None


def create_appearance_stream(writer, rect, metadata, font_ref):
    width = rect[2] - rect[0]
    height = rect[3] - rect[1]
    if font_ref is None:
        font_dict = DictionaryObject()
        font_dict[NameObject('/Type')] = NameObject('/Font')
        font_dict[NameObject('/Subtype')] = NameObject('/Type1')
        font_dict[NameObject('/BaseFont')] = NameObject('/Helvetica')
        font_ref = writer._add_object(font_dict)
        name_text = to_ascii(metadata['name'])
        issuer_text = to_ascii(metadata['issuer'])
    else:
        name_text = metadata['name']
        issuer_text = metadata['issuer']

    cert_text = to_ascii(metadata['certId']) if font_ref and font_ref.get_object().get('/BaseFont') == '/Helvetica' else metadata['certId']
    lines = [
        ('Electronic signature', 10, 8, height - 16),
        (f'Signer: {name_text}', 7, 8, height - 30),
        (f'Issuer: {issuer_text}', 7, 8, height - 48),
        (f'ID: {cert_text}', 7, 8, 10),
    ]

    content_lines = [
        'q',
        '0.18 0.36 0.78 RG',
        '0.97 0.98 1 rg',
        '1 w',
        f'0.5 0.5 {max(width - 1, 1)} {max(height - 1, 1)} re B',
    ]
    for text, size, x, y in lines:
        escaped = text.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)')
        content_lines.append(f'BT /F0 {size} Tf 0.10 0.18 0.40 rg 1 0 0 1 {x} {y} Tm ({escaped}) Tj ET')
    content_lines.append('Q')

    stream = DecodedStreamObject()
    stream.set_data('\n'.join(content_lines).encode('utf-8'))
    stream[NameObject('/Type')] = NameObject('/XObject')
    stream[NameObject('/Subtype')] = NameObject('/Form')
    stream[NameObject('/FormType')] = NumberObject(1)
    stream[NameObject('/BBox')] = ArrayObject([NumberObject(0), NumberObject(0), NumberObject(width), NumberObject(height)])
    stream[NameObject('/Matrix')] = ArrayObject([NumberObject(1), NumberObject(0), NumberObject(0), NumberObject(1), NumberObject(0), NumberObject(0)])
    font_map = DictionaryObject()
    font_map[NameObject('/F0')] = font_ref
    resources = DictionaryObject()
    resources[NameObject('/Font')] = font_map
    stream[NameObject('/Resources')] = resources
    return writer._add_object(stream)


def add_signature_placeholder(writer, signer):
    metadata = build_metadata(signer)
    page = writer.pages[0]
    page_width = float(page.mediabox.right) - float(page.mediabox.left)
    existing = count_signature_fields(writer)
    if existing >= MAX_SIGNATURES:
        raise ValueError(f'Maximum supported signatures exceeded ({MAX_SIGNATURES}).')

    right = page_width - STAMP_MARGIN - (STAMP_WIDTH + STAMP_GAP) * existing
    left = right - STAMP_WIDTH
    bottom = STAMP_MARGIN
    top = bottom + STAMP_HEIGHT
    rect = [left, bottom, right, top]

    placeholder_bytes = b'\x00' * DEFAULT_SIGNATURE_LENGTH
    byte_range = ArrayObject([
        NumberObject(0),
        NameObject(BYTE_RANGE_PLACEHOLDER),
        NameObject(BYTE_RANGE_PLACEHOLDER),
        NameObject(BYTE_RANGE_PLACEHOLDER),
    ])

    sig = DictionaryObject()
    sig[NameObject('/Type')] = NameObject('/Sig')
    sig[NameObject('/Filter')] = NameObject('/Adobe.PPKLite')
    sig[NameObject('/SubFilter')] = NameObject('/ETSI.CAdES.detached')
    sig[NameObject('/ByteRange')] = byte_range
    sig[NameObject('/Contents')] = ByteStringObject(placeholder_bytes)
    sig[NameObject('/Reason')] = TextStringObject(metadata['reason'])
    sig[NameObject('/ContactInfo')] = TextStringObject(metadata['contactInfo'])
    sig[NameObject('/Name')] = TextStringObject(metadata['name'])
    sig[NameObject('/Location')] = TextStringObject('Web UI')
    sig_ref = writer._add_object(sig)

    font_ref = get_reusable_font_ref(writer)
    ap_ref = create_appearance_stream(writer, rect, metadata, font_ref)

    widget = DictionaryObject()
    widget[NameObject('/Type')] = NameObject('/Annot')
    widget[NameObject('/Subtype')] = NameObject('/Widget')
    widget[NameObject('/FT')] = NameObject('/Sig')
    widget[NameObject('/Rect')] = ArrayObject([NumberObject(v) for v in rect])
    widget[NameObject('/V')] = sig_ref
    widget[NameObject('/T')] = TextStringObject(f'Signature{existing + 1}')
    widget[NameObject('/F')] = NumberObject(4)
    widget[NameObject('/P')] = page.indirect_reference
    ap_dict = DictionaryObject()
    ap_dict[NameObject('/N')] = ap_ref
    widget[NameObject('/AP')] = ap_dict
    widget_ref = writer._add_object(widget)

    if page.annotations is None:
        page[NameObject('/Annots')] = ArrayObject()
    page.annotations.append(widget_ref)

    acro = get_or_create_acroform(writer)
    if '/SigFlags' in acro:
        acro[NameObject('/SigFlags')] = NumberObject(int(acro['/SigFlags']) | 3)
    else:
        acro[NameObject('/SigFlags')] = NumberObject(3)
    acro['/Fields'].append(widget_ref)


def patch_byte_range(pdf_bytes):
    matches = list(re.finditer(br'/ByteRange\s*\[\s*0\s+/\*{10}\s+/\*{10}\s+/\*{10}\s*\]', pdf_bytes))
    if not matches:
        raise ValueError('ByteRange placeholder not found')
    match = matches[-1]
    start, end = match.span()
    after = pdf_bytes[end:]
    contents_rel = after.find(b'/Contents ')
    if contents_rel < 0:
        raise ValueError('Contents entry not found after ByteRange placeholder')
    contents_tag_pos = end + contents_rel
    placeholder_pos = pdf_bytes.find(b'<', contents_tag_pos)
    placeholder_end = pdf_bytes.find(b'>', placeholder_pos)
    placeholder_len_with_brackets = placeholder_end + 1 - placeholder_pos
    byte_range = [0, placeholder_pos, placeholder_pos + placeholder_len_with_brackets, len(pdf_bytes) - (placeholder_pos + placeholder_len_with_brackets)]
    actual = f'/ByteRange [{byte_range[0]} {byte_range[1]} {byte_range[2]} {byte_range[3]}]'.encode('ascii')
    actual += b' ' * (end - start - len(actual))
    patched = pdf_bytes[:start] + actual + pdf_bytes[end:]
    content_to_sign = patched[:byte_range[1]] + patched[byte_range[2]:byte_range[2] + byte_range[3]]
    return patched, content_to_sign, byte_range, placeholder_len_with_brackets - 2


def main():
    if len(sys.argv) != 4:
        print('usage: prepare-multisign.py <input.pdf> <signer.json> <output.pdf>', file=sys.stderr)
        sys.exit(2)

    input_path = Path(sys.argv[1])
    signer = json.loads(sys.argv[2])
    output_path = Path(sys.argv[3])

    writer = PdfWriter(str(input_path), incremental=True, strict=False)
    add_signature_placeholder(writer, signer)
    with output_path.open('wb') as fh:
        writer.write(fh)

    pdf_bytes = output_path.read_bytes()
    patched, content_to_sign, byte_range, placeholder_length = patch_byte_range(pdf_bytes)
    output_path.write_bytes(patched)
    print(json.dumps({
        'byteRange': byte_range,
        'placeholderLength': placeholder_length,
        'contentToSignBase64': base64.b64encode(content_to_sign).decode('ascii'),
    }))


if __name__ == '__main__':
    main()
