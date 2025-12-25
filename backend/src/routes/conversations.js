// src/routes/conversation.js
import express from "express";
import { poolPromise, sql } from "../db.js";
import { authRequired } from "../middleware/auth.js";

export const convRouter = express.Router();
convRouter.use(authRequired);

/**
 * POST /api/conversations
 * body: { title?: string, memberIds?: number[] }  // tự thêm mình vào
 */
convRouter.post("/", async (req, res) => {
  const { title, memberIds } = req.body || {};
  const me = req.user?.id;

  if (!me) return res.status(401).json({ error: "Unauthorized" });

  // sanitize memberIds -> int array
  const ids = Array.isArray(memberIds) ? memberIds : [];
  const cleanIds = ids
    .map((x) => Number(x))
    .filter((x) => Number.isInteger(x) && x > 0);

  // luôn add mình
  const members = Array.from(new Set([me, ...cleanIds]));

  const pool = await poolPromise;
  const tx = new sql.Transaction(pool);

  try {
    await tx.begin();

    // 1) create conversation
    const createRes = await new sql.Request(tx)
      .input("Title", sql.NVarChar(200), title ?? null)
      .query(`
        INSERT INTO dbo.Conversations(Title)
        OUTPUT INSERTED.Id, INSERTED.Title, INSERTED.CreatedAt
        VALUES (@Title)
      `);

    const conv = createRes.recordset[0];
    const convId = conv.Id;

    // 2) insert members (tránh duplicate PK)
    for (const uid of members) {
      await new sql.Request(tx)
        .input("ConversationId", sql.Int, convId)
        .input("UserId", sql.Int, uid)
        .query(`
          IF NOT EXISTS (
            SELECT 1 FROM dbo.ConversationMembers
            WHERE ConversationId=@ConversationId AND UserId=@UserId
          )
          INSERT INTO dbo.ConversationMembers(ConversationId, UserId)
          VALUES (@ConversationId, @UserId)
        `);
    }

    await tx.commit();

    // Notify all members about the new conversation
    members.forEach((uid) => {
      req.io?.to(`user:${uid}`).emit("conversation:added", conv);
    });

    return res.json({
      ok: true,
      conversation: conv,
      memberIds: members,
    });
  } catch (e) {
    try {
      await tx.rollback();
    } catch {}
    console.error("CREATE CONVERSATION ERROR:", e);
    return res.status(500).json({ error: "Server error", detail: e.message });
  }
});

/**
 * GET /api/conversations
 * list conv của user
 */
convRouter.get("/", async (req, res) => {
  const me = req.user?.id;
  if (!me) return res.status(401).json({ error: "Unauthorized" });

  const pool = await poolPromise;

  const r = await pool
    .request()
    .input("UserId", sql.Int, me)
    .query(`
      SELECT c.Id, c.Title, c.CreatedAt
      FROM dbo.Conversations c
      JOIN dbo.ConversationMembers m ON m.ConversationId = c.Id
      WHERE m.UserId = @UserId
      ORDER BY c.Id DESC
    `);

  res.json({ conversations: r.recordset });
});

/**
 * DELETE /api/conversations/:id
 * Chỉ cho phép member của conversation được xóa (demo).
 * (Nếu muốn chỉ owner/admin mới xóa thì mình chỉnh tiếp.)
 */
// DELETE /api/conversations/:id
// DELETE /api/conversations/:id
convRouter.delete("/:id", async (req, res) => {
  const me = req.user?.id;
  const convId = Number(req.params.id);

  if (!me) return res.status(401).json({ error: "Unauthorized" });
  if (!Number.isInteger(convId) || convId <= 0)
    return res.status(400).json({ error: "Invalid conversation id" });

  const pool = await poolPromise;
  const tx = new sql.Transaction(pool);

  try {
    await tx.begin();

    // check me là member
    const chk = await new sql.Request(tx)
      .input("ConversationId", sql.Int, convId)
      .input("UserId", sql.Int, me)
      .query(`
        SELECT 1 AS ok
        FROM dbo.ConversationMembers
        WHERE ConversationId=@ConversationId AND UserId=@UserId
      `);

    if (chk.recordset.length === 0) {
      await tx.rollback();
      return res.status(403).json({ error: "Forbidden" });
    }

    // 1) xóa messages (FK_M_Conv)
    await new sql.Request(tx)
      .input("ConversationId", sql.Int, convId)
      .query(`DELETE FROM dbo.Messages WHERE ConversationId=@ConversationId`);

    // 2) xóa members (FK_CM_Conv)
    await new sql.Request(tx)
      .input("ConversationId", sql.Int, convId)
      .query(`DELETE FROM dbo.ConversationMembers WHERE ConversationId=@ConversationId`);

    // 3) xóa conversation
    const del = await new sql.Request(tx)
      .input("ConversationId", sql.Int, convId)
      .query(`DELETE FROM dbo.Conversations WHERE Id=@ConversationId`);

    await tx.commit();

    const affected = del.rowsAffected?.[0] ?? 0;
    if (affected === 0) return res.status(404).json({ error: "Conversation not found" });

    return res.json({ ok: true, deletedConversationId: convId });
  } catch (e) {
    try { await tx.rollback(); } catch (_) {}
    console.error("DELETE CONVERSATION ERROR:", e);
    return res.status(500).json({ error: "Server error", detail: e.message });
  }
});



/**
 * (Optional) GET /api/conversations/:id/members
 * để FE gọi lấy danh sách member nếu cần
 */
convRouter.get("/:id/members", async (req, res) => {
  const me = req.user?.id;
  const convId = Number(req.params.id);

  if (!me) return res.status(401).json({ error: "Unauthorized" });
  if (!Number.isInteger(convId) || convId <= 0)
    return res.status(400).json({ error: "Invalid conversation id" });

  const pool = await poolPromise;

  // check user có trong convo không
  const chk = await pool
    .request()
    .input("ConversationId", sql.Int, convId)
    .input("UserId", sql.Int, me)
    .query(`
      SELECT 1 AS ok
      FROM dbo.ConversationMembers
      WHERE ConversationId=@ConversationId AND UserId=@UserId
    `);

  if (chk.recordset.length === 0)
    return res.status(403).json({ error: "Forbidden" });

  const r = await pool
    .request()
    .input("ConversationId", sql.Int, convId)
    .query(`
      SELECT u.Id, u.Username
      FROM dbo.ConversationMembers m
      JOIN dbo.Users u ON u.Id = m.UserId
      WHERE m.ConversationId=@ConversationId
      ORDER BY u.Id ASC
    `);

  return res.json({ members: r.recordset });
});

/**
 * POST /api/conversations/:id/members
 * Add a user to an existing conversation
 * body: { userId: number }
 */
convRouter.post("/:id/members", async (req, res) => {
  const me = req.user?.id;
  const convId = Number(req.params.id);
  const { userId } = req.body || {};

  if (!me) return res.status(401).json({ error: "Unauthorized" });
  if (!Number.isInteger(convId) || convId <= 0)
    return res.status(400).json({ error: "Invalid conversation id" });
  if (!userId || !Number.isInteger(Number(userId)))
    return res.status(400).json({ error: "Invalid userId to add" });

  const targetUserId = Number(userId);
  const pool = await poolPromise;

  try {
    // 1) Check if requester is a member of the conversation
    const chk = await pool
      .request()
      .input("ConversationId", sql.Int, convId)
      .input("UserId", sql.Int, me)
      .query(`
        SELECT 1 
        FROM dbo.ConversationMembers 
        WHERE ConversationId=@ConversationId AND UserId=@UserId
      `);

    if (chk.recordset.length === 0)
      return res.status(403).json({ error: "You are not a member of this conversation" });

    // 2) Check if target user exists
    const userChk = await pool
      .request()
      .input("UserId", sql.Int, targetUserId)
      .query(`SELECT 1 FROM dbo.Users WHERE Id=@UserId`);
    
    if (userChk.recordset.length === 0)
      return res.status(404).json({ error: "User to add not found" });

    // 3) Add member (ignore if already exists)
    await pool
      .request()
      .input("ConversationId", sql.Int, convId)
      .input("UserId", sql.Int, targetUserId)
      .query(`
        IF NOT EXISTS (
          SELECT 1 FROM dbo.ConversationMembers
          WHERE ConversationId=@ConversationId AND UserId=@UserId
        )
        INSERT INTO dbo.ConversationMembers(ConversationId, UserId)
        VALUES (@ConversationId, @UserId)
      `);

    // 4) Notify the added user (Realtime)
    const convInfo = await pool
      .request()
      .input("Id", sql.Int, convId)
      .query("SELECT Id, Title, CreatedAt FROM dbo.Conversations WHERE Id=@Id");

    if (convInfo.recordset.length > 0) {
      const c = convInfo.recordset[0];
      req.io?.to(`user:${targetUserId}`).emit("conversation:added", c);
    }

    return res.json({ ok: true, message: "Member added" });
  } catch (e) {
    console.error("ADD MEMBER ERROR:", e);
    return res.status(500).json({ error: "Server error", detail: e.message });
  }
});
