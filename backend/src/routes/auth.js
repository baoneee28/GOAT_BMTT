// src/routes/auth.js
import express from "express";
import jwt from "jsonwebtoken";
import { poolPromise, sql } from "../db.js";
import { genSalt, hashPassword, safeEqual } from "../services/password.js";

export const authRouter = express.Router();

// ----------------------------------------------------------------------
// IN-MEMORY OTP STORE (Demo only)
// ----------------------------------------------------------------------
const otpStore = new Map();

/**
 * 0. POST /api/auth/register
 * Body: { username, password }
 * Logic: Create user if not exists.
 */
authRouter.post("/register", async (req, res) => {
  let { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Username and Password required" });
  username = username.trim();

  try {
    const pool = await poolPromise;
    // Check exist
    const check = await pool.request()
        .input("Username", sql.NVarChar(50), username)
        .query("SELECT Id FROM dbo.Users WHERE Username = @Username");
    
    if (check.recordset.length > 0) {
        return res.status(409).json({ error: "Username already exists. Please Login." });
    }

    // Hash Password
    const iterations = 150000;
    const salt = genSalt(16);
    const pwdHash = hashPassword(password, salt, iterations);

    // Create User
    await pool
      .request()
      .input("Username", sql.NVarChar(50), username)
      .input("PasswordHash", sql.VarBinary(32), pwdHash)
      .input("Salt", sql.VarBinary(32), salt)
      .input("Iterations", sql.Int, iterations)
      .input("EmptyPem", sql.NVarChar(sql.MAX), "")
      .query(`
        INSERT INTO dbo.Users(Username, PasswordHash, Salt, Iterations, PublicKeyPem)
        VALUES (@Username, @PasswordHash, @Salt, @Iterations, @EmptyPem)
      `);

    return res.json({ ok: true, message: "Registered! Please Login." });
  } catch (e) {
    console.error("Register Error:", e);
    return res.status(500).json({ error: e.message });
  }
});

/**
 * 1. POST /api/auth/otp/request
 * Body: { username, password }
 * Logic: Checks user exists, VERIFY PASSWORD, gen OTP.
 */
authRouter.post("/otp/request", async (req, res) => {
  let { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Username and Password required" });
  
  username = username.trim();

  try {
    const pool = await poolPromise;
    // Get User & Credentials
    let userRes = await pool
      .request()
      .input("Username", sql.NVarChar(50), username)
      .query("SELECT Id, PasswordHash, Salt, Iterations FROM dbo.Users WHERE Username = @Username");

    if (userRes.recordset.length === 0) {
        return res.status(404).json({ error: "Account not found." });
    }

    const u = userRes.recordset[0];
    
    // Verify Password
    const salt = Buffer.from(u.Salt);
    const storedHash = Buffer.from(u.PasswordHash);
    const iterations = u.Iterations;
    
    // If user was created with dummy password (previous demo users), this might fail or pass depending on implementation.
    // Ideally we should have reset them. But for now, standard check:
    const testHash = hashPassword(password, salt, iterations);
    if (!safeEqual(testHash, storedHash)) {
         return res.status(401).json({ error: "Incorrect password" });
    }

    // Generate OTP
    const otp = "123456"; // Fixed for Demo
    
    otpStore.set(username, {
      otp,
      expires: Date.now() + 5 * 60 * 1000, // 5 mins
    });

    console.log(`[OTP] Generated for ${username}: ${otp}`);
    return res.json({ ok: true, message: "Password OK. OTP sent.", demoOtp: otp });
  } catch (e) {
    console.error("OTP Request Error:", e);
    return res.status(500).json({ error: e.message });
  }
});

/**
 * 2. POST /api/auth/otp/verify
 * Body: { username, otp }
 * Logic: Validate OTP. Return "Enroll Token".
 * Enroll Token is a short-lived JWT allowing access to /enroll-device only.
 */
authRouter.post("/otp/verify", async (req, res) => {
  let { username, otp } = req.body || {};
  if (!username || !otp) return res.status(400).json({ error: "Missing info" });
  
  username = username.trim(); // Normalize

  const stored = otpStore.get(username);
  
  // Debug log
  if (!stored) {
    console.log(`[OTP-FAIL] No OTP found for '${username}'. Store keys:`, [...otpStore.keys()]);
    return res.status(400).json({ error: "No OTP request found (Client may have timed out or Server restarted)" });
  }

  if (Date.now() > stored.expires) return res.status(400).json({ error: "OTP expired" });
  if (stored.otp !== otp) return res.status(400).json({ error: "Invalid OTP" });

  // OTP OK
  otpStore.delete(username); // One-time use

  // Issue "Enrollment Token" (valid 5 mins)
  const enrollToken = jwt.sign({ username, type: "provisional" }, process.env.JWT_SECRET, {
    expiresIn: "5m",
  });

  return res.json({ ok: true, enrollToken });
});

/**
 * 3. POST /api/auth/enroll-device
 * Headers: Authorization: Bearer <enrollToken>
 * Body: { deviceId, publicKeyPem }
 * Logic: 
 *   - Find User by username (from token)
 *   - Insert/Update UserDevices
 *   - Return long-lived Access Token (Login)
 */
authRouter.post("/enroll-device", async (req, res) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;

  if (!token) return res.status(401).json({ error: "Missing enroll token" });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.type !== "provisional") throw new Error("Invalid token type");
  } catch (e) {
    return res.status(403).json({ error: "Invalid enroll token" });
  }

  const { deviceId, publicKeyPem } = req.body || {};
  if (!deviceId || !publicKeyPem) {
    return res.status(400).json({ error: "deviceId and publicKeyPem required" });
  }

  console.log(`[DEMO-ENROLL] DeviceID: ${deviceId} | Public Key:\n${publicKeyPem}`);

  const username = payload.username;

  try {
    const pool = await poolPromise;
    
    // Get UserId
    const uRes = await pool
      .request()
      .input("Username", sql.NVarChar(50), username)
      .query("SELECT Id FROM dbo.Users WHERE Username = @Username");
    
    if (uRes.recordset.length === 0) return res.status(404).json({ error: "User not found" });
    const userId = uRes.recordset[0].Id;

    // Upsert Device (if deviceId exists for this user, update key?)
    // Or just Insert and fail on unique constraint?
    // Let's use MERGE or simple Check-Insert to handle "Re-enroll"
    // "Enroll" means "New Key". If device exists, update key.
    
    const check = await pool.request()
        .input("UserId", sql.Int, userId)
        .input("DeviceId", sql.VarChar(64), deviceId)
        .query("SELECT Id FROM dbo.UserDevices WHERE UserId=@UserId AND DeviceId=@DeviceId");

    if (check.recordset.length > 0) {
        // Update
        await pool.request()
            .input("UserId", sql.Int, userId)
            .input("DeviceId", sql.VarChar(64), deviceId)
            .input("Key", sql.NVarChar(sql.MAX), publicKeyPem)
            .query("UPDATE dbo.UserDevices SET PublicKeyPem=@Key, LastSeenAt=SYSDATETIME() WHERE UserId=@UserId AND DeviceId=@DeviceId");
    } else {
        // Insert
        await pool.request()
            .input("UserId", sql.Int, userId)
            .input("DeviceId", sql.VarChar(64), deviceId)
            .input("Key", sql.NVarChar(sql.MAX), publicKeyPem)
            .query("INSERT INTO dbo.UserDevices(UserId, DeviceId, PublicKeyPem, LastSeenAt) VALUES (@UserId, @DeviceId, @Key, SYSDATETIME())");
    }

    // Issue Real Access Token
    const accessToken = jwt.sign({ id: userId, username }, process.env.JWT_SECRET, {
        expiresIn: "15m", // Short lived for security demo
    });

    console.log(`[DEMO-HACKER] Access Token for ${username} (Device: ${deviceId}):`, accessToken);

    return res.json({ ok: true, token: accessToken, user: { id: userId, username } });

  } catch (e) {
    console.error("Enroll Error:", e);
    return res.status(500).json({ error: "Enroll failed", detail: e.message });
  }
});
