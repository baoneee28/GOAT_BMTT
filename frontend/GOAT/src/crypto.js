// src/crypto.js

// ===== Helpers base64 <-> ArrayBuffer =====
function ab2b64(ab) {
  const bytes = new Uint8Array(ab);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64toab(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes.buffer;
}

function wrapPem(b64, label) {
  const lines = b64.match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----`;
}

// ===== RSA-PSS key generation =====
export async function generateRsaPssKeyPair() {
  return crypto.subtle.generateKey(
    {
      name: "RSA-PSS",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  );
}

// ===== Export PEM =====
export async function exportPublicKeyPem(publicKey) {
  const spki = await crypto.subtle.exportKey("spki", publicKey);
  return wrapPem(ab2b64(spki), "PUBLIC KEY");
}

export async function exportPrivateKeyPem(privateKey) {
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", privateKey);
  return wrapPem(ab2b64(pkcs8), "PRIVATE KEY");
}

// ===== Import PEM =====
function pemToDer(pem) {
  const b64 = pem.replace(
    /-----BEGIN [^-]+-----|-----END [^-]+-----|\s+/g,
    ""
  );
  return b64toab(b64);
}

export async function importPublicKeyPem(publicKeyPem) {
  return crypto.subtle.importKey(
    "spki",
    pemToDer(publicKeyPem),
    { name: "RSA-PSS", hash: "SHA-256" },
    true,
    ["verify"]
  );
}

export async function importPrivateKeyPem(privateKeyPem) {
  return crypto.subtle.importKey(
    "pkcs8",
    pemToDer(privateKeyPem),
    { name: "RSA-PSS", hash: "SHA-256" },
    true,
    ["sign"]
  );
}

// =====================================================
// 🔐 PER-USER KEY STORAGE (THE IMPORTANT FIX)
// =====================================================
function LS_PRIV(username) {
  return `user:${username}:private_key_pem`;
}

function LS_PUB(username) {
  return `user:${username}:public_key_pem`;
}

/**
 * Ensure RSA keypair for ONE specific username
 * - Each username has its OWN keypair
 */
export async function ensureClientKeyPair(username) {
  if (!username) throw new Error("username is required for keypair");

  const privPem = localStorage.getItem(LS_PRIV(username));
  const pubPem = localStorage.getItem(LS_PUB(username));

  // ✅ Already exists
  if (privPem && pubPem) {
    return {
      privateKey: await importPrivateKeyPem(privPem),
      publicKey: await importPublicKeyPem(pubPem),
      publicKeyPem: pubPem,
    };
  }

  // ❇️ Generate new
  const { privateKey, publicKey } = await generateRsaPssKeyPair();
  const publicKeyPem = await exportPublicKeyPem(publicKey);
  const privateKeyPem = await exportPrivateKeyPem(privateKey);

  localStorage.setItem(LS_PRIV(username), privateKeyPem);
  localStorage.setItem(LS_PUB(username), publicKeyPem);

  return { privateKey, publicKey, publicKeyPem };
}

// ===== Admin / Debug helpers =====
export function getUserPemFromLocalStorage(username) {
  if (!username) return { pub: "", priv: "" };
  return {
    pub: localStorage.getItem(LS_PUB(username)) || "",
    priv: localStorage.getItem(LS_PRIV(username)) || "",
  };
}

export function clearUserKeys(username) {
  if (!username) return;
  localStorage.removeItem(LS_PRIV(username));
  localStorage.removeItem(LS_PUB(username));
}

// =====================================================
// ✉️ MESSAGE SIGNING
// =====================================================
export function buildMessagePayload({
  conversationId,
  senderId,
  body,
  clientTimestamp,
  nonce,
}) {
  return new TextEncoder().encode(
    JSON.stringify({
      conversationId: Number(conversationId),
      senderId: Number(senderId),
      clientTimestamp: String(clientTimestamp),
      nonce: String(nonce),
      body: String(body),
    })
  );
}

export async function sha256Bytes(bytes) {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(hash);
}

export async function signHashRsaPss(privateKey, hashUint8) {
  const sig = await crypto.subtle.sign(
    { name: "RSA-PSS", saltLength: 32 },
    privateKey,
    hashUint8
  );
  return ab2b64(sig);
}
