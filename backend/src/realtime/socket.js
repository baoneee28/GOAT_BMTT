// src/realtime/socket.js
import jwt from "jsonwebtoken";
import { poolPromise, sql } from "../db.js";
import { sha256, verifySignaturePSS } from "../services/signature.js";
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
        const { conversationId, body, clientTimestamp, signatureBase64, nonce } =
          msg || {};

        const convId = Number(conversationId);
        if (!convId || typeof body !== "string" || !signatureBase64) {
          return ack?.({ ok: false, error: "Invalid payload" });
        }

        // --- [SECURE FIX 1] Timestamp Validation (Window +/- 5 minutes) ---
        const now = Date.now();
        const ct = clientTimestamp ? new Date(clientTimestamp) : null;
        const ctTime = ct && !isNaN(ct.getTime()) ? ct.getTime() : 0;
        
        if (Math.abs(now - ctTime) > 5 * 60 * 1000) {
           return ack?.({ ok: false, error: "Timestamp invalid or expired" });
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

        // 2) Load public key of current authenticated user
        const u = await pool
          .request()
          .input("UserId", sql.Int, me)
          .query(`SELECT PublicKeyPem FROM dbo.Users WHERE Id=@UserId`);

        if (u.recordset.length === 0)
          return ack?.({ ok: false, error: "Sender not found" });

        // IMPORTANT: normalize PEM (DB có thể lưu \n thành \\n)
        const publicKeyPemRaw = u.recordset[0].PublicKeyPem;
        const publicKeyPem = String(publicKeyPemRaw)
          .replace(/\\n/g, "\n")
          .trim();

        // 3) Build canonical payload -> hash
        const payload = buildMessagePayload({
          conversationId: convId,
          senderId: me,
          body,
          clientTimestamp,
          nonce,
        });

        const hash = sha256(payload); // Buffer(32)

        // --- [SECURE FIX 2] Replay Protection (Check if Hash exists) ---
        // Nếu hash này đã có trong DB => Gói tin này đã được xử lý rồi -> Reject
        const dupCheck = await pool
          .request()
          .input("BodyHash", sql.VarBinary(32), hash)
          .query(`SELECT TOP 1 1 FROM dbo.Messages WHERE BodyHash=@BodyHash`);
        
        if (dupCheck.recordset.length > 0) {
            return ack?.({ ok: false, error: "Replay attack detected (Duplicate message)" });
        }
        // ---------------------------------------------------------------

        // 4) Verify signature RSA-PSS (client ký trên HASH)
        const sig = Buffer.from(signatureBase64, "base64");

        const ok = verifySignaturePSS({
          publicKeyPem,
          hashBuffer: hash,
          signatureBuffer: sig,
        });

        if (!ok) return ack?.({ ok: false, error: "Signature verify failed" });

        // 5) Save DB (senderId must be me)
        const saved = await pool
          .request()
          .input("ConversationId", sql.Int, convId)
          .input("SenderId", sql.Int, me)
          .input("Body", sql.NVarChar(sql.MAX), body)
          .input("BodyHash", sql.VarBinary(32), hash)
          .input("Signature", sql.VarBinary(sql.MAX), sig)
          .input("ClientTimestamp", sql.DateTime2, ct)
          .query(`
            INSERT INTO dbo.Messages(ConversationId, SenderId, Body, BodyHash, Signature, ClientTimestamp)
            OUTPUT INSERTED.Id, INSERTED.CreatedAt
            VALUES (@ConversationId, @SenderId, @Body, @BodyHash, @Signature, @ClientTimestamp)
          `);

        const inserted = saved.recordset[0];

        const out = {
          id: inserted.Id,
          conversationId: convId,
          senderId: me,
          body,
          clientTimestamp,
          nonce: nonce ?? "",
          createdAt: inserted.CreatedAt,
          signatureBase64,
          bodyHashHex: hash.toString("hex"),
        };

        io.to(`conv:${convId}`).emit("message:new", out);
        return ack?.({ ok: true, id: inserted.Id });
      } catch (e) {
        console.error("message:send error:", e);
        return ack?.({ ok: false, error: "Server error" });
      }
    });
  });
}
