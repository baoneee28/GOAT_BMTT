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

// Helper: Get or Generate Device ID (UUID-like)
export function getOrGenDeviceId() {
  let did = localStorage.getItem("device_id");
  if (!did) {
    did = crypto.randomUUID();
    localStorage.setItem("device_id", did);
  }
  return did;
}

function LS_PRIV(username, deviceId) {
  return `priv:${username}:${deviceId}`;
}

// Ensure keypair for (username, deviceId)
export async function ensureClientKeyPair(username) {
  if (!username) throw new Error("username is required for keypair");

  const deviceId = getOrGenDeviceId();
  const privKeyName = LS_PRIV(username, deviceId);
  
  // We don't necessarily NEED to store public key in LS for logic, but good for debug
  // We only return privateKey object for signing
  
  const privPem = localStorage.getItem(privKeyName);
  const pubPemStored = localStorage.getItem(`pub:${username}:${deviceId}`);

  if (privPem && pubPemStored) {
    try {
      const privateKey = await importPrivateKeyPem(privPem);
      return { privateKey, publicKeyPem: pubPemStored, deviceId };
    } catch (e) {
      console.warn("Invalid stored key, regenerating...", e);
    }
  }

  // Generate new if missing either
  const { privateKey, publicKey } = await generateRsaPssKeyPair();
  const publicKeyPem = await exportPublicKeyPem(publicKey);
  const privateKeyPem = await exportPrivateKeyPem(privateKey);

  localStorage.setItem(privKeyName, privateKeyPem);
  localStorage.setItem(`pub:${username}:${deviceId}`, publicKeyPem);
  
  // Return everything needed for enrollment
  return { privateKey, publicKeyPem, deviceId };
}

// ===== Admin / Debug helpers =====
export function getUserPemFromLocalStorage(username) {
  if (!username) return { pub: "", priv: "" };
  const deviceId = getOrGenDeviceId();
  return {
    pub: "(Public key not stored locally anymore, generated on enrollment)",
    priv: localStorage.getItem(LS_PRIV(username, deviceId)) || "",
  };
}

export function clearUserKeys(username) {
  if (!username) return;
  const deviceId = getOrGenDeviceId();
  localStorage.removeItem(LS_PRIV(username, deviceId));
}

// =====================================================
// ✉️ MESSAGE SIGNING
// =====================================================
export function buildMessagePayload({
  conversationId,
  clientTimestamp,
  nonce, // base64
  body,
}) {
  // `${conversationId}|${clientTimestamp}|${nonceBase64}|${body}`
  const cid = String(conversationId);
  const ts = String(clientTimestamp); // Ensure canonical via String(Number()) if backend requires, but backend said String(Number(ts)) in PROMPT, 
  // actually prompt said: canonicalTs = String(Number(clientTimestamp)).
  // But clientTimestamp is ISO string in previous code?
  // Let's standardise: Client sends ISO. Backend parses ISO -> getTime().
  // Protocol: canonical string = String(new Date(iso).getTime())
  
  const tsVal = new Date(clientTimestamp).getTime();
  const n = String(nonce);
  const b = String(body);

  const raw = `${cid}|${tsVal}|${n}|${b}`;
  return new TextEncoder().encode(raw);
}

export async function sha256Bytes(bytes) {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(hash);
}

export async function signHashRsaPss(privateKey, hashUint8) {
  // We sign the raw data, SHA-256 is internal to RSA-PSS param
  const sig = await crypto.subtle.sign(
    { name: "RSA-PSS", saltLength: 32 },
    privateKey,
    hashUint8
  );
  return ab2b64(sig);
}
