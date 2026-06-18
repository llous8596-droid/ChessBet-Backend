// ============================================================
// Rate limiter simple, en mémoire (pas de dépendance externe).
// Convient pour une seule instance serveur (cas de Render free/starter).
// Si tu passes en multi-instances un jour, remplace par un store Redis.
// ============================================================

const buckets = new Map(); // clé → [timestamps des requêtes]

// Nettoyage périodique pour éviter une fuite mémoire sur le long terme
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of buckets.entries()) {
    const filtered = timestamps.filter(t => now - t < 15 * 60 * 1000); // garde 15 min
    if (filtered.length === 0) buckets.delete(key);
    else buckets.set(key, filtered);
  }
}, 5 * 60 * 1000);

/**
 * Crée un middleware Express qui limite le nombre de requêtes par IP
 * (ou par une clé personnalisée) sur une fenêtre de temps donnée.
 *
 * @param {number} maxRequests - nombre maximum de requêtes autorisées
 * @param {number} windowMs - durée de la fenêtre en millisecondes
 * @param {string} label - préfixe pour identifier ce limiteur dans les clés (évite les collisions entre routes)
 * @param {(req) => string} [keyFn] - fonction optionnelle pour personnaliser la clé (ex: par email plutôt que par IP)
 */
function rateLimit(maxRequests, windowMs, label, keyFn) {
  return (req, res, next) => {
    const identifier = keyFn ? keyFn(req) : (req.ip || req.headers['x-forwarded-for'] || 'unknown');
    const key = `${label}:${identifier}`;
    const now = Date.now();

    const timestamps = (buckets.get(key) || []).filter(t => now - t < windowMs);
    if (timestamps.length >= maxRequests) {
      const retryAfterSec = Math.ceil((timestamps[0] + windowMs - now) / 1000);
      res.set('Retry-After', String(retryAfterSec));
      return res.status(429).json({ error: `Trop de requêtes. Réessaie dans ${retryAfterSec}s.` });
    }

    timestamps.push(now);
    buckets.set(key, timestamps);
    next();
  };
}

module.exports = { rateLimit };
