#!/usr/bin/env python3
import base64
import sys
from asn1crypto import cms, core, parser

GOST_2012_256_SIG_OID = '1.2.643.7.1.1.1.1'
GOST_2012_512_SIG_OID = '1.2.643.7.1.1.1.2'
TARGET_SIG_OIDS = {GOST_2012_256_SIG_OID, GOST_2012_512_SIG_OID}


def parse_children(content):
    items = []
    offset = 0
    while offset < len(content):
        cls, method, tag, header, child_content, trailer = parser.parse(content[offset:])
        total = len(header) + len(child_content) + len(trailer)
        raw = content[offset:offset + total]
        items.append({
            'class': cls,
            'method': method,
            'tag': tag,
            'header': header,
            'content': child_content,
            'trailer': trailer,
            'raw': raw,
        })
        offset += total
    return items


def extract_spki_algorithm_parameters(cert_der):
    cert = parser.parse(cert_der)
    cert_children = parse_children(cert[4])
    if not cert_children:
        return None

    tbs = cert_children[0]
    tbs_children = parse_children(tbs['content'])
    if not tbs_children:
        return None

    index_shift = 1 if tbs_children[0]['class'] == 2 and tbs_children[0]['tag'] == 0 else 0
    spki_index = index_shift + 5
    if len(tbs_children) <= spki_index:
        return None

    spki = tbs_children[spki_index]
    spki_children = parse_children(parser.parse(spki['raw'])[4])
    if not spki_children:
        return None

    algorithm = spki_children[0]
    algorithm_children = parse_children(parser.parse(algorithm['raw'])[4])
    if len(algorithm_children) < 2:
        return None

    parameters_raw = algorithm_children[1]['raw']
    if not parameters_raw or parameters_raw[0] != 0x30:
        return None

    return parameters_raw


def needs_gost_signature_parameter_fix(signer_info):
    signature_algorithm = signer_info['signature_algorithm']
    if signature_algorithm['algorithm'].dotted not in TARGET_SIG_OIDS:
        return False

    parameters = signature_algorithm['parameters']
    if parameters is None:
        return True

    if isinstance(parameters, core.Any):
        parsed = parameters.parsed
        if isinstance(parsed, core.Null):
            return True
        return False

    return isinstance(parameters, core.Null)


def select_signer_certificate(certificates, signer_info):
    sid = signer_info['sid']
    candidates = [
        item.chosen
        for item in certificates
        if item.name == 'certificate'
    ]
    if sid.name == 'issuer_and_serial_number':
        issuer_and_serial = sid.chosen
        matches = [
            certificate
            for certificate in candidates
            if (
                certificate.serial_number == issuer_and_serial['serial_number'].native
                and certificate.issuer.dump() == issuer_and_serial['issuer'].dump()
            )
        ]
    elif sid.name == 'subject_key_identifier':
        matches = [
            certificate
            for certificate in candidates
            if certificate.key_identifier == sid.chosen.native
        ]
    else:
        matches = []
    return matches[0] if len(matches) == 1 else None


def normalize_cms_signature(cms_der):
    content_info = cms.ContentInfo.load(cms_der, strict=True)
    if content_info.dump() != cms_der:
        raise ValueError('CMS must use canonical DER')
    signed_data = content_info['content']
    certificates = signed_data['certificates']
    signer_infos = signed_data['signer_infos']

    if len(certificates) == 0 or len(signer_infos) == 0:
        return cms_der, False

    changed = False
    for signer_info in signer_infos:
        if not needs_gost_signature_parameter_fix(signer_info):
            continue
        signer_certificate = select_signer_certificate(certificates, signer_info)
        if signer_certificate is None:
            raise ValueError('Signer certificate is missing or ambiguous')
        algorithm_parameters = extract_spki_algorithm_parameters(
            signer_certificate.dump(),
        )
        if not algorithm_parameters:
            raise ValueError('Signer certificate algorithm parameters are missing')
        signer_info['signature_algorithm']['parameters'] = core.load(algorithm_parameters)
        changed = True

    if not changed:
        return cms_der, False

    return content_info.dump(), True


def main():
    payload = sys.stdin.read().strip()
    if not payload:
        raise SystemExit('Expected base64 CMS payload on stdin')

    cms_der = base64.b64decode(payload, validate=True)
    normalized_der, _changed = normalize_cms_signature(cms_der)
    sys.stdout.write(base64.b64encode(normalized_der).decode('ascii'))


if __name__ == '__main__':
    main()
