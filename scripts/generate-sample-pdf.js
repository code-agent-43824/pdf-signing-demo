const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

(async () => {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595, 842]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  page.drawRectangle({ x: 40, y: 690, width: 515, height: 110, color: rgb(0.95, 0.97, 1) });
  page.drawText('Form 001', { x: 56, y: 760, size: 22, font: bold, color: rgb(0.11, 0.2, 0.47) });
  page.drawText('Demo document for the future PAdES signing flow', { x: 56, y: 735, size: 13, font, color: rgb(0.18, 0.23, 0.31) });
  page.drawText('Recipient: Kirill', { x: 56, y: 700, size: 12, font });

  const lines = [
    '1. This PDF is stored on the server and displayed in the web interface.',
    '2. Next step: prepare a signature placeholder and calculate the proper byte range.',
    '3. The signature should be produced on the client via CryptoPro Browser Plugin.',
    '4. After that, the signature will be embedded back into the resulting PDF file.',
  ];

  let y = 640;
  for (const line of lines) {
    page.drawText(line, { x: 56, y, size: 12, font, color: rgb(0.15, 0.18, 0.24) });
    y -= 28;
  }

  page.drawRectangle({ x: 56, y: 430, width: 220, height: 90, borderColor: rgb(0.42, 0.46, 0.54), borderWidth: 1 });
  page.drawText('Future signature area', { x: 72, y: 485, size: 14, font: bold });
  page.drawText('placeholder / visual stamp zone', { x: 72, y: 460, size: 11, font, color: rgb(0.42, 0.46, 0.54) });

  const bytes = await pdfDoc.save();
  const out = path.join(__dirname, '..', 'public', 'assets', 'formular.pdf');
  fs.writeFileSync(out, bytes);
  console.log(`written ${out}`);
})();
