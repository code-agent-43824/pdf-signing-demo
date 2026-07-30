#!/usr/bin/env python3
import sys
from pathlib import Path

from pyhanko.sign import signers


def main():
    if len(sys.argv) not in {5, 6}:
        raise SystemExit(
            'usage: create_cms.py <content.bin> <cert.pem> <key.pem> '
            '<output.der> [--attached]',
        )
    content_path, cert_path, key_path, output_path = map(Path, sys.argv[1:5])
    signer = signers.SimpleSigner.load(
        key_file=str(key_path),
        cert_file=str(cert_path),
    )
    if signer is None:
        raise SystemExit('unable to load test signer')
    cms = signer.sign_general_data(
        content_path.read_bytes(),
        'sha256',
        detached='--attached' not in sys.argv[5:],
        use_cades=True,
    )
    output_path.write_bytes(cms.dump())


if __name__ == '__main__':
    main()
