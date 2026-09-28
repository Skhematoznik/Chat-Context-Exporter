(() => {
  'use strict';

  const ROOT_KEY = '__chatContextExporter';
  const existing = globalThis[ROOT_KEY];

  if (existing && typeof existing === 'object') {
    existing.version = '0.5.1';
    existing.modules ||= Object.create(null);
    existing.adapters ||= [];
    return;
  }

  globalThis[ROOT_KEY] = {
    version: '0.5.1',
    modules: Object.create(null),
    adapters: [],
  };
})();
