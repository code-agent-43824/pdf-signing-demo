(function attachPlacement(root) {
  const presets = Object.freeze({
    left: Object.freeze({ label: 'Слева', anchor: 'bottom-left', offsetX: 24, offsetY: 24 }),
    'center-left': Object.freeze({ label: 'По центру слева', anchor: 'bottom-left', offsetX: 163, offsetY: 24 }),
    'center-right': Object.freeze({ label: 'По центру справа', anchor: 'bottom-right', offsetX: 163, offsetY: 24 }),
    right: Object.freeze({ label: 'Справа', anchor: 'bottom-right', offsetX: 24, offsetY: 24 }),
  });

  function findPreset(config, getDefaultRule) {
    const placement = getDefaultRule(config)?.placement || {};
    const anchor = String(placement.anchor || 'bottom-right');
    const offsetX = Number(placement.offsetX || 0);
    const offsetY = Number(placement.offsetY || 0);
    return Object.entries(presets).find(([, preset]) => (
      preset.anchor === anchor
      && preset.offsetX === offsetX
      && preset.offsetY === offsetY
    ))?.[0] || 'right';
  }

  function createPlacementController({
    document,
    ensureShape,
    getConfig,
    getDefaultRule,
    getSelected,
    setConfig,
    setSelected,
  }) {
    function getPresetKey(config = getConfig(), { preferSelected = true } = {}) {
      const selected = getSelected();
      if (preferSelected && presets[selected]) return selected;
      return findPreset(ensureShape(config), getDefaultRule);
    }

    function update() {
      const activePreset = getPresetKey();
      document.querySelectorAll('[data-stamp-position]').forEach((button) => {
        const isActive = button.dataset.stampPosition === activePreset;
        button.classList.toggle('is-active', isActive);
        button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      });
    }

    function apply(presetKey) {
      const preset = presets[presetKey];
      if (!preset) return false;
      const draft = ensureShape(getConfig());
      draft.appearance.width = 128;
      const rule = getDefaultRule(draft);
      rule.placement.mode = 'anchored';
      rule.placement.anchor = preset.anchor;
      rule.placement.offsetX = preset.offsetX;
      rule.placement.offsetY = preset.offsetY;
      rule.placement.columns = 1;
      rule.placement.stepX = 0;
      rule.placement.stepY = 0;
      setSelected(presetKey);
      setConfig(draft);
      update();
      return true;
    }

    return Object.freeze({ apply, getPresetKey, update });
  }

  root.PdfSigningPlacement = Object.freeze({ createPlacementController, findPreset, presets });
}(window));
