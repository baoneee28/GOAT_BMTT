// src/App.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import { API_BASE, apiGet, apiPost } from "./api";
import {
  ensureClientKeyPair,
  buildMessagePayload,
  sha256Bytes,
  signHashRsaPss,
} from "./crypto";

function randomNonceHex(bytes = 8) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

export default function App() {
  const [mode, setMode] = useState("login"); // login | register | chat
  const [username, setUsername] = useState("alice");
  const [password, setPassword] = useState("123456");

  const [token, setToken] = useState("");
  const [me, setMe] = useState(null); // {id, username}

  const [conversations, setConversations] = useState([]);
  const [activeConvId, setActiveConvId] = useState(null);
  const [messages, setMessages] = useState([]);

  const [draft, setDraft] = useState("");
  const socketRef = useRef(null);
  const messagesEndRef = useRef(null);

  const authed = useMemo(() => Boolean(token && me), [token, me]);

  // Connect socket when authed
  useEffect(() => {
    if (!authed) return;

    const s = io(API_BASE, {
      auth: { token: "Bearer " + token },
      transports: ["websocket"], // demo ổn định
    });

    s.on("connect", () => console.log("socket connected", s.id));
    s.on("connect_error", (e) => console.log("socket error:", e.message));

    s.on("message:new", (m) => {
      // chỉ append nếu đúng conversation đang mở
      setMessages((prev) => {
        if (activeConvId && m.conversationId !== activeConvId) return prev;
        // chống duplicate đơn giản
        if (prev.some((x) => x.id === m.id)) return prev;
        return [...prev, m];
      });
    });

    socketRef.current = s;

    return () => {
      s.disconnect();
      socketRef.current = null;
    };
  }, [authed, token, activeConvId]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleRegister() {
    try {
      // 1) client tạo keypair và lấy publicKeyPem
      const { publicKeyPem } = await ensureClientKeyPair();

      // 2) register gửi publicKeyPem lên server
      const res = await apiPost("/api/auth/register", { username, password, publicKeyPem });
      alert("Register OK: " + JSON.stringify(res));
      setMode("login");
    } catch (e) {
      alert("Register failed: " + e.message);
    }
  }

  async function handleLogin() {
    try {
      const res = await apiPost("/api/auth/login", { username, password });
      setToken(res.token);
      setMe(res.user);
      setMode("chat");

      // load conversations
      const c = await apiGet("/api/conversations", res.token);
      setConversations(c.conversations || []);
    } catch (e) {
      alert("Login failed: " + e.message);
    }
  }

  async function refreshConversations() {
    const c = await apiGet("/api/conversations", token);
    setConversations(c.conversations || []);
  }

  async function openConversation(convId) {
    setActiveConvId(convId);

    // 1) load history
    const r = await apiGet(`/api/messages/${convId}?limit=50`, token);
    setMessages(r.messages || []);

    // 2) join socket room
    const s = socketRef.current;
    if (s) {
      s.emit("conversation:join", { conversationId: convId }, (ack) => {
        if (!ack?.ok) alert("Join failed: " + ack?.error);
      });
    }
  }

  async function sendMessage() {
    const s = socketRef.current;
    if (!s) return alert("Socket not connected");
    if (!activeConvId) return alert("Pick a conversation first");
    if (!draft.trim()) return;

    try {
      // 1) load private key từ localStorage (ensureClientKeyPair)
      const { privateKey } = await ensureClientKeyPair();

      // 2) build canonical payload (must match server)
      const clientTimestamp = Date.now();
      const nonce = randomNonceHex(8);

      const payloadBytes = buildMessagePayload({
        conversationId: activeConvId,
        senderId: me.id,
        body: draft,
        clientTimestamp,
        nonce,
      });

      // 3) hash + sign (RSA-PSS)
      const hash = await sha256Bytes(payloadBytes);
      const signatureBase64 = await signHashRsaPss(privateKey, hash);

      // 4) emit
      s.emit(
        "message:send",
        {
          conversationId: activeConvId,
          body: draft,
          clientTimestamp,
          nonce,
          signatureBase64,
        },
        (ack) => {
          if (!ack?.ok) alert("Send failed: " + ack?.error);
        }
      );

      setDraft("");
    } catch (e) {
      console.error(e);
      alert("Error sending message: " + e.message);
    }
  }

  // ===== UI RENDERING =====

  // AUTH VIEW
  if (mode !== "chat") {
    return (
      <div className="flex-center" style={{ minHeight: "100vh", background: "radial-gradient(circle at top right, #1e1b4b, #0f172a)" }}>
        <div className="glass-panel fade-in" style={{ width: "100%", maxWidth: 400, padding: 32 }}>
          <h2 style={{ marginTop: 0, marginBottom: 24, textAlign: "center", fontSize: "1.8rem" }}>
            {mode === "login" ? "Welcome Back" : "Create Account"}
          </h2>

          <div style={{ display: "grid", gap: 16 }}>
            <div>
              <label style={{ display: "block", marginBottom: 6, fontSize: "0.9rem", color: "var(--text-muted)" }}>Username</label>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Enter username"
              />
            </div>
            <div>
              <label style={{ display: "block", marginBottom: 6, fontSize: "0.9rem", color: "var(--text-muted)" }}>Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter password"
              />
            </div>

            <button
              onClick={mode === "login" ? handleLogin : handleRegister}
              style={{ padding: "0.8rem", marginTop: 8 }}
            >
              {mode === "login" ? "Login" : "Sign Up"}
            </button>

            <div style={{ textAlign: "center", marginTop: 12, fontSize: "0.9rem" }}>
              <span style={{ color: "var(--text-muted)" }}>
                {mode === "login" ? "Don't have an account? " : "Already have an account? "}
              </span>
              <button
                onClick={() => setMode(mode === "login" ? "register" : "login")}
                style={{ background: "none", color: "var(--accent)", padding: 0, width: "auto", display: "inline" }}
              >
                {mode === "login" ? "Register" : "Login"}
              </button>
            </div>
          </div>

          <div style={{ marginTop: 24, padding: 12, background: "rgba(0,0,0,0.2)", borderRadius: 8, fontSize: "0.8rem", color: "#64748b" }}>
            Demo Note: Private keys are stored in localStorage. In production, use a secure keystore.
          </div>
        </div>
      </div>
    );
  }

  // CHAT VIEW
  return (
    <div className="fade-in" style={{ display: "grid", gridTemplateColumns: "280px 1fr", height: "100vh", overflow: "hidden" }}>

      {/* Sidebar */}
      <div style={{
        background: "var(--bg-panel)",
        borderRight: "1px solid var(--glass-border)",
        display: "flex",
        flexDirection: "column"
      }}>
        <div style={{ padding: 20, borderBottom: "1px solid var(--glass-border)" }}>
          <div style={{ fontWeight: 700, fontSize: "1.2rem", marginBottom: 4 }}>GOAT Chat</div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: "0.9rem", color: "var(--success)" }}>● {me?.username}</div>
            <button
              onClick={refreshConversations}
              style={{ padding: "4px 8px", fontSize: "0.8rem", background: "var(--bg-element)" }}
              title="Refresh conversations"
            >
              ↻
            </button>
          </div>
        </div>

        <div style={{ padding: 12, overflowY: "auto", flex: 1 }}>
          <div style={{ fontSize: "0.8rem", textTransform: "uppercase", letterSpacing: 1, color: "var(--text-muted)", marginBottom: 12 }}>
            Conversations
          </div>
          <div style={{ display: "grid", gap: 6 }}>
            {conversations.map((c) => (
              <button
                key={c.Id}
                onClick={() => openConversation(c.Id)}
                style={{
                  textAlign: "left",
                  padding: "12px",
                  background: c.Id === activeConvId ? "var(--primary)" : "transparent",
                  color: c.Id === activeConvId ? "white" : "var(--text-muted)",
                  borderRadius: "var(--radius-md)",
                  border: "none",
                  width: "100%",
                }}
              >
                <div style={{ fontWeight: 600, color: c.Id === activeConvId ? "white" : "var(--text-main)" }}>
                  {c.Title || "Untitled Chat"}
                </div>
                <div style={{ fontSize: "0.75rem", opacity: 0.7, marginTop: 2 }}>ID: {c.Id}</div>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Main Chat Area */}
      <div style={{ display: "flex", flexDirection: "column", height: "100vh", position: "relative" }}>

        {/* Chat Header */}
        <div style={{
          padding: "16px 24px",
          borderBottom: "1px solid var(--glass-border)",
          background: "var(--glass)",
          backdropFilter: "blur(10px)",
          zIndex: 10
        }}>
          {activeConvId ? (
            <div style={{ fontWeight: 600 }}>Conversation #{activeConvId}</div>
          ) : (
            <div style={{ color: "var(--text-muted)" }}>Select a conversation</div>
          )}
        </div>

        {/* Messages List */}
        <div style={{
          flex: 1,
          overflowY: "auto",
          padding: 24,
          display: "flex",
          flexDirection: "column",
          gap: 12,
          scrollBehavior: "smooth"
        }}>
          {!activeConvId ? (
            <div className="flex-center" style={{ height: "100%", color: "var(--text-muted)", flexDirection: "column" }}>
              <div style={{ fontSize: "3rem", marginBottom: 16 }}>💬</div>
              <div>Select a conversation from the sidebar to start chatting</div>
            </div>
          ) : (
            messages.map((m) => {
              const isMe = (m.SenderId ?? m.senderId) === me.id;
              return (
                <div
                  key={m.Id ?? m.id}
                  style={{
                    alignSelf: isMe ? "flex-end" : "flex-start",
                    maxWidth: "70%",
                  }}
                >
                  <div style={{
                    background: isMe ? "var(--primary)" : "var(--bg-element)",
                    color: isMe ? "white" : "var(--text-main)",
                    padding: "10px 16px",
                    borderRadius: "16px",
                    borderBottomRightRadius: isMe ? 4 : 16,
                    borderBottomLeftRadius: isMe ? 16 : 4,
                    boxShadow: "var(--shadow-sm)"
                  }}>
                    {m.Body ?? m.body}
                  </div>
                  <div style={{
                    fontSize: "0.7rem",
                    color: "var(--text-muted)",
                    marginTop: 4,
                    textAlign: isMe ? "right" : "left",
                    padding: "0 4px"
                  }}>
                    {!isMe && <span>{m.SenderId ?? m.senderId} • </span>}
                    id: {m.Id ?? m.id}
                  </div>
                </div>
              );
            })
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input Area */}
        {activeConvId && (
          <div style={{
            padding: 20,
            background: "var(--bg-app)",
            borderTop: "1px solid var(--glass-border)"
          }}>
            <div style={{ display: "flex", gap: 12, maxWidth: 800, margin: "0 auto" }}>
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Type a message..."
                style={{
                  background: "var(--bg-element)",
                  border: "1px solid transparent",
                  padding: 12,
                  borderRadius: 24
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") sendMessage();
                }}
              />
              <button
                onClick={sendMessage}
                className="flex-center"
                style={{
                  borderRadius: "50%",
                  width: 48,
                  height: 48,
                  padding: 0,
                  flexShrink: 0
                }}
              >
                ➤
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
