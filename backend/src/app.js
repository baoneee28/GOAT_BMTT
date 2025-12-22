import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";

import { authRouter } from "./routes/auth.js";
import { convRouter } from "./routes/conversations.js";
import { msgRouter } from "./routes/messages.js";
import { initSocket } from "./realtime/socket.js";

const app = express();

// CORS cho REST API (demo: cho phép tất cả; nếu muốn đẹp hơn thì whitelist origin)
app.use(cors({ origin: true, credentials: true }));

app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => res.send("OK"));

app.use("/api/auth", authRouter);
app.use("/api/conversations", convRouter);
app.use("/api/messages", msgRouter);

const httpServer = createServer(app);

// CORS cho Socket.IO
const io = new SocketIOServer(httpServer, {
  cors: { origin: true, credentials: true },
});

initSocket(io);

const port = Number(process.env.PORT || 3000);

// Quan trọng: listen trên 0.0.0.0 để máy khác trong LAN truy cập được
httpServer.listen(port, "0.0.0.0", () => {
  console.log(`Server running on http://0.0.0.0:${port}`);
});
