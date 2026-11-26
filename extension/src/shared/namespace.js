/* Shared namespace. Content scripts cannot use ES modules, so every file in the
   content-script list attaches itself to this one global object instead. */
globalThis.HUEN = globalThis.HUEN || {};
