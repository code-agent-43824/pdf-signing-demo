# Golden PDF corpus

The committed corpus contains structural PDF inputs that exercise the current
preparation pipeline without including personal documents, production
certificates or private keys.

`generate.py` produces:

- `simple.pdf` — one A4-like page;
- `multipage.pdf` — three pages with different dimensions;
- `acroform.pdf` — a document with an existing AcroForm;
- `empty-signature-field.pdf` — an unsigned signature widget;
- `nonstandard-geometry.pdf` — custom MediaBox/CropBox and page rotation;
- `invalid/malformed.pdf` — a deliberately truncated PDF;
- `invalid/malformed-cms.der` — deliberately truncated ASN.1.

Valid signed PDFs with one through four incremental signatures are generated
at test time in a private temporary directory. The test certificate and key
are ephemeral and are never committed. This keeps the repository free of
reusable private keys while still exercising the exact application functions
`createPreparedPdf` and `embedCmsSignature`.

`manifest.json` records SHA-256, size and structural expectations for every
committed fixture. Regenerate the corpus with:

```bash
npm run fixtures:generate
```

The generated files must be reviewed and committed together with the updated
manifest.
