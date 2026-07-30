#!/usr/bin/env python3
import hashlib
import json
import sys
from datetime import timezone
from pathlib import Path

from asn1crypto import algos, cms, core, x509
from cryptography import x509 as crypto_x509
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa
from gostcrypto import gosthash, gostsignature


OID_DATA = '1.2.840.113549.1.7.1'
OID_CONTENT_TYPE = '1.2.840.113549.1.9.3'
OID_MESSAGE_DIGEST = '1.2.840.113549.1.9.4'
OID_SIGNING_CERTIFICATE_V2 = '1.2.840.113549.1.9.16.2.47'
OID_GOST_2012_256_SIGNATURE = '1.2.643.7.1.1.1.1'
OID_GOST_2012_512_SIGNATURE = '1.2.643.7.1.1.1.2'

COMBINED_SIGNATURE_DIGESTS = {
    '1.2.840.113549.1.1.11': '2.16.840.1.101.3.4.2.1',
    '1.2.840.113549.1.1.12': '2.16.840.1.101.3.4.2.2',
    '1.2.840.113549.1.1.13': '2.16.840.1.101.3.4.2.3',
    '1.2.840.10045.4.3.2': '2.16.840.1.101.3.4.2.1',
    '1.2.840.10045.4.3.3': '2.16.840.1.101.3.4.2.2',
    '1.2.840.10045.4.3.4': '2.16.840.1.101.3.4.2.3',
}

DIGESTS = {
    '2.16.840.1.101.3.4.2.1': ('sha256', hashlib.sha256, hashes.SHA256),
    '2.16.840.1.101.3.4.2.2': ('sha384', hashlib.sha384, hashes.SHA384),
    '2.16.840.1.101.3.4.2.3': ('sha512', hashlib.sha512, hashes.SHA512),
    '1.2.643.7.1.1.2.2': ('streebog256', None, None),
    '1.2.643.7.1.1.2.3': ('streebog512', None, None),
}

GOST_CURVES = {
    # The legacy CryptoPro exchange sets reuse the corresponding signing curves.
    '1.2.643.2.2.35.1': 'id-tc26-gost-3410-2012-256-paramSetB',
    '1.2.643.2.2.36.0': 'id-tc26-gost-3410-2012-256-paramSetB',
    '1.2.643.2.2.35.2': 'id-tc26-gost-3410-2012-256-paramSetC',
    '1.2.643.2.2.35.3': 'id-tc26-gost-3410-2012-256-paramSetD',
    '1.2.643.2.2.36.1': 'id-tc26-gost-3410-2012-256-paramSetD',
    '1.2.643.7.1.2.1.1.1': 'id-tc26-gost-3410-2012-256-paramSetA',
    '1.2.643.7.1.2.1.1.2': 'id-tc26-gost-3410-2012-256-paramSetB',
    '1.2.643.7.1.2.1.1.3': 'id-tc26-gost-3410-2012-256-paramSetC',
    '1.2.643.7.1.2.1.1.4': 'id-tc26-gost-3410-2012-256-paramSetD',
    '1.2.643.7.1.2.1.2.1': 'id-tc26-gost-3410-12-512-paramSetA',
    '1.2.643.7.1.2.1.2.2': 'id-tc26-gost-3410-12-512-paramSetB',
    '1.2.643.7.1.2.1.2.3': 'id-tc26-gost-3410-2012-512-paramSetC',
}


class ESSCertIDv2(core.Sequence):
    _fields = [
        (
            'hash_algorithm',
            algos.DigestAlgorithm,
            {'default': {'algorithm': 'sha256'}},
        ),
        ('cert_hash', core.OctetString),
        ('issuer_serial', core.Any, {'optional': True}),
    ]


class ESSCertIDv2s(core.SequenceOf):
    _child_spec = ESSCertIDv2


class SigningCertificateV2(core.Sequence):
    _fields = [
        ('certs', ESSCertIDv2s),
        ('policies', core.Any, {'optional': True}),
    ]


class VerificationError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def fail(code):
    raise VerificationError(code)


def load_certificate(cert_der):
    try:
        certificate = x509.Certificate.load(cert_der, strict=True)
    except Exception:
        fail('INVALID_CERTIFICATE_DER')
    if certificate.dump() != cert_der:
        fail('NON_CANONICAL_CERTIFICATE_DER')
    return certificate


def digest_bytes(oid, payload):
    definition = DIGESTS.get(oid)
    if definition is None:
        fail('UNSUPPORTED_DIGEST_ALGORITHM')
    name, hashlib_constructor, _crypto_hash = definition
    if hashlib_constructor is not None:
        return hashlib_constructor(payload).digest()
    return bytes(gosthash.new(name, data=bytearray(payload)).digest())


def certificate_identity(certificate):
    cert_der = certificate.dump()
    subject = certificate.subject.native
    issuer = certificate.issuer.native
    not_after = certificate['tbs_certificate']['validity']['not_after'].native
    if not_after.tzinfo is None:
        not_after = not_after.replace(tzinfo=timezone.utc)
    return {
        'certificateSha256': hashlib.sha256(cert_der).hexdigest(),
        'subjectName': subject.get('common_name') or certificate.subject.human_friendly,
        'issuerName': issuer.get('common_name') or certificate.issuer.human_friendly,
        'thumbprint': hashlib.sha256(cert_der).hexdigest().upper(),
        'serialNumber': format(certificate.serial_number, 'X'),
        'validToDate': not_after.isoformat(),
    }


def unique_attribute(signed_attrs, oid):
    matches = [attribute for attribute in signed_attrs if attribute['type'].dotted == oid]
    if len(matches) != 1 or len(matches[0]['values']) != 1:
        fail('INVALID_SIGNED_ATTRIBUTES')
    return matches[0]['values'][0]


def select_signer_certificate(signed_data, signer_info):
    certificates = [
        item.chosen
        for item in signed_data['certificates']
        if item.name == 'certificate'
    ]
    sid = signer_info['sid']
    if sid.name == 'issuer_and_serial_number':
        issuer_and_serial = sid.chosen
        matches = [
            certificate
            for certificate in certificates
            if (
                certificate.serial_number == issuer_and_serial['serial_number'].native
                and certificate.issuer.dump() == issuer_and_serial['issuer'].dump()
            )
        ]
    elif sid.name == 'subject_key_identifier':
        expected_key_identifier = sid.chosen.native
        matches = [
            certificate
            for certificate in certificates
            if certificate.key_identifier == expected_key_identifier
        ]
    else:
        fail('UNSUPPORTED_SIGNER_IDENTIFIER')
    if len(matches) != 1:
        fail('SIGNER_CERTIFICATE_NOT_FOUND')
    return matches[0]


def validate_signing_certificate_v2(attribute_value, signer_certificate):
    try:
        value = SigningCertificateV2.load(attribute_value.dump(), strict=True)
    except Exception:
        fail('INVALID_SIGNING_CERTIFICATE_V2')
    if value.dump() != attribute_value.dump() or len(value['certs']) < 1:
        fail('INVALID_SIGNING_CERTIFICATE_V2')
    cert_id = value['certs'][0]
    algorithm = cert_id['hash_algorithm']['algorithm'].dotted
    expected_hash = digest_bytes(algorithm, signer_certificate.dump())
    if cert_id['cert_hash'].native != expected_hash:
        fail('SIGNING_CERTIFICATE_MISMATCH')


def parse_tlv(data, offset):
    if offset >= len(data):
        fail('INVALID_ASN1')
    start = offset
    offset += 1
    if offset >= len(data):
        fail('INVALID_ASN1')
    length_octet = data[offset]
    offset += 1
    if length_octet & 0x80:
        count = length_octet & 0x7f
        if count == 0 or count > 4 or offset + count > len(data):
            fail('INVALID_ASN1')
        length = int.from_bytes(data[offset:offset + count], 'big')
        if length < 128:
            fail('NON_CANONICAL_DER_LENGTH')
        offset += count
    else:
        length = length_octet
    end = offset + length
    if end > len(data):
        fail('INVALID_ASN1')
    return data[start:offset], data[offset:end], end


def gost_public_key_and_curve(certificate):
    spki = certificate['tbs_certificate']['subject_public_key_info']
    spki_content = spki.contents
    _algorithm_header, algorithm_content, offset = parse_tlv(spki_content, 0)
    _key_header, bit_string_content, end = parse_tlv(spki_content, offset)
    if end != len(spki_content) or not bit_string_content or bit_string_content[0] != 0:
        fail('INVALID_GOST_PUBLIC_KEY')

    try:
        _algorithm_oid_header, _algorithm_oid_content, parameter_offset = (
            parse_tlv(algorithm_content, 0)
        )
        parameter_header, parameter_content, parameter_end = parse_tlv(
            algorithm_content,
            parameter_offset,
        )
        if parameter_end != len(algorithm_content):
            fail('INVALID_GOST_PUBLIC_KEY')
        parameters = core.Sequence.load(
            parameter_header + parameter_content,
            strict=True,
        )
        curve_oid = parameters[0].native
        public_key = core.OctetString.load(bit_string_content[1:], strict=True).native
    except Exception:
        fail('INVALID_GOST_PUBLIC_KEY')

    curve_name = GOST_CURVES.get(curve_oid)
    if curve_name is None:
        fail('UNSUPPORTED_GOST_CURVE')
    return public_key, curve_name


def verify_gost_signature(certificate, signature_oid, digest_oid, payload, signature):
    if signature_oid == OID_GOST_2012_256_SIGNATURE:
        mode = gostsignature.MODE_256
        expected_digest_oid = '1.2.643.7.1.1.2.2'
        coordinate_size = 32
    elif signature_oid == OID_GOST_2012_512_SIGNATURE:
        mode = gostsignature.MODE_512
        expected_digest_oid = '1.2.643.7.1.1.2.3'
        coordinate_size = 64
    else:
        fail('UNSUPPORTED_SIGNATURE_ALGORITHM')
    if digest_oid != expected_digest_oid:
        fail('SIGNATURE_DIGEST_MISMATCH')

    public_key, curve_name = gost_public_key_and_curve(certificate)
    if len(public_key) != coordinate_size * 2 or len(signature) != coordinate_size * 2:
        fail('INVALID_GOST_SIGNATURE_SIZE')

    # X.509 stores each coordinate little-endian. CMS stores s || r, while
    # gostcrypto accepts big-endian x || y, r || s and a big-endian digest.
    public_key_for_verifier = (
        public_key[:coordinate_size][::-1]
        + public_key[coordinate_size:][::-1]
    )
    signature_for_verifier = signature[coordinate_size:] + signature[:coordinate_size]
    digest_for_verifier = digest_bytes(digest_oid, payload)[::-1]
    curve = gostsignature.CURVES_R_1323565_1_024_2019[curve_name]
    verifier = gostsignature.new(mode, curve)
    if not verifier.verify(
        bytearray(public_key_for_verifier),
        bytearray(digest_for_verifier),
        bytearray(signature_for_verifier),
    ):
        fail('INVALID_CRYPTOGRAPHIC_SIGNATURE')


def verify_standard_signature(certificate, signature_oid, digest_oid, payload, signature):
    definition = DIGESTS.get(digest_oid)
    if definition is None or definition[2] is None:
        fail('UNSUPPORTED_DIGEST_ALGORITHM')
    hash_algorithm = definition[2]()
    declared_digest_oid = COMBINED_SIGNATURE_DIGESTS.get(signature_oid)
    if declared_digest_oid is not None and declared_digest_oid != digest_oid:
        fail('SIGNATURE_DIGEST_MISMATCH')
    try:
        public_key = crypto_x509.load_der_x509_certificate(certificate.dump()).public_key()
        if isinstance(public_key, rsa.RSAPublicKey):
            if signature_oid not in {
                '1.2.840.113549.1.1.1',
                '1.2.840.113549.1.1.11',
                '1.2.840.113549.1.1.12',
                '1.2.840.113549.1.1.13',
            }:
                fail('SIGNATURE_KEY_TYPE_MISMATCH')
            public_key.verify(signature, payload, padding.PKCS1v15(), hash_algorithm)
        elif isinstance(public_key, ec.EllipticCurvePublicKey):
            if signature_oid not in {
                '1.2.840.10045.4.3.2',
                '1.2.840.10045.4.3.3',
                '1.2.840.10045.4.3.4',
            }:
                fail('SIGNATURE_KEY_TYPE_MISMATCH')
            public_key.verify(signature, payload, ec.ECDSA(hash_algorithm))
        else:
            fail('UNSUPPORTED_PUBLIC_KEY')
    except VerificationError:
        raise
    except Exception:
        fail('INVALID_CRYPTOGRAPHIC_SIGNATURE')


def verify_cms(cms_der, content, expected_certificate_sha256=None):
    try:
        content_info = cms.ContentInfo.load(cms_der, strict=True)
    except Exception:
        fail('INVALID_CMS_DER')
    if content_info.dump() != cms_der:
        fail('NON_CANONICAL_CMS_DER')
    if content_info['content_type'].native != 'signed_data':
        fail('CMS_NOT_SIGNED_DATA')

    signed_data = content_info['content']
    if signed_data['encap_content_info']['content_type'].dotted != OID_DATA:
        fail('UNSUPPORTED_CONTENT_TYPE')
    if signed_data['encap_content_info']['content'].native is not None:
        fail('CMS_MUST_BE_DETACHED')
    if len(signed_data['signer_infos']) != 1:
        fail('CMS_MUST_HAVE_ONE_SIGNER')

    signer_info = signed_data['signer_infos'][0]
    digest_oid = signer_info['digest_algorithm']['algorithm'].dotted
    digest_algorithms = {
        item['algorithm'].dotted for item in signed_data['digest_algorithms']
    }
    if digest_algorithms != {digest_oid}:
        fail('DIGEST_ALGORITHM_NOT_DECLARED')
    for algorithm_oid in digest_algorithms:
        if algorithm_oid not in DIGESTS:
            fail('UNSUPPORTED_DIGEST_ALGORITHM')

    signed_attrs = signer_info['signed_attrs']
    if signed_attrs.native is None:
        fail('SIGNED_ATTRIBUTES_REQUIRED')
    content_type = unique_attribute(signed_attrs, OID_CONTENT_TYPE)
    message_digest = unique_attribute(signed_attrs, OID_MESSAGE_DIGEST)
    signing_certificate_v2 = unique_attribute(
        signed_attrs,
        OID_SIGNING_CERTIFICATE_V2,
    )
    if content_type.native != 'data':
        fail('SIGNED_CONTENT_TYPE_MISMATCH')
    if message_digest.native != digest_bytes(digest_oid, content):
        fail('CONTENT_DIGEST_MISMATCH')

    signer_certificate = select_signer_certificate(signed_data, signer_info)
    signer_identity = certificate_identity(signer_certificate)
    if (
        expected_certificate_sha256 is not None
        and signer_identity['certificateSha256'] != expected_certificate_sha256.lower()
    ):
        fail('UNEXPECTED_SIGNER_CERTIFICATE')
    validate_signing_certificate_v2(signing_certificate_v2, signer_certificate)

    signed_attrs_der = signed_attrs.untag().dump(force=True)
    expected_implicit_encoding = b'\xa0' + signed_attrs_der[1:]
    if signed_attrs.dump() != expected_implicit_encoding:
        fail('NON_CANONICAL_SIGNED_ATTRIBUTES')
    signature_oid = signer_info['signature_algorithm']['algorithm'].dotted
    signature = signer_info['signature'].native
    if signature_oid in {
        OID_GOST_2012_256_SIGNATURE,
        OID_GOST_2012_512_SIGNATURE,
    }:
        verify_gost_signature(
            signer_certificate,
            signature_oid,
            digest_oid,
            signed_attrs_der,
            signature,
        )
    else:
        verify_standard_signature(
            signer_certificate,
            signature_oid,
            digest_oid,
            signed_attrs_der,
            signature,
        )

    return {
        'ok': True,
        'certificateSha256': signer_identity['certificateSha256'],
        'digestAlgorithm': digest_oid,
        'signatureAlgorithm': signature_oid,
    }


def main():
    if len(sys.argv) < 3:
        raise SystemExit(
            'usage: verify-cms.py inspect-certificate <cert.der> | '
            'verify <cms.der> <content.bin> [expected-cert-sha256]',
        )
    command = sys.argv[1]
    if command == 'inspect-certificate' and len(sys.argv) == 3:
        certificate = load_certificate(Path(sys.argv[2]).read_bytes())
        result = {'ok': True, **certificate_identity(certificate)}
    elif command == 'verify' and len(sys.argv) in {4, 5}:
        result = verify_cms(
            Path(sys.argv[2]).read_bytes(),
            Path(sys.argv[3]).read_bytes(),
            sys.argv[4] if len(sys.argv) == 5 else None,
        )
    else:
        raise SystemExit('invalid arguments')
    sys.stdout.write(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except VerificationError as error:
        sys.stderr.write(json.dumps({'ok': False, 'code': error.code}))
        raise SystemExit(2)
