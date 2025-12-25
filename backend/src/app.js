// src/app.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import https from "https";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Server as SocketIOServer } from "socket.io";

import { authRouter } from "./routes/auth.js";
import { convRouter } from "./routes/conversations.js";
import { msgRouter } from "./routes/messages.js";
import { adminRouter } from "./routes/admin.js";
import { initSocket } from "./realtime/socket.js";

const app = express();

// CORS (demo: cho phép tất cả; production nên whitelist)
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => res.send("OK"));

// ===== Load certs (relative to this file) =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Bạn đặt cert ở: backend/certs/key.pem & backend/certs/cert.pem
const keyPath = path.join(__dirname, "..", "certs", "key.pem");
const certPath = path.join(__dirname, "..", "certs", "cert.pem");

if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
  console.error("❌ Missing TLS cert files:");
  console.error(" -", keyPath);
  console.error(" -", certPath);
  console.error("👉 Hãy tạo/copy key.pem & cert.pem vào backend/certs/");
  process.exit(1);
}

const httpsServer = https.createServer(
  {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  },
  app
);

const io = new SocketIOServer(httpsServer, {
  cors: { origin: true, credentials: true },
});

// Make io available in routes (nếu routes cần emit)
app.use((req, res, next) => {
  req.io = io;
  next();
});

initSocket(io);

app.use("/api/auth", authRouter);
app.use("/api/conversations", convRouter);
app.use("/api/messages", msgRouter);
app.use("/api/admin", adminRouter);

const port = Number(process.env.PORT || 3000);

// Listen 0.0.0.0 để máy khác trong LAN vào được
httpsServer.listen(port, "0.0.0.0", () => {
  console.log(`✅ HTTPS Server running on https://0.0.0.0:${port}`);
});
