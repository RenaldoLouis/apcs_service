// Keep the supplied 2025 document for dummy testing only.
// After the owner supplies the final client PDF, install it in services/attachments
// and set clientAttachment to { filename: '...', sha256: '64 lowercase hex characters' }.
// A successful dummy test of that exact version is still required before starting bulk.
module.exports = { clientAttachment: null };
