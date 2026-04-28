const fs = require('fs');
const path = require('path');
const fontkit = require('@pdf-lib/fontkit');
const { PDFDocument, rgb } = require('pdf-lib');

const FONT_PATH = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const FONT_BOLD_PATH = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

function drawCell(page, { x, y, width, height, text = '', font, size = 10, bold = false, fill, color = rgb(0, 0, 0), align = 'left' }) {
  page.drawRectangle({
    x,
    y,
    width,
    height,
    borderColor: rgb(0.45, 0.5, 0.58),
    borderWidth: 0.8,
    color: fill,
  });

  if (!text) return;

  const textWidth = font.widthOfTextAtSize(text, size);
  const textX = align === 'center'
    ? x + (width - textWidth) / 2
    : x + 8;

  page.drawText(text, {
    x: textX,
    y: y + height / 2 - size / 2 + 2,
    size,
    font,
    color,
  });
}

(async () => {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);
  const regular = await pdfDoc.embedFont(fs.readFileSync(FONT_PATH), { subset: true });
  const bold = await pdfDoc.embedFont(fs.readFileSync(FONT_BOLD_PATH), { subset: true });
  const page = pdfDoc.addPage([595, 842]);

  page.drawRectangle({ x: 32, y: 32, width: 531, height: 778, borderColor: rgb(0.22, 0.28, 0.38), borderWidth: 1.2 });

  page.drawText('ФОРМУЛЯР СЕРТИФИКАЦИОННОГО ДОКУМЕНТА', {
    x: 84,
    y: 780,
    size: 16,
    font: bold,
    color: rgb(0.08, 0.16, 0.35),
  });
  page.drawText('Карточка программного средства, представленного на оценку соответствия', {
    x: 86,
    y: 758,
    size: 10,
    font: regular,
    color: rgb(0.24, 0.28, 0.36),
  });

  drawCell(page, { x: 42, y: 712, width: 100, height: 26, text: 'Рег. №', font: bold, size: 9, fill: rgb(0.94, 0.96, 0.99) });
  drawCell(page, { x: 142, y: 712, width: 170, height: 26, text: 'SW-CERT-2026-041', font: regular, size: 10 });
  drawCell(page, { x: 312, y: 712, width: 100, height: 26, text: 'Дата', font: bold, size: 9, fill: rgb(0.94, 0.96, 0.99) });
  drawCell(page, { x: 412, y: 712, width: 141, height: 26, text: '28.04.2026', font: regular, size: 10 });

  drawCell(page, { x: 42, y: 676, width: 511, height: 26, text: 'Наименование программного средства', font: bold, size: 9, fill: rgb(0.94, 0.96, 0.99), align: 'center' });
  drawCell(page, { x: 42, y: 640, width: 511, height: 36, text: 'PDF Signing Demo / Web-модуль подписания PDF-документов', font: regular, size: 11 });

  drawCell(page, { x: 42, y: 604, width: 180, height: 26, text: 'Версия / сборка', font: bold, size: 9, fill: rgb(0.94, 0.96, 0.99) });
  drawCell(page, { x: 222, y: 604, width: 331, height: 26, text: '1.0.0-demo / build cert-preview', font: regular, size: 10 });

  drawCell(page, { x: 42, y: 568, width: 180, height: 26, text: 'Правообладатель / заявитель', font: bold, size: 9, fill: rgb(0.94, 0.96, 0.99) });
  drawCell(page, { x: 222, y: 568, width: 331, height: 26, text: 'ООО «Пример Софт Сертификация»', font: regular, size: 10 });

  drawCell(page, { x: 42, y: 532, width: 180, height: 26, text: 'Назначение', font: bold, size: 9, fill: rgb(0.94, 0.96, 0.99) });
  drawCell(page, { x: 222, y: 532, width: 331, height: 26, text: 'Подготовка, внешнее подписание и выпуск подписанных PDF-файлов', font: regular, size: 10 });

  drawCell(page, { x: 42, y: 486, width: 511, height: 32, text: 'Сведения о комплекте документации', font: bold, size: 9, fill: rgb(0.94, 0.96, 0.99), align: 'center' });
  drawCell(page, { x: 42, y: 452, width: 90, height: 34, text: '№', font: bold, size: 9, fill: rgb(0.97, 0.98, 1), align: 'center' });
  drawCell(page, { x: 132, y: 452, width: 291, height: 34, text: 'Наименование документа', font: bold, size: 9, fill: rgb(0.97, 0.98, 1), align: 'center' });
  drawCell(page, { x: 423, y: 452, width: 130, height: 34, text: 'Идентификатор', font: bold, size: 9, fill: rgb(0.97, 0.98, 1), align: 'center' });

  const rows = [
    ['1', 'Описание архитектуры и сценария подписи', 'ARCH-01'],
    ['2', 'Спецификация API prepare / complete', 'API-02'],
    ['3', 'Инструкция пользователя', 'USR-03'],
    ['4', 'Протокол контрольной проверки', 'TST-04'],
  ];

  let y = 418;
  for (const [n, doc, id] of rows) {
    drawCell(page, { x: 42, y, width: 90, height: 34, text: n, font: regular, size: 10, align: 'center' });
    drawCell(page, { x: 132, y, width: 291, height: 34, text: doc, font: regular, size: 10 });
    drawCell(page, { x: 423, y, width: 130, height: 34, text: id, font: regular, size: 10, align: 'center' });
    y -= 34;
  }

  drawCell(page, { x: 42, y: 222, width: 511, height: 34, text: 'Примечание', font: bold, size: 9, fill: rgb(0.94, 0.96, 0.99), align: 'center' });
  page.drawRectangle({ x: 42, y: 102, width: 511, height: 120, borderColor: rgb(0.45, 0.5, 0.58), borderWidth: 0.8 });

  const noteLines = [
    'Настоящий формуляр используется как демонстрационный исходный документ для сценария',
    'квалифицированного подписания PDF. Исходная версия не содержит видимых полей подписи,',
    'штампов и областей «future signature area». Видимое представление подписи формируется',
    'только в подписанной ревизии документа средствами PDF signature appearance.',
  ];

  let noteY = 196;
  for (const line of noteLines) {
    page.drawText(line, { x: 52, y: noteY, size: 10, font: regular, color: rgb(0.18, 0.2, 0.26) });
    noteY -= 22;
  }

  page.drawText('Ответственный исполнитель: ____________________', {
    x: 52,
    y: 68,
    size: 10,
    font: regular,
    color: rgb(0.12, 0.16, 0.22),
  });
  page.drawText('М.П. / при наличии', {
    x: 420,
    y: 68,
    size: 10,
    font: regular,
    color: rgb(0.12, 0.16, 0.22),
  });

  const bytes = await pdfDoc.save();
  const out = path.join(__dirname, '..', 'public', 'assets', 'formular.pdf');
  fs.writeFileSync(out, bytes);
  console.log(`written ${out}`);
})();
