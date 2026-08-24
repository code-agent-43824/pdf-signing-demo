(function attachStampConfig(root) {
  function clone(config) {
    if (config === undefined) return undefined;
    return JSON.parse(JSON.stringify(config));
  }

  function merge(base, override) {
    if (Array.isArray(base) || Array.isArray(override)) return clone(override ?? base);
    if (!base || typeof base !== 'object') return clone(override ?? base);
    const result = clone(base);
    if (!override || typeof override !== 'object') return result;
    Object.entries(override).forEach(([key, value]) => {
      if (value && typeof value === 'object' && !Array.isArray(value)
        && result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
        result[key] = merge(result[key], value);
      } else {
        result[key] = clone(value);
      }
    });
    return result;
  }

  function ensureShape(config) {
    const draft = clone(config);
    draft.appearance ||= {};
    draft.appearance.separator ||= {};
    draft.appearance.fonts ||= {};
    draft.appearance.fonts.title ||= {};
    draft.appearance.fonts.label ||= {};
    draft.appearance.fonts.value ||= {};
    draft.appearance.layout ||= {};
    draft.content ||= {};
    draft.content.title ||= [];
    draft.content.rows ||= [];
    draft.signatureObject ||= {};
    draft.placements ||= {};
    draft.placements.rules ||= [{}];
    if (!draft.placements.rules.length) draft.placements.rules.push({});
    draft.placements.rules[0].pages ||= {};
    draft.placements.rules[0].placement ||= {};
    draft.limits ||= {};
    return draft;
  }

  function createStampConfigStore(storage, key) {
    function load() {
      try {
        const raw = storage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch (_error) {
        return null;
      }
    }

    function save(config) {
      storage.setItem(key, JSON.stringify(config));
    }

    function clear() {
      storage.removeItem(key);
    }

    function resolve(serverConfig) {
      const saved = load();
      return ensureShape(saved ? merge(serverConfig, saved) : serverConfig);
    }

    return Object.freeze({
      clear,
      clone,
      ensureShape,
      has: () => Boolean(load()),
      load,
      merge,
      resolve,
      save,
    });
  }

  root.PdfSigningStampConfig = Object.freeze({ createStampConfigStore });
}(window));
