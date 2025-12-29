import crypto from "crypto";
import jwt from "jsonwebtoken";
import { poolPromise, sql } from "../db.js";
import { sha256 } from "../services/signature.js";
import { buildMessagePayload } from "../services/messagePayload.js";

/**
 * Socket.IO secured by JWT + verify message signature RSA-PSS
 */
export function initSocket(io) {
  // 1) Authenticate socket bằng JWT (handshake)
  io.use((socket, next) => {
    try {
      const header =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization ||
        "";

      const token = header.startsWith("Bearer ") ? header.slice(7) : header;
      if (!token) return next(new Error("Missing token"));

      const payload = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = payload; // { id, username }
      return next();
    } catch (e) {
      return next(new Error("Invalid token"));
    }
  });

  io.on("connection", (socket) => {
    // Join personal room for notifications
    socket.join(`user:${socket.user.id}`);

    // 2) Join conversation room (must be member)
    socket.on("conversation:join", async ({ conversationId }, ack) => {
      try {
        const convId = Number(conversationId);
        if (!convId) return ack?.({ ok: false, error: "Missing conversationId" });

        const me = socket.user.id;
        const pool = await poolPromise;

        const mem = await pool
          .request()
          .input("ConversationId", sql.Int, convId)
          .input("UserId", sql.Int, me)
          .query(
            `SELECT 1 FROM dbo.ConversationMembers WHERE ConversationId=@ConversationId AND UserId=@UserId`
          );

        if (mem.recordset.length === 0)
          return ack?.({ ok: false, error: "Not a member" });

        socket.join(`conv:${convId}`);
        return ack?.({ ok: true });
      } catch (e) {
        console.error("conversation:join error:", e);
        return ack?.({ ok: false, error: "Server error" });
      }
    });

    /**
     * message:send
     * Client sends: { conversationId, body, clientTimestamp, nonce, signatureBase64 }
     * NOTE: senderId is derived from JWT => socket.user.id
     */
    socket.on("message:send", async (msg, ack) => {
      try {
        const me = socket.user.id;

        const { conversationId, body, clientTimestamp, signatureBase64, nonceBase64, deviceId } =
          msg || {};

        const convId = Number(conversationId);
        // require nonceBase64 & deviceId
        if (!convId || typeof body !== "string" || !signatureBase64 || !nonceBase64 || !deviceId) {
          return ack?.({ ok: false, error: "Invalid payload (missing nonce/sig/deviceId)" });
        }

        // --- [SECURE FIX 1] Timestamp Validation (Window +/- 5 minutes) ---
        const ts = new Date(clientTimestamp);
        if (Number.isNaN(ts.getTime())) {
          return ack?.({ ok: false, error: "Invalid clientTimestamp" });
        }

        const now = Date.now();
        const driftMs = Math.abs(now - ts.getTime());
        console.log(`[DEBUG] Timestamp Check: Client=${clientTimestamp}, ServerNow=${now}, Drift=${driftMs}ms`);

        if (driftMs > 5 * 60 * 1000) {
          console.log("[DEBUG] Blocked: Timestamp out of allowed window");
          return ack?.({ ok: false, error: "Timestamp out of allowed window" });
        }
        // ------------------------------------------------------------------

        const pool = await poolPromise;

        // 1) Authorization: must be member
        const mem = await pool
          .request()
          .input("ConversationId", sql.Int, convId)
          .input("UserId", sql.Int, me)
          .query(
            `SELECT 1 FROM dbo.ConversationMembers WHERE ConversationId=@ConversationId AND UserId=@UserId`
          );

        if (mem.recordset.length === 0)
          return ack?.({ ok: false, error: "Not a member" });

        // 2) Load public key of specific device
        const u = await pool
          .request()
          .input("UserId", sql.Int, me)
          .input("DeviceId", sql.VarChar(64), deviceId)
          .query(`SELECT PublicKeyPem FROM dbo.UserDevices WHERE UserId=@UserId AND DeviceId=@DeviceId`);

        if (u.recordset.length === 0)
          return ack?.({ ok: false, error: "Device not enrolled or unauthorized" });

        // IMPORTANT: normalize PEM (DB có thể lưu \n thành \\n)
        const publicKeyPemRaw = u.recordset[0].PublicKeyPem;
        const publicKeyPem = String(publicKeyPemRaw)
          .replace(/\\n/g, "\n")
          .trim();

        console.log(`[DEMO-VERIFY] Using Public Key for ${deviceId}:\n${publicKeyPem}`);

        // 3) Build canonical payload -> hash
        // format: `${conversationId}|${clientTimestamp}|${nonceBase64}|${body}`
        const payload = buildMessagePayload({
          conversationId: convId,
          // senderId: me, // <-- NO senderId in signature as requested
          body,
          clientTimestamp,
          nonce: nonceBase64,
        });

        const hash = sha256(payload); // Buffer(32)

        // --- [SECURE FIX 2] Replay Protection (Nonce + Hash) ---
        const nonceBuf = Buffer.from(nonceBase64, "base64");
        if (nonceBuf.length !== 16) {
          return ack?.({ ok: false, error: "Nonce must be 16 bytes" });
        }

        // Check if Nonce OR BodyHash exists
        // (Dual protection: Hash checks content, Nonce checks randomness)
        const dupCheck = await pool
          .request()
          .input("BodyHash", sql.VarBinary(32), hash)
          .input("Nonce", sql.VarBinary(16), nonceBuf)
          .query(`
            SELECT TOP 1 1 FROM dbo.Messages 
            WHERE BodyHash=@BodyHash OR Nonce=@Nonce
          `);

        if (dupCheck.recordset.length > 0) {
          console.log("[DEBUG] Blocked: Replay attack detected (Duplicate Nonce/Hash)");
          // Check specific error to be helpful (optional) but general replay message is safer
          // But strict requirement says: Bắt lỗi unique constraint (2601/2627) để trả “Replay detected”
          // Here we check BEFORE insert to avoid SQL error logs if possible, but let's follow requirement:
          // The query above is a pre-check. If we rely ONLY on DB constraints we should remove this pre-check 
          // or keep it for optimization. The user requirement said: "Catch unique constraint error...".
          // So I will KEEP this check for UX speed, but mostly rely on the INSERT try-catch below.
          return ack?.({ ok: false, error: "Replay attack detected (Duplicate)" });
        }
        // ---------------------------------------------------------------

        // 4) Verify signature RSA-PSS (client ký trên HASH)
        // [UPDATE] Verify directly on "dataToVerify" (payload) using crypto.verify("sha256", ...)
        const sig = Buffer.from(signatureBase64, "base64");

        const ok = crypto.verify(
          "sha256",
          payload, // Buffer from buildMessagePayload
          {
            key: publicKeyPem,
            padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
            saltLength: 32,
          },
          sig
        );

        if (ok) {
          console.log("signature ok");
        } else {
          console.log("không hợp lệ");
          return ack?.({ ok: false, error: "Signature verify failed" });
        }

        // 5) Save DB (senderId must be me)
        const saved = await pool
          .request()
          .input("ConversationId", sql.Int, convId)
          .input("SenderId", sql.Int, me)
          .input("Body", sql.NVarChar(sql.MAX), body)
          .input("BodyHash", sql.VarBinary(32), hash)
          .input("Signature", sql.VarBinary(sql.MAX), sig)
          .input("ClientTimestamp", sql.DateTime2, ts) // updated type
          .input("Nonce", sql.VarBinary(16), nonceBuf)
          .query(`
            INSERT INTO dbo.Messages(ConversationId, SenderId, Body, BodyHash, Signature, ClientTimestamp, Nonce)
            OUTPUT INSERTED.Id, INSERTED.CreatedAt
            VALUES (@ConversationId, @SenderId, @Body, @BodyHash, @Signature, @ClientTimestamp, @Nonce)
          `);

        const inserted = saved.recordset[0];

        const out = {
          id: inserted.Id,
          conversationId: convId,
          senderId: me,
          body,
          clientTimestamp,
          nonce: nonceBase64,
          createdAt: inserted.CreatedAt,
          signatureBase64,
          bodyHashHex: hash.toString("hex"),
        };

        io.to(`conv:${convId}`).emit("message:new", out);
        return ack?.({ ok: true, id: inserted.Id });
      } catch (e) {
        console.error("message:send error:", e);
        // Requirement: Catch 2601/2627
        if (e.number === 2601 || e.number === 2627 || e.message.includes("UNIQUE") || e.message.includes("duplicate")) {
          return ack?.({ ok: false, error: "Replay detected" });
        }
        return ack?.({ ok: false, error: "Server error" });
      }
    }); // end socket.on
  });
}
