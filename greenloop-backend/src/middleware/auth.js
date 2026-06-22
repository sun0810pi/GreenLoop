const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'greenloop-secret-change-in-prod';

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  return [auth, (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: `Access restricted to: ${roles.join(', ')}` });
    }
    next();
  }];
}

module.exports = { auth, requireRole };
