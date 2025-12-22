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
    // Optional: log connect
    // console.log("socket connected:", socket.user?.id);

    // 2) Join conversation room (must be member)
    socket.on("conversation:join", async ({ conversationId }, ack) => {
      try {
        const convId = Number(conversationId);
        if (!convId) return ack?.({ ok: false, error: "Missing conversationId" });

        const me = socket.user.id;
        const pool = await poolPromise;

        const mem = await pool.request()
          .input("ConversationId", sql.Int, convId)
          .input("UserId", sql.Int, me)
          .query(`SELECT 1 FROM dbo.ConversationMembers WHERE ConversationId=@ConversationId AND UserId=@UserId`);

        if (mem.recordset.length === 0) return ack?.({ ok: false, error: "Not a member" });

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
        const { conversationId, body, clientTimestamp, signatureBase64, nonce } = msg || {};

        const convId = Number(conversationId);
        if (!convId || typeof body !== "string" || !signatureBase64) {
          return ack?.({ ok: false, error: "Invalid payload" });
        }

        // Validate clientTimestamp -> DateTime2 or null
        const ct = clientTimestamp ? new Date(clientTimestamp) : null;
        const ctVal = ct && !isNaN(ct.getTime()) ? ct : null;

        const pool = await poolPromise;

        // 1) Authorization: must be member
        const mem = await pool.request()
          .input("ConversationId", sql.Int, convId)
          .input("UserId", sql.Int, me)
          .query(`SELECT 1 FROM dbo.ConversationMembers WHERE ConversationId=@ConversationId AND UserId=@UserId`);

        if (mem.recordset.length === 0) return ack?.({ ok: false, error: "Not a member" });

        // 2) Load public key of current authenticated user
        const u = await pool.request()
          .input("UserId", sql.Int, me)
          .query(`SELECT PublicKeyPem FROM dbo.Users WHERE Id=@UserId`);

        if (u.recordset.length === 0) return ack?.({ ok: false, error: "Sender not found" });

        const publicKeyPem = u.recordset[0].PublicKeyPem;
        console.log("KEY FIRST LINE:", String(publicKeyPem).replace(/\\n/g, "\n").split("\n")[0]);
        const normalized = String(publicKeyPem).replace(/\\n/g, "\n").trim();
        const lines = normalized.split("\n");
        console.log("KEY lines:", lines.length);
        console.log("KEY last line:", lines[lines.length - 1]);
        console.log("KEY sample line2:", lines[1]?.slice(0, 30));



        // 3) Build canonical payload -> hash
        const payload = buildMessagePayload({
          conversationId: convId,
          senderId: me,
          body,
          clientTimestamp,
          nonce,
        });
        const hash = sha256(payload);

        // 4) Verify signature RSA-PSS
        const sig = Buffer.from(signatureBase64, "base64");
        const ok = verifySignaturePSS({ publicKeyPem, hashBuffer: hash, signatureBuffer: sig });
        if (!ok) return ack?.({ ok: false, error: "Signature verify failed" });

        // 5) Save DB (senderId must be me)
        const saved = await pool.request()
          .input("ConversationId", sql.Int, convId)
          .input("SenderId", sql.Int, me)
          .input("Body", sql.NVarChar(sql.MAX), body)
          .input("BodyHash", sql.VarBinary(32), hash)
          .input("Signature", sql.VarBinary(sql.MAX), sig)
          .input("ClientTimestamp", sql.DateTime2, ctVal)
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
