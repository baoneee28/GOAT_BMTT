// src/routes/admin.js
import express from "express";
import { poolPromise, sql } from "../db.js";
import { authRequired } from "../middleware/auth.js";
import { adminRequired } from "../middleware/admin.js";

export const adminRouter = express.Router();

adminRouter.use(authRequired);
adminRouter.use(adminRequired);

/**
 * GET /api/admin/users
 * Trả về danh sách users (demo)
 */
adminRouter.get("/users", async (req, res) => {
  const pool = await poolPromise;

  const r = await pool.request().query(`
    SELECT
      Id,
      Username,
      Iterations,
      CONVERT(VARCHAR(64), Salt, 2) AS SaltHex,
      CONVERT(VARCHAR(64), PasswordHash, 2) AS PasswordHashHex,
      PublicKeyPem,
      CreatedAt
    FROM dbo.Users
    ORDER BY Id DESC
  `);

  return res.json({ users: r.recordset });
});

// DELETE /api/admin/users/:id
adminRouter.delete("/users/:id", async (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: "Invalid user id" });
  }

  const pool = await poolPromise;
  const tx = new sql.Transaction(pool);

  try {
    await tx.begin();

    // 0) Lấy các conversation mà user đang tham gia (để dọn convo rỗng)
    const convs = await new sql.Request(tx)
      .input("UserId", sql.Int, userId)
      .query(`
        SELECT ConversationId
        FROM dbo.ConversationMembers
        WHERE UserId = @UserId
      `);

    // 1) Xóa UserDevices (FK_UserDevices_Users) - NEW FIX
    await new sql.Request(tx)
      .input("UserId", sql.Int, userId)
      .query(`DELETE FROM dbo.UserDevices WHERE UserId = @UserId`);

    // 2) Xóa messages do user gửi (FK_M_Sender)
    await new sql.Request(tx)
      .input("UserId", sql.Int, userId)
      .query(`DELETE FROM dbo.Messages WHERE SenderId = @UserId`);

    // 3) Xóa membership (FK_CM_User)
    await new sql.Request(tx)
      .input("UserId", sql.Int, userId)
      .query(`DELETE FROM dbo.ConversationMembers WHERE UserId = @UserId`);

    // 4) Dọn conversation rỗng (không còn member)
    for (const row of convs.recordset) {
      const cid = row.ConversationId;

      const cnt = await new sql.Request(tx)
        .input("ConversationId", sql.Int, cid)
        .query(`
          SELECT COUNT(*) AS Cnt
          FROM dbo.ConversationMembers
          WHERE ConversationId=@ConversationId
        `);

      if ((cnt.recordset?.[0]?.Cnt ?? 0) === 0) {
        // phải xóa messages theo conversation trước (FK_M_Conv)
        await new sql.Request(tx)
          .input("ConversationId", sql.Int, cid)
          .query(`DELETE FROM dbo.Messages WHERE ConversationId=@ConversationId`);

        await new sql.Request(tx)
          .input("ConversationId", sql.Int, cid)
          .query(`DELETE FROM dbo.Conversations WHERE Id=@ConversationId`);
      }
    }

    // 5) Cuối cùng xóa user
    const delUser = await new sql.Request(tx)
      .input("UserId", sql.Int, userId)
      .query(`DELETE FROM dbo.Users WHERE Id=@UserId`);

    await tx.commit();

    const affected = delUser.rowsAffected?.[0] ?? 0;
    if (affected === 0) return res.status(404).json({ error: "User not found" });

    return res.json({ ok: true, deletedUserId: userId });
  } catch (e) {
    try { await tx.rollback(); } catch (_) {}
    console.error("ADMIN DELETE USER ERROR:", e);
    return res.status(500).json({ error: "Server error", detail: e.message });
  }
});
