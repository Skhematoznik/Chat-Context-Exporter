(() => {
  'use strict';

  const ROOT_KEY = '__chatContextExporter';
  const existing = globalThis[ROOT_KEY];

  if (existing && typeof existing === 'object') {
    existing.version = '1.3.2';
    existing.modules ||= Object.create(null);
    existing.adapters ||= [];
    return;
  }

  globalThis[ROOT_KEY] = {
    version: '1.3.2',
    modules: Object.create(null),
    adapters: [],
  };
})();
