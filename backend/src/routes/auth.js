// src/routes/auth.js
import express from "express";
import jwt from "jsonwebtoken";
import { poolPromise, sql } from "../db.js";
import { genSalt, hashPassword, safeEqual } from "../services/password.js";

export const authRouter = express.Router();

/**
 * POST /api/auth/register
 * body: { username, password, publicKeyPem }
 *
 * Demo: trả về salt + iterations + passwordHashHex + publicKeyPem
 */
authRouter.post("/register", async (req, res) => {
  const { username, password, publicKeyPem } = req.body || {};
  if (!username || !password || !publicKeyPem) {
    return res
      .status(400)
      .json({ error: "username, password, publicKeyPem are required" });
  }

  const iterations = 150000;
  const salt = genSalt(16); // Buffer
  const pwdHash = hashPassword(password, salt, iterations); // Buffer(32)

  try {
    const pool = await poolPromise;
    await pool
      .request()
      .input("Username", sql.NVarChar(50), username)
      .input("Salt", sql.VarBinary(32), salt)
      .input("Iterations", sql.Int, iterations)
      .input("PasswordHash", sql.VarBinary(32), pwdHash)
      .input("PublicKeyPem", sql.NVarChar(sql.MAX), publicKeyPem)
      .query(`
        INSERT INTO dbo.Users(Username, Salt, Iterations, PasswordHash, PublicKeyPem)
        VALUES (@Username, @Salt, @Iterations, @PasswordHash, @PublicKeyPem)
      `);

    // ✅ Demo return: show what was stored (hex)
    return res.json({
      ok: true,
      username,
      iterations,
      saltHex: salt.toString("hex"),
      passwordHashHex: pwdHash.toString("hex"),
      publicKeyPem,
      note:
        "Demo only: do NOT return salts/hashes in real systems. Private key should stay on client.",
    });
  } catch (e) {
    console.error("REGISTER ERROR:", e);

    const msg = e?.originalError?.info?.message || e?.message || "unknown";
    if (
      msg.includes("UNIQUE") ||
      msg.includes("duplicate") ||
      msg.includes("2627") ||
      msg.includes("2601")
    ) {
      return res.status(409).json({ error: "Username already exists" });
    }

    return res.status(500).json({ error: "Server error", detail: msg });
  }
});

/**
 * POST /api/auth/login
 * body: { username, password }
 */
authRouter.post("/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: "username, password required" });

  const pool = await poolPromise;
  const r = await pool
    .request()
    .input("Username", sql.NVarChar(50), username)
    .query(
      `SELECT TOP 1 Id, Username, Salt, Iterations, PasswordHash FROM dbo.Users WHERE Username=@Username`
    );

  if (r.recordset.length === 0)
    return res.status(401).json({ error: "Invalid credentials" });

  const u = r.recordset[0];
  const salt = Buffer.from(u.Salt);
  const storedHash = Buffer.from(u.PasswordHash);
  const iterations = u.Iterations;

  const testHash = hashPassword(password, salt, iterations);
  if (!safeEqual(testHash, storedHash))
    return res.status(401).json({ error: "Invalid credentials" });

  const token = jwt.sign({ id: u.Id, username: u.Username }, process.env.JWT_SECRET, {
    expiresIn: "2h",
  });
  return res.json({ token, user: { id: u.Id, username: u.Username } });
});
