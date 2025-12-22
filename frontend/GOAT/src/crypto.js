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

export async function generateRsaPssKeyPair() {
  // RSA-PSS (SHA-256), modulus 2048 đủ cho đồ án; muốn đẹp hơn có thể 3072
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

export async function exportPublicKeyPem(publicKey) {
  const spki = await crypto.subtle.exportKey("spki", publicKey);
  const b64 = ab2b64(spki);
  return wrapPem(b64, "PUBLIC KEY");
}

export async function exportPrivateKeyPem(privateKey) {
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", privateKey);
  const b64 = ab2b64(pkcs8);
  return wrapPem(b64, "PRIVATE KEY");
}

function pemToDer(pem) {
  const b64 = pem.replace(/-----BEGIN [^-]+-----|-----END [^-]+-----|\s+/g, "");
  return b64toab(b64);
}

export async function importPublicKeyPem(publicKeyPem) {
  const der = pemToDer(publicKeyPem);
  return crypto.subtle.importKey(
    "spki",
    der,
    { name: "RSA-PSS", hash: "SHA-256" },
    true,
    ["verify"]
  );
}

export async function importPrivateKeyPem(privateKeyPem) {
  const der = pemToDer(privateKeyPem);
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSA-PSS", hash: "SHA-256" },
    true,
    ["sign"]
  );
}

// ===== Canonical payload MUST match backend messagePayload.js =====
export function buildMessagePayload({ conversationId, senderId, body, clientTimestamp, nonce }) {
  const payloadObj = {
    conversationId: Number(conversationId),
    senderId: Number(senderId),
    clientTimestamp: clientTimestamp ? String(clientTimestamp) : "",
    nonce: nonce ? String(nonce) : "",
    body: String(body),
  };
  return new TextEncoder().encode(JSON.stringify(payloadObj));
}

export async function sha256Bytes(bytesUint8) {
  const hash = await crypto.subtle.digest("SHA-256", bytesUint8);
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

// ===== Local storage for demo (OK for đồ án; nhớ nêu hạn chế) =====
const LS_PRIV = "demo_private_key_pem";
const LS_PUB = "demo_public_key_pem";

export async function ensureClientKeyPair() {
  const privPem = localStorage.getItem(LS_PRIV);
  const pubPem = localStorage.getItem(LS_PUB);

  if (privPem && pubPem) {
    const privateKey = await importPrivateKeyPem(privPem);
    const publicKey = await importPublicKeyPem(pubPem);
    return { privateKey, publicKey, publicKeyPem: pubPem };
  }

  const { privateKey, publicKey } = await generateRsaPssKeyPair();
  const publicKeyPem = await exportPublicKeyPem(publicKey);
  const privateKeyPem = await exportPrivateKeyPem(privateKey);

  localStorage.setItem(LS_PRIV, privateKeyPem);
  localStorage.setItem(LS_PUB, publicKeyPem);

  return { privateKey, publicKey, publicKeyPem };
}
