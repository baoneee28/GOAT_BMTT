// src/middleware/admin.js

/**
 * Demo admin check:
 * - Cho phép nếu username == ADMIN_USERNAME (env), hoặc userId == ADMIN_ID
 * Ví dụ .env:
 *   ADMIN_USERNAME=alice
 *   ADMIN_ID=1
 */
export function adminRequired(req, res, next) {
  const adminUsername = process.env.ADMIN_USERNAME || "";
  const adminId = Number(process.env.ADMIN_ID || 0);

  const u = req.user; // { id, username } từ authRequired
  const ok =
    (adminUsername && u?.username === adminUsername) ||
    (adminId && Number(u?.id) === adminId);

  if (!ok) return res.status(403).json({ error: "Admin only" });
  return next();
}
