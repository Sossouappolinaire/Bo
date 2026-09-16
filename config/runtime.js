const isRender = Boolean(process.env.RENDER_EXTERNAL_URL || process.env.RENDER_SERVICE_ID);
const publicUrl = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || ('http://localhost:' + (process.env.PORT || 10000))).replace(/\/+$/, '');
const jwtSecret = process.env.JWT_SECRET || (isRender ? '' : 'local-only-jwt-secret-change-me-please');

function runtimeErrors() {
  const errors = [];
  if (isRender && (!jwtSecret || jwtSecret.length < 32))
    errors.push('JWT_SECRET doit être défini dans Render et contenir au moins 32 caractères.');
  return errors;
}

module.exports = { isRender, publicUrl, jwtSecret, runtimeErrors };