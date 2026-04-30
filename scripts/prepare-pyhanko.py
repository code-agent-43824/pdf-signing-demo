#!/usr/bin/env python3
import json
import os
import re
import sys
from copy import deepcopy
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

CONFIG_PATH = Path(os.environ.get('STAMP_CONFIG_PATH') or Path(__file__).resolve().parents[1] / 'config' / 'stamp-config.json')
BACKGROUND_LAYOUT = layout.SimpleBoxLayoutRule(
    x_align=layout.AxisAlignment.ALIGN_MID,
    y_align=layout.AxisAlignment.ALIGN_MID,
    margins=layout.Margins(left=0, right=0, top=0, bottom=0),
    inner_content_scaling=layout.InnerScaling.NO_SCALING,
)
SUPPORTED_SUBFILTERS = {
    'PADES': fields.SigSeedSubFilter.PADES,
}


DEFAULT_CONFIG = {
    'appearance': {
        'width': 176,
        'height': 108,
        'imageScale': 4,
        'backgroundColor': '#F5F8FF',
        'borderColor': '#3F68B8',
        'borderWidth': 4,
        'borderRadius': 18,
        'textColor': '#1A2842',
        'separator': {
            'enabled': True,
            'y': 56,
            'left': 28,
            'right': 28,
            'color': '#6E87BC',
            'width': 3,
        },
        'fonts': {
            'title': {
                'path': '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf',
                'size': 30,
            },
            'label': {
                'path': '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf',
                'size': 27,
            },
            'value': {
                'path': '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
                'size': 27,
            },
        },
        'layout': {
            'contentLeft': 24,
            'contentRight': 24,
            'startY': 12,
            'titleLineHeight': 30,
            'afterTitleGap': 40,
            'rowLabelGap': 24,
            'rowExtraGap': 20,
            'valueLineHeight': 24,
            'defaultMaxLines': 2,
        },
    },
    'content': {
        'title': ['Документ подписан', 'электронной подписью'],
        'rows': [
            {'label': 'ID сертификата', 'value': '{signer.cert_id}', 'breakAnywhere': True, 'maxLines': 2},
            {'label': 'ФИО владельца', 'value': '{signer.name}', 'maxLines': 2},
            {'label': 'Кем выдан', 'value': '{signer.issuer}', 'maxLines': 2},
            {'label': 'Срок действия', 'value': '{signer.valid_to}', 'maxLines': 2},
        ],
    },
    'signatureObject': {
        'name': '{signer.name}',
        'reason': 'Выдан: {signer.issuer}',
        'contactInfo': 'Cert ID: {signer.cert_id}',
        'location': 'Web UI',
        'bytesReserved': 16000,
        'subfilter': 'PADES',
    },
    'placements': {
        'rules': [
            {
                'name': 'default-grid',
                'pages': {'mode': 'single', 'page': 1, 'widgetPageMode': 'first'},
                'placement': {
                    'mode': 'grid',
                    'anchor': 'bottom-right',
                    'offsetX': 24,
                    'offsetY': 24,
                    'columns': 3,
                    'stepX': -181,
                    'stepY': 116,
                },
            }
        ]
    },
    'limits': {
        'maxSignatures': 4,
    },
}


TEMPLATE_RE = re.compile(r'\{\s*([a-zA-Z0-9_.-]+)\s*\}')


def deep_merge(base, override):
    result = deepcopy(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def load_config():
    if not CONFIG_PATH.exists():
        return deepcopy(DEFAULT_CONFIG)
    with CONFIG_PATH.open('r', encoding='utf-8') as fh:
        loaded = json.load(fh)
    return deep_merge(DEFAULT_CONFIG, loaded)


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


def get_from_context(context, dotted_key):
    value = context
    for part in dotted_key.split('.'):
        if isinstance(value, dict) and part in value:
            value = value[part]
        else:
            return ''
    return value


def render_template(template, context):
    if template is None:
        return ''
    if not isinstance(template, str):
        return template

    def repl(match):
        value = get_from_context(context, match.group(1))
        return str(value if value is not None else '')

    return TEMPLATE_RE.sub(repl, template)


def build_signer_context(signer):
    name = normalize(extract_dn_field(signer.get('subjectName'), 'CN') or signer.get('subjectName'), 'Подписант')
    issuer = normalize(extract_dn_field(signer.get('issuerName'), 'CN') or signer.get('issuerName'), 'не указан')
    cert_id = normalize(signer.get('thumbprint') or signer.get('serialNumber'), 'не указан')
    valid_to = normalize(signer.get('validToDate'), 'не указан')
    return {
        'name': name,
        'issuer': issuer,
        'cert_id': cert_id,
        'valid_to': valid_to,
        'subject_dn': normalize(signer.get('subjectName')),
        'issuer_dn': normalize(signer.get('issuerName')),
        'thumbprint': normalize(signer.get('thumbprint')),
        'serial_number': normalize(signer.get('serialNumber')),
    }


def build_rendered_metadata(config, signer):
    context = {'signer': build_signer_context(signer)}
    signature_cfg = config['signatureObject']
    content_cfg = config['content']

    rows = []
    for row in content_cfg.get('rows', []):
        rows.append({
            'label': render_template(row.get('label', ''), context),
            'value': render_template(row.get('value', ''), context),
            'breakAnywhere': bool(row.get('breakAnywhere', False)),
            'maxLines': int(row.get('maxLines') or config['appearance']['layout']['defaultMaxLines']),
        })

    title_lines = [render_template(line, context) for line in content_cfg.get('title', [])]

    return {
        'context': context,
        'title_lines': title_lines,
        'rows': rows,
        'name': render_template(signature_cfg.get('name', '{signer.name}'), context),
        'reason': render_template(signature_cfg.get('reason', ''), context),
        'contact_info': render_template(signature_cfg.get('contactInfo', ''), context),
        'location': render_template(signature_cfg.get('location', ''), context),
        'bytes_reserved': int(signature_cfg.get('bytesReserved', 16000)),
        'subfilter': SUPPORTED_SUBFILTERS.get(str(signature_cfg.get('subfilter', 'PADES')).upper(), fields.SigSeedSubFilter.PADES),
    }


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


def render_stamp_image(config, metadata):
    appearance = config['appearance']
    layout_cfg = appearance['layout']
    separator_cfg = appearance.get('separator', {})

    width = int(appearance['width']) * int(appearance.get('imageScale', 4))
    height = int(appearance['height']) * int(appearance.get('imageScale', 4))
    image = Image.new('RGBA', (width, height), appearance['backgroundColor'])
    draw = ImageDraw.Draw(image)

    border_width = int(appearance.get('borderWidth', 0))
    draw.rounded_rectangle(
        (0, 0, width - 1, height - 1),
        radius=int(appearance.get('borderRadius', 0)),
        outline=appearance.get('borderColor'),
        width=border_width,
        fill=appearance['backgroundColor'],
    )

    if separator_cfg.get('enabled', False):
        y = int(separator_cfg.get('y', 0))
        draw.line(
            (int(separator_cfg.get('left', 0)), y, width - int(separator_cfg.get('right', 0)), y),
            fill=separator_cfg.get('color', appearance['textColor']),
            width=int(separator_cfg.get('width', 1)),
        )

    title_font = ImageFont.truetype(appearance['fonts']['title']['path'], int(appearance['fonts']['title']['size']))
    label_font = ImageFont.truetype(appearance['fonts']['label']['path'], int(appearance['fonts']['label']['size']))
    value_font = ImageFont.truetype(appearance['fonts']['value']['path'], int(appearance['fonts']['value']['size']))

    content_left = int(layout_cfg['contentLeft'])
    content_right = width - int(layout_cfg['contentRight'])
    max_width = max(content_right - content_left, 40)
    y = int(layout_cfg['startY'])

    for line in metadata['title_lines']:
        if line:
            draw.text((content_left, y), line, font=title_font, fill=appearance['textColor'])
        y += int(layout_cfg['titleLineHeight'])

    y += int(layout_cfg['afterTitleGap'])

    for row in metadata['rows']:
        label_text = f"{row['label']}:" if row['label'] else ''
        if label_text:
            draw.text((content_left, y), label_text, font=label_font, fill=appearance['textColor'])
        y += int(layout_cfg['rowLabelGap'])
        lines = wrap_text_lines(
            draw,
            row['value'],
            value_font,
            max_width,
            max_lines=row['maxLines'],
            break_anywhere=row['breakAnywhere'],
        )
        if not lines:
            lines = ['']
        for idx, line in enumerate(lines):
            draw.text((content_left, y - 2), line, font=value_font, fill=appearance['textColor'])
            if idx < len(lines) - 1:
                y += int(layout_cfg['valueLineHeight'])
        y += int(layout_cfg['rowExtraGap'])

    return image


def create_pdf_image(config, metadata):
    appearance = config['appearance']
    return PdfImage(
        render_stamp_image(config, metadata),
        box=layout.BoxConstraints(width=int(appearance['width']), height=int(appearance['height'])),
    )


def build_signature_style(config, metadata):
    stamp_image = create_pdf_image(config, metadata)
    return stamp.TextStampStyle(
        border_width=0,
        background=stamp_image,
        background_layout=BACKGROUND_LAYOUT,
        background_opacity=1,
        stamp_text='',
        text_box_style=text.TextBoxStyle(font_size=1, leading=1),
    )


def build_static_style(config, metadata):
    stamp_image = create_pdf_image(config, metadata)
    return stamp.StaticStampStyle(
        border_width=0,
        background=stamp_image,
        background_layout=BACKGROUND_LAYOUT,
        background_opacity=1,
    )


def page_count(writer):
    return int(writer.root['/Pages']['/Count'])


def page_dimensions(writer, page_ix):
    page_obj, _ = writer.find_page_for_modification(page_ix)
    page = page_obj.get_object()
    media = page['/MediaBox']
    width = float(media[2]) - float(media[0])
    height = float(media[3]) - float(media[1])
    return width, height


def to_page_index(page_number, total_pages):
    page_number = int(page_number)
    if page_number < 1 or page_number > total_pages:
        raise ValueError(f'Configured page {page_number} is outside the document range 1..{total_pages}.')
    return page_number - 1


def resolve_pages(pages_cfg, total_pages):
    pages_cfg = pages_cfg or {}
    mode = str(pages_cfg.get('mode', 'single')).lower()

    if mode == 'single':
        return [to_page_index(pages_cfg.get('page', 1), total_pages)]
    if mode == 'all':
        return list(range(total_pages))
    if mode == 'range':
        start = to_page_index(pages_cfg.get('start', 1), total_pages)
        end = to_page_index(pages_cfg.get('end', total_pages), total_pages)
        if end < start:
            raise ValueError('Page range end must be greater than or equal to start.')
        return list(range(start, end + 1))
    if mode == 'list':
        pages = sorted({to_page_index(page, total_pages) for page in pages_cfg.get('pages', [])})
        if not pages:
            raise ValueError('Page list mode requires at least one page.')
        return pages
    raise ValueError(f'Unsupported pages.mode: {mode}')


def select_widget_page(selected_pages, pages_cfg):
    widget_page_mode = str((pages_cfg or {}).get('widgetPageMode', 'first')).lower()
    if widget_page_mode == 'first':
        return selected_pages[0]
    if widget_page_mode == 'last':
        return selected_pages[-1]
    raise ValueError(f'Unsupported widgetPageMode: {widget_page_mode}')


def rule_matches(rule, signature_index):
    match = rule.get('match') or {}
    if not match:
        return True
    if 'signatureIndex' in match and int(match['signatureIndex']) != signature_index:
        return False
    if 'signatureIndexes' in match and signature_index not in {int(v) for v in match['signatureIndexes']}:
        return False
    if 'signatureIndexFrom' in match and signature_index < int(match['signatureIndexFrom']):
        return False
    if 'signatureIndexTo' in match and signature_index > int(match['signatureIndexTo']):
        return False
    return True


def find_rule(config, signature_index):
    rules = config.get('placements', {}).get('rules', [])
    for rule in rules:
        if rule_matches(rule, signature_index):
            return rule
    raise ValueError(f'No stamp placement rule matched signature #{signature_index}.')


def matching_slot(rule, signature_index):
    slot = 0
    for index in range(1, signature_index):
        if rule_matches(rule, index):
            slot += 1
    return slot


def resolve_anchor_position(page_width, page_height, stamp_width, stamp_height, anchor, offset_x, offset_y):
    anchor = str(anchor or 'bottom-left').lower()
    if anchor == 'bottom-left':
        return offset_x, offset_y
    if anchor == 'bottom-center':
        return (page_width - stamp_width) / 2 + offset_x, offset_y
    if anchor == 'bottom-right':
        return page_width - stamp_width - offset_x, offset_y
    if anchor == 'middle-left':
        return offset_x, (page_height - stamp_height) / 2 + offset_y
    if anchor == 'center':
        return (page_width - stamp_width) / 2 + offset_x, (page_height - stamp_height) / 2 + offset_y
    if anchor == 'middle-right':
        return page_width - stamp_width - offset_x, (page_height - stamp_height) / 2 + offset_y
    if anchor == 'top-left':
        return offset_x, page_height - stamp_height - offset_y
    if anchor == 'top-center':
        return (page_width - stamp_width) / 2 + offset_x, page_height - stamp_height - offset_y
    if anchor == 'top-right':
        return page_width - stamp_width - offset_x, page_height - stamp_height - offset_y
    raise ValueError(f'Unsupported placement anchor: {anchor}')


def resolve_position(writer, placement_cfg, stamp_width, stamp_height, page_ix, slot_index):
    page_width, page_height = page_dimensions(writer, page_ix)
    mode = str((placement_cfg or {}).get('mode', 'grid')).lower()

    if mode in {'absolute', 'fixed'}:
        return float(placement_cfg.get('x', 0)), float(placement_cfg.get('y', 0))

    if mode == 'anchored':
        return resolve_anchor_position(
            page_width,
            page_height,
            stamp_width,
            stamp_height,
            placement_cfg.get('anchor', 'bottom-left'),
            float(placement_cfg.get('offsetX', 0)),
            float(placement_cfg.get('offsetY', 0)),
        )

    if mode == 'grid':
        columns = max(int(placement_cfg.get('columns', 1)), 1)
        base_x, base_y = resolve_anchor_position(
            page_width,
            page_height,
            stamp_width,
            stamp_height,
            placement_cfg.get('anchor', 'bottom-left'),
            float(placement_cfg.get('offsetX', 0)),
            float(placement_cfg.get('offsetY', 0)),
        )
        column = slot_index % columns
        row = slot_index // columns
        return (
            base_x + float(placement_cfg.get('stepX', 0)) * column,
            base_y + float(placement_cfg.get('stepY', 0)) * row,
        )

    raise ValueError(f'Unsupported placement mode: {mode}')


def build_placement_plan(config, writer, signature_index):
    rule = find_rule(config, signature_index)
    total_pages = page_count(writer)
    selected_pages = resolve_pages(rule.get('pages'), total_pages)
    widget_page_ix = select_widget_page(selected_pages, rule.get('pages'))
    slot_index = matching_slot(rule, signature_index)
    placement_cfg = rule.get('placement') or {}
    stamp_width = int(config['appearance']['width'])
    stamp_height = int(config['appearance']['height'])

    positions = {
        page_ix: resolve_position(writer, placement_cfg, stamp_width, stamp_height, page_ix, slot_index)
        for page_ix in selected_pages
    }

    return {
        'rule': rule,
        'selected_pages': selected_pages,
        'widget_page_ix': widget_page_ix,
        'positions': positions,
    }


def apply_extra_stamps(writer, config, metadata, placement_plan):
    extra_pages = [page_ix for page_ix in placement_plan['selected_pages'] if page_ix != placement_plan['widget_page_ix']]
    if not extra_pages:
        return

    static_stamp = stamp.StaticContentStamp(
        writer,
        build_static_style(config, metadata),
        box=layout.BoxConstraints(width=int(config['appearance']['width']), height=int(config['appearance']['height'])),
    )

    for page_ix in extra_pages:
        x, y = placement_plan['positions'][page_ix]
        static_stamp.apply(page_ix, int(round(x)), int(round(y)))


def main():
    if len(sys.argv) != 4:
        print('usage: prepare-pyhanko.py <input.pdf> <signer.json> <output.pdf>', file=sys.stderr)
        sys.exit(2)

    input_path = Path(sys.argv[1])
    signer = json.loads(sys.argv[2])
    output_path = Path(sys.argv[3])

    config = load_config()
    metadata = build_rendered_metadata(config, signer)

    with input_path.open('rb') as inf:
        writer = IncrementalPdfFileWriter(inf)
        existing_count = sum(1 for _ in enumerate_sig_fields(writer, filled_status=None))
        signature_index = existing_count + 1
        max_signatures = int(config.get('limits', {}).get('maxSignatures', 4))
        if existing_count >= max_signatures:
            raise ValueError(f'Maximum supported signatures exceeded ({max_signatures}).')

        placement_plan = build_placement_plan(config, writer, signature_index)
        apply_extra_stamps(writer, config, metadata, placement_plan)

        field_name = f'Signature{signature_index}'
        x, y = placement_plan['positions'][placement_plan['widget_page_ix']]
        box = (
            int(round(x)),
            int(round(y)),
            int(round(x + int(config['appearance']['width']))),
            int(round(y + int(config['appearance']['height']))),
        )
        field_spec = fields.SigFieldSpec(
            field_name,
            on_page=placement_plan['widget_page_ix'],
            box=box,
            empty_field_appearance=False,
        )

        emb = cms_embedder.PdfCMSEmbedder(field_spec)
        coroutine = emb.write_cms(field_name, writer)
        next(coroutine)

        style = build_signature_style(config, metadata)
        sig_obj = pdf_byterange.SignatureObject(
            subfilter=metadata['subfilter'],
            name=metadata['name'],
            reason=metadata['reason'],
            contact_info=metadata['contact_info'],
            location=metadata['location'],
            bytes_reserved=metadata['bytes_reserved'],
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
            'signatureIndex': signature_index,
            'selectedPages': [page_ix + 1 for page_ix in placement_plan['selected_pages']],
            'widgetPage': placement_plan['widget_page_ix'] + 1,
            'reservedStart': prepared_digest.reserved_region_start,
            'reservedEnd': prepared_digest.reserved_region_end,
            'configPath': str(CONFIG_PATH),
        }))


if __name__ == '__main__':
    main()
