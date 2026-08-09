const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { HttpError } = require('../http/validation');

function createStampConfiguration({
  projectRoot,
  localFontsDir,
  stampConfigPath,
  fontDirs = [
    localFontsDir,
    '/usr/share/fonts',
    '/usr/local/share/fonts',
    path.join(process.env.HOME || '', '.fonts'),
    path.join(process.env.HOME || '', '.local', 'share', 'fonts'),
  ].filter(Boolean),
}) {
  function read() {
    return fs.readFileSync(stampConfigPath, 'utf8');
  }

  function parse(raw) {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Stamp config must be a JSON object.');
    }
    return parsed;
  }

  function collectFontFiles(dirPath, result = []) {
    if (!dirPath || !fs.existsSync(dirPath)) {
      return result;
    }

    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        collectFontFiles(fullPath, result);
        continue;
      }
      if (/\.(ttf|otf|ttc)$/i.test(entry.name)) {
        result.push(fullPath);
      }
    }

    return result;
  }

  function resolveConfiguredFontPath(fontPath) {
    return path.normalize(
      path.isAbsolute(fontPath) ? fontPath : path.resolve(projectRoot, fontPath),
    );
  }

  function createCatalog() {
    const fonts = Array.from(new Set(fontDirs.flatMap((dir) => collectFontFiles(dir))))
      .sort((left, right) => left.localeCompare(right, 'ru'))
      .map((fontPath) => ({
        id: `font-${crypto.createHash('sha256').update(fontPath).digest('hex').slice(0, 16)}`,
        serverPath: path.normalize(fontPath),
        label: path.basename(fontPath).replace(/\.(ttf|otf|ttc)$/i, ''),
      }));

    return {
      fonts,
      byId: new Map(fonts.map((font) => [font.id, font])),
      byServerPath: new Map(fonts.map((font) => [font.serverPath, font])),
    };
  }

  function visitConfiguredFonts(config, callback) {
    const fonts = config?.appearance?.fonts;
    for (const role of ['title', 'label', 'value']) {
      const entry = fonts?.[role];
      if (entry?.path) {
        callback(entry, role);
      }
    }
  }

  function toClient(config, catalog) {
    const clientConfig = structuredClone(config);
    visitConfiguredFonts(clientConfig, (entry) => {
      const serverPath = resolveConfiguredFontPath(entry.path);
      const font = catalog.byServerPath.get(serverPath);
      if (!font) {
        throw new Error('Configured stamp font is unavailable.');
      }
      entry.path = font.id;
    });
    return clientConfig;
  }

  function toServer(config, catalog) {
    const serverConfig = structuredClone(config);
    visitConfiguredFonts(serverConfig, (entry) => {
      const font = catalog.byId.get(entry.path);
      if (!font) {
        throw new HttpError(
          400,
          'UNKNOWN_FONT',
          'Некорректная конфигурация штампа.',
          { fontId: entry.path },
        );
      }
      entry.path = font.serverPath;
    });
    return serverConfig;
  }

  function listAvailable(catalog) {
    return catalog.fonts.map((font) => ({
      id: font.id,
      label: font.label,
    }));
  }

  return {
    createCatalog,
    listAvailable,
    parse,
    read,
    toClient,
    toServer,
  };
}

module.exports = {
  createStampConfiguration,
};
