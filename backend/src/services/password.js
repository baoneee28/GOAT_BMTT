//password.js
import crypto from "crypto";

export function genSalt(bytes = 16) {
  return crypto.randomBytes(bytes); // 16 bytes là đủ
}

export function hashPassword(password, salt, iterations = 150000) {
  return crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256");
}

export function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
