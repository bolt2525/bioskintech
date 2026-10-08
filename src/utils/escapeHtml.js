const HTML_ENTITIES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** @param {unknown} value */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => HTML_ENTITIES[character]);
}

/** Restricts image sources to non-executable URL schemes before attribute escaping. @param {unknown} value */
export function safeImageSrc(value) {
  const source = String(value ?? '').trim();
  if (!/^(?:https?:\/\/|\/(?!\/)|data:image\/(?:png|jpe?g|webp);base64,)/i.test(source)) return '';
  return escapeHtml(source);
}
