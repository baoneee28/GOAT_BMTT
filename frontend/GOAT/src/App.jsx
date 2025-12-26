import React, { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import { API_BASE, apiGet, apiPost, apiDelete } from "./api";
import {
  ensureClientKeyPair,
  buildMessagePayload,
  sha256Bytes,
  signHashRsaPss,
  getUserPemFromLocalStorage
} from "./crypto";

function genNonceBase64() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // base64
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export default function App() {
  const [mode, setMode] = useState("login"); // login | register | chat | admin
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

  // ===== ADMIN STATE =====
  const [adminUsers, setAdminUsers] = useState([]);
  const [adminError, setAdminError] = useState("");
  const [selectedUser, setSelectedUser] = useState(null);

  const authed = useMemo(() => Boolean(token && me), [token, me]);

  // Connect socket when authed (only once per token)
  useEffect(() => {
    if (!authed) return;

    const s = io(API_BASE, {
      auth: { token: "Bearer " + token },
      transports: ["websocket"],
    });

    s.on("connect", () => console.log("socket connected", s.id));
    s.on("connect_error", (e) => console.log("socket error:", e.message));

    s.on("message:new", (m) => {
      setMessages((prev) => {
        if (activeConvId && m.conversationId !== activeConvId) return prev;

        const mid = m.Id ?? m.id;
        if (prev.some((x) => (x.Id ?? x.id) === mid)) return prev;

        return [...prev, m];
      });
    });

    s.on("conversation:added", (newConv) => {
      setConversations((prev) => {
        if (prev.some((c) => c.Id === newConv.Id)) return prev;
        return [newConv, ...prev];
      });
    });

    socketRef.current = s;

    return () => {
      s.disconnect();
      socketRef.current = null;
    };
  }, [authed, token]); // ✅ no activeConvId

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleRegister() {
    try {
      const { publicKeyPem } = await ensureClientKeyPair(username.trim());
      const res = await apiPost("/api/auth/register", {
        username,
        password,
        publicKeyPem,
      });
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

    const r = await apiGet(`/api/messages/${convId}?limit=50`, token);
    setMessages(r.messages || []);

    const s = socketRef.current;
    if (s) {
      s.emit("conversation:join", { conversationId: convId }, (ack) => {
        if (!ack?.ok) alert("Join failed: " + ack?.error);
      });
    }
  }

  async function deleteConversation(convId) {
    const ok = confirm(`Xóa cuộc trò chuyện #${convId}?`);
    if (!ok) return;

    try {
      await apiDelete(`/api/conversations/${convId}`, token);

      // refresh list
      const c = await apiGet("/api/conversations", token);
      setConversations(c.conversations || []);

      // clear UI nếu đang mở đúng convo đó
      if (activeConvId === convId) {
        setActiveConvId(null);
        setMessages([]);
      }
    } catch (e) {
      alert("Delete conversation failed: " + e.message);
    }
  }

  async function deleteSelectedUser() {
    if (!selectedUser) return;

    const ok = confirm(
      `Xóa user ${selectedUser.Username} (ID=${selectedUser.Id})?`
    );
    if (!ok) return;

    try {
      await apiDelete(`/api/admin/users/${selectedUser.Id}`, token);
      await openAdmin(); // reload danh sách
    } catch (e) {
      alert("Delete user failed: " + e.message);
    }
  }
  async function createConversation() {
    try {
      const title = prompt("Tên cuộc trò chuyện (có thể để trống):") || "";
      const idsRaw =
        prompt("Nhập ID thành viên (vd: 2,3). Bạn sẽ tự được add vào:") || "";
      const memberIds = idsRaw
        .split(",")
        .map((x) => Number(x.trim()))
        .filter((x) => Number.isInteger(x) && x > 0);

      const r = await apiPost(
        "/api/conversations",
        { title, memberIds },
        token
      );

      const c = await apiGet("/api/conversations", token);
      setConversations(c.conversations || []);

      const newId = r?.conversation?.Id || r?.conversationId;
      if (newId) openConversation(newId);
    } catch (e) {
      alert("Create conversation failed: " + e.message);
    }
  }

  async function sendMessage() {
    const s = socketRef.current;
    if (!s) return alert("Socket not connected");
    if (!activeConvId) return alert("Pick a conversation first");
    if (!draft.trim()) return;

    try {
      const { privateKey } = await ensureClientKeyPair(me?.username);

      const clientTimestamp = new Date().toISOString();
      // 16 bytes random -> base64
      const nonce = genNonceBase64();

      const payloadBytes = buildMessagePayload({
        conversationId: activeConvId,
        body: draft,
        clientTimestamp,
        nonce,
      });

      // [UPDATE] Sign directly on payloadBytes (crypto.subtle.sign will hash it)
      // const hash = await sha256Bytes(payloadBytes); 
      const signatureBase64 = await signHashRsaPss(privateKey, payloadBytes);

      s.emit(
        "message:send",
        {
          conversationId: activeConvId,
          body: draft,
          clientTimestamp,
          nonceBase64: nonce, // gửi lên server với key nonceBase64 cho rõ
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

  async function handleCreateConversation() {
    const title = window.prompt("Conversation title?", "New chat");
    if (title === null) return;

    try {
      const r = await apiPost(
        "/api/conversations",
        { title, memberIds: [] },
        token
      );
      await refreshConversations();
      if (r?.conversationId) {
        await openConversation(r.conversationId);
      }
    } catch (e) {
      alert("Create conversation failed: " + e.message);
    }
  }

  async function handleDeleteConversation(convId) {
    if (!window.confirm(`Delete conversation #${convId}?`)) return;

    try {
      await apiDelete(`/api/conversations/${convId}`, token);

      // nếu đang mở convo bị xóa thì reset
      if (activeConvId === convId) {
        setActiveConvId(null);
        setMessages([]);
      }

      await refreshConversations();
    } catch (e) {
      alert("Delete failed: " + e.message);
    }
  }

  async function handleAddMember() {
    if (!activeConvId) return;
    const uidStr = prompt("Enter User ID to add:");
    if (!uidStr) return;

    const userId = Number(uidStr);
    if (!Number.isInteger(userId)) return alert("Invalid User ID");

    try {
      await apiPost(`/api/conversations/${activeConvId}/members`, { userId }, token);
      alert("Member added!");
    } catch (e) {
      alert("Add member failed: " + e.message);
    }
  }

  // ===== ADMIN FUNCTIONS =====
  async function openAdmin() {
    setMode("admin");
    setAdminError("");
    setAdminUsers([]);
    setSelectedUser(null);

    try {
      const r = await apiGet("/api/admin/users", token);
      setAdminUsers(r.users || []);
      if (r.users?.length) setSelectedUser(r.users[0]);
    } catch (e) {
      setAdminError(e.message);
    }
  }

  function currentBrowserKeys() {
    const pub = localStorage.getItem("demo_public_key_pem") || "";
    const priv = localStorage.getItem("demo_private_key_pem") || "";
    return { pub, priv };
  }

  // ===== UI RENDERING =====

  // AUTH VIEW
  if (mode !== "chat" && mode !== "admin") {
    return (
      <div
        className="flex-center"
        style={{
          minHeight: "100vh",
          background: "radial-gradient(circle at top right, #1e1b4b, #0f172a)",
        }}
      >
        <div
          className="glass-panel fade-in"
          style={{ width: "100%", maxWidth: 400, padding: 32 }}
        >
          <h2
            style={{
              marginTop: 0,
              marginBottom: 24,
              textAlign: "center",
              fontSize: "1.8rem",
            }}
          >
            {mode === "login" ? "Welcome Back" : "Create Account"}
          </h2>

          <div style={{ display: "grid", gap: 16 }}>
            <div>
              <label
                style={{
                  display: "block",
                  marginBottom: 6,
                  fontSize: "0.9rem",
                  color: "var(--text-muted)",
                }}
              >
                Username
              </label>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Enter username"
              />
            </div>
            <div>
              <label
                style={{
                  display: "block",
                  marginBottom: 6,
                  fontSize: "0.9rem",
                  color: "var(--text-muted)",
                }}
              >
                Password
              </label>
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

            <div
              style={{ textAlign: "center", marginTop: 12, fontSize: "0.9rem" }}
            >
              <span style={{ color: "var(--text-muted)" }}>
                {mode === "login"
                  ? "Don't have an account? "
                  : "Already have an account? "}
              </span>
              <button
                onClick={() => setMode(mode === "login" ? "register" : "login")}
                style={{
                  background: "none",
                  color: "var(--accent)",
                  padding: 0,
                  width: "auto",
                  display: "inline",
                }}
              >
                {mode === "login" ? "Register" : "Login"}
              </button>
            </div>
          </div>

          <div
            style={{
              marginTop: 24,
              padding: 12,
              background: "rgba(0,0,0,0.2)",
              borderRadius: 8,
              fontSize: "0.8rem",
              color: "#64748b",
            }}
          >
            Demo Note: Private keys are stored in localStorage. In production,
            use a secure keystore.
          </div>
        </div>
      </div>
    );
  }

  // ADMIN VIEW
  if (mode === "admin") {
    const { pub, priv } = getUserPemFromLocalStorage(me?.username);

    return (
      <div
        className="fade-in"
        style={{
          display: "grid",
          gridTemplateColumns: "320px 1fr",
          height: "100vh",
          overflow: "hidden",
        }}
      >

        {/* Left panel */}
        <div
          style={{
            background: "var(--bg-panel)",
            borderRight: "1px solid var(--glass-border)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              padding: 16,
              borderBottom: "1px solid var(--glass-border)",
            }}
          >
            <div style={{ fontWeight: 800, fontSize: "1.1rem" }}>
              Admin Panel
            </div>
            <div
              style={{
                marginTop: 6,
                color: "var(--text-muted)",
                fontSize: "0.9rem",
              }}
            >
              Logged in:{" "}
              <span style={{ color: "var(--success)" }}>{me?.username}</span>
            </div>

            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button
                onClick={() => setMode("chat")}
                style={{ padding: "6px 10px", background: "var(--bg-element)" }}
              >
                ← Back to Chat
              </button>
              <button
                onClick={openAdmin}
                style={{ padding: "6px 10px", background: "var(--bg-element)" }}
                title="Reload"
              >
                ↻ Reload
              </button>
              <button
                onClick={createConversation}
                style={{
                  padding: "4px 8px",
                  fontSize: "0.8rem",
                  background: "var(--bg-element)",
                }}
                title="Create conversation"
              >
                ＋
              </button>
            </div>

            {adminError && (
              <div
                style={{
                  marginTop: 12,
                  padding: 10,
                  background: "rgba(239,68,68,0.12)",
                  border: "1px solid rgba(239,68,68,0.25)",
                  borderRadius: 10,
                }}
              >
                <div style={{ fontWeight: 700, marginBottom: 4 }}>Error</div>
                <div style={{ color: "var(--text-muted)", fontSize: "0.9rem" }}>
                  {adminError}
                </div>
                <div
                  style={{
                    color: "var(--text-muted)",
                    fontSize: "0.85rem",
                    marginTop: 6,
                  }}
                >
                  Tip: set <code>ADMIN_USERNAME</code> or <code>ADMIN_ID</code>{" "}
                  in backend .env
                </div>
              </div>
            )}
          </div>

          <div style={{ padding: 12, overflowY: "auto", flex: 1 }}>
            <div
              style={{
                fontSize: "0.8rem",
                textTransform: "uppercase",
                letterSpacing: 1,
                color: "var(--text-muted)",
                marginBottom: 12,
              }}
            >
              Users ({adminUsers.length})
            </div>

            <div style={{ display: "grid", gap: 6 }}>
              {adminUsers.map((u) => (
                <div
                  key={u.Id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: 12,
                    borderRadius: "var(--radius-md)",
                    background:
                      selectedUser?.Id === u.Id
                        ? "var(--primary)"
                        : "transparent",
                    cursor: "pointer",
                  }}
                  onClick={() => setSelectedUser(u)}
                >
                  {/* LEFT: User info */}
                  <div>
                    <div
                      style={{
                        fontWeight: 700,
                        color:
                          selectedUser?.Id === u.Id
                            ? "white"
                            : "var(--text-main)",
                      }}
                    >
                      {u.Username}
                    </div>
                    <div style={{ fontSize: "0.75rem", opacity: 0.75 }}>
                      ID: {u.Id}
                    </div>
                  </div>

                  {/* RIGHT: Delete button */}
                  <button
                    onClick={async (e) => {
                      e.stopPropagation(); // ❗ CỰC KỲ QUAN TRỌNG
                      if (!window.confirm(`Delete user "${u.Username}" ?`))
                        return;

                      try {
                        await apiDelete(`/api/admin/users/${u.Id}`, token);
                        alert("User deleted");

                        // reload list
                        openAdmin();
                      } catch (err) {
                        alert("Delete failed: " + err.message);
                      }
                    }}
                    style={{
                      background: "rgba(239,68,68,0.15)",
                      color: "#ef4444",
                      border: "none",
                      borderRadius: 8,
                      padding: "4px 8px",
                      fontSize: "0.75rem",
                      cursor: "pointer",
                    }}
                    title="Delete user"
                  >
                    🗑
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right panel */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            height: "100vh",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "16px 20px",
              borderBottom: "1px solid var(--glass-border)",
              background: "var(--glass)",
              backdropFilter: "blur(10px)",
            }}
          >
            <div style={{ fontWeight: 800 }}>
              Registration / Crypto Info (Demo)
            </div>
            <div
              style={{
                color: "var(--text-muted)",
                fontSize: "0.9rem",
                marginTop: 4,
              }}
            >
              Salt + PBKDF2 hash are stored on server. Public key stored on
              server. Private key stays on client.
            </div>
          </div>

          <div
            style={{
              flex: 1,
              overflowY: "auto",
              padding: 20,
              display: "grid",
              gap: 16,
            }}
          >
            {/* Current browser keys */}
            <div
              style={{
                padding: 16,
                borderRadius: 14,
                background: "var(--bg-element)",
                border: "1px solid var(--glass-border)",
              }}
            >
              <div style={{ fontWeight: 800, marginBottom: 10 }}>
                Current Browser Keys (localStorage)
              </div>
              <div
                style={{
                  fontSize: "0.85rem",
                  color: "var(--text-muted)",
                  marginBottom: 8,
                }}
              >
                These belong to the current device/browser only.
              </div>

              <div style={{ display: "grid", gap: 10 }}>
                <div>
                  <div style={{ fontWeight: 700, marginBottom: 6 }}>
                    Public Key (PEM)
                  </div>
                  <pre
                    style={{
                      whiteSpace: "pre-wrap",
                      overflowWrap: "anywhere",
                      margin: 0,
                      padding: 12,
                      borderRadius: 12,
                      background: "rgba(0,0,0,0.2)",
                    }}
                  >
                    {pub || "(none)"}
                  </pre>
                </div>
                <div>
                  <div style={{ fontWeight: 700, marginBottom: 6 }}>
                    Private Key (PEM)
                  </div>
                  <pre
                    style={{
                      whiteSpace: "pre-wrap",
                      overflowWrap: "anywhere",
                      margin: 0,
                      padding: 12,
                      borderRadius: 12,
                      background: "rgba(0,0,0,0.2)",
                    }}
                  >
                    {priv || "(none)"}
                  </pre>
                </div>
              </div>
            </div>

            {/* Selected user server-stored values */}
            <div
              style={{
                padding: 16,
                borderRadius: 14,
                background: "var(--bg-element)",
                border: "1px solid var(--glass-border)",
              }}
            >
              <div style={{ fontWeight: 800, marginBottom: 10 }}>
                Selected User (Server Stored)
              </div>
              {selectedUser && (
                <button
                  onClick={deleteSelectedUser}
                  style={{
                    marginBottom: 16,
                    padding: "8px 14px",
                    background: "rgba(239,68,68,0.2)",
                    border: "1px solid rgba(239,68,68,0.4)",
                    borderRadius: 10,
                    color: "white",
                    fontWeight: 700,
                    cursor: "pointer",
                    width: "fit-content",
                  }}
                >
                  ❌ Delete user
                </button>
              )}

              {!selectedUser ? (
                <div style={{ color: "var(--text-muted)" }}>
                  Select a user from the left.
                </div>
              ) : (
                <div style={{ display: "grid", gap: 10 }}>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "140px 1fr",
                      gap: 10,
                    }}
                  >
                    <div style={{ color: "var(--text-muted)" }}>Id</div>
                    <div style={{ fontWeight: 700 }}>{selectedUser.Id}</div>

                    <div style={{ color: "var(--text-muted)" }}>Username</div>
                    <div style={{ fontWeight: 700 }}>
                      {selectedUser.Username}
                    </div>

                    <div style={{ color: "var(--text-muted)" }}>Iterations</div>
                    <div style={{ fontWeight: 700 }}>
                      {selectedUser.Iterations}
                    </div>

                    <div style={{ color: "var(--text-muted)" }}>Salt (hex)</div>
                    <div
                      style={{
                        fontFamily: "monospace",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {selectedUser.SaltHex}
                    </div>

                    <div style={{ color: "var(--text-muted)" }}>
                      PasswordHash (hex)
                    </div>
                    <div
                      style={{
                        fontFamily: "monospace",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {selectedUser.PasswordHashHex}
                    </div>

                    <div style={{ color: "var(--text-muted)" }}>CreatedAt</div>
                    <div style={{ fontFamily: "monospace" }}>
                      {String(selectedUser.CreatedAt)}
                    </div>
                  </div>

                  <div>
                    <div
                      style={{ color: "var(--text-muted)", marginBottom: 6 }}
                    >
                      PublicKeyPem
                    </div>
                    <pre
                      style={{
                        whiteSpace: "pre-wrap",
                        overflowWrap: "anywhere",
                        margin: 0,
                        padding: 12,
                        borderRadius: 12,
                        background: "rgba(0,0,0,0.2)",
                      }}
                    >
                      {selectedUser.PublicKeyPem || "(none)"}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // CHAT VIEW
  return (
    <div
      className="fade-in"
      style={{
        display: "grid",
        gridTemplateColumns: "280px 1fr",
        height: "100vh",
        overflow: "hidden",
      }}
    >
      {/* Sidebar */}
      <div
        style={{
          background: "var(--bg-panel)",
          borderRight: "1px solid var(--glass-border)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{ padding: 20, borderBottom: "1px solid var(--glass-border)" }}
        >
          <div style={{ fontWeight: 700, fontSize: "1.2rem", marginBottom: 4 }}>
            GOAT Chat
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 8,
            }}
          >
            <div style={{ fontSize: "0.9rem", color: "var(--success)" }}>
              ● {me?.username}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={refreshConversations}
                style={{
                  padding: "4px 8px",
                  fontSize: "0.8rem",
                  background: "var(--bg-element)",
                }}
                title="Refresh conversations"
              >
                ↻
              </button>
              <button
                onClick={openAdmin}
                style={{
                  padding: "4px 8px",
                  fontSize: "0.8rem",
                  background: "var(--bg-element)",
                }}
                title="Open admin"
              >
                Admin
              </button>
            </div>
          </div>
        </div>

        <div style={{ padding: 12, overflowY: "auto", flex: 1 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 12,
            }}
          >
            <div
              style={{
                fontSize: "0.8rem",
                textTransform: "uppercase",
                letterSpacing: 1,
                color: "var(--text-muted)",
              }}
            >
              Conversations
            </div>

            <button
              onClick={handleCreateConversation}
              style={{
                padding: "4px 8px",
                fontSize: "0.8rem",
                background: "var(--bg-element)",
              }}
              title="Create conversation"
            >
              ➕
            </button>
          </div>

          <div style={{ display: "grid", gap: 6 }}>
            {conversations.map((c) => (
              <div
                key={c.Id}
                onClick={() => openConversation(c.Id)}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  textAlign: "left",
                  padding: "12px",
                  background:
                    c.Id === activeConvId ? "var(--primary)" : "transparent",
                  color: c.Id === activeConvId ? "white" : "var(--text-muted)",
                  borderRadius: "var(--radius-md)",
                  border: "none",
                  width: "100%",
                  cursor: "pointer",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontWeight: 600,
                      color:
                        c.Id === activeConvId ? "white" : "var(--text-main)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {c.Title || "Untitled Chat"}
                  </div>
                  <div
                    style={{ fontSize: "0.75rem", opacity: 0.7, marginTop: 2 }}
                  >
                    ID: {c.Id}
                  </div>
                </div>

                <button
                  onClick={(e) => {
                    e.stopPropagation(); // ❗ để không bị mở conversation khi bấm xóa
                    handleDeleteConversation(c.Id);
                  }}
                  style={{
                    background: "rgba(239,68,68,0.15)",
                    color: "#ef4444",
                    border: "none",
                    borderRadius: 8,
                    padding: "4px 8px",
                    fontSize: "0.75rem",
                    cursor: "pointer",
                    flexShrink: 0,
                  }}
                  title="Delete conversation"
                >
                  🗑
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Main Chat Area */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100vh",
          position: "relative",
        }}
      >
        {/* Chat Header */}
        <div
          style={{
            padding: "16px 24px",
            borderBottom: "1px solid var(--glass-border)",
            background: "var(--glass)",
            backdropFilter: "blur(10px)",
            zIndex: 10,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center"
          }}
        >
          {activeConvId ? (
            <>
              <div style={{ fontWeight: 600 }}>Conversation #{activeConvId}</div>
              <button
                onClick={handleAddMember}
                style={{
                  padding: "6px 12px",
                  fontSize: "0.8rem",
                  background: "var(--bg-element)",
                  borderRadius: "6px",
                  cursor: "pointer",
                  border: "1px solid var(--glass-border)"
                }}
              >
                + Add Member
              </button>
            </>
          ) : (
            <div style={{ color: "var(--text-muted)" }}>
              Select a conversation
            </div>
          )}
        </div>

        {/* Messages List */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: 24,
            display: "flex",
            flexDirection: "column",
            gap: 12,
            scrollBehavior: "smooth",
          }}
        >
          {!activeConvId ? (
            <div
              className="flex-center"
              style={{
                height: "100%",
                color: "var(--text-muted)",
                flexDirection: "column",
              }}
            >
              <div style={{ fontSize: "3rem", marginBottom: 16 }}>💬</div>
              <div>
                Select a conversation from the sidebar to start chatting
              </div>
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
                  <div
                    style={{
                      background: isMe ? "var(--primary)" : "var(--bg-element)",
                      color: isMe ? "white" : "var(--text-main)",
                      padding: "10px 16px",
                      borderRadius: "16px",
                      borderBottomRightRadius: isMe ? 4 : 16,
                      borderBottomLeftRadius: isMe ? 16 : 4,
                      boxShadow: "var(--shadow-sm)",
                    }}
                  >
                    {m.Body ?? m.body}
                  </div>
                  <div
                    style={{
                      fontSize: "0.7rem",
                      color: "var(--text-muted)",
                      marginTop: 4,
                      textAlign: isMe ? "right" : "left",
                      padding: "0 4px",
                    }}
                  >
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
          <div
            style={{
              padding: 20,
              background: "var(--bg-app)",
              borderTop: "1px solid var(--glass-border)",
            }}
          >
            <div
              style={{
                display: "flex",
                gap: 12,
                maxWidth: 800,
                margin: "0 auto",
              }}
            >
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Type a message..."
                style={{
                  background: "var(--bg-element)",
                  border: "1px solid transparent",
                  padding: 12,
                  borderRadius: 24,
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
                  flexShrink: 0,
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
