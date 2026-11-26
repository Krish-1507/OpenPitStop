export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).end();
  return next();
}

export function requireRole(role) {
  return (req, res, next) => (req.user.role === role ? next() : res.status(403).end());
}
