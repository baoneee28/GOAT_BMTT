// src/services/messagePayload.js

/**
 * Canonical payload MUST match frontend buildMessagePayload (crypto.js)
 * requested format: `${conversationId}|${clientTimestamp}|${nonceBase64}|${body}`
 */
export function buildMessagePayload({
  conversationId,
  clientTimestamp,
  nonce, // this is nonceBase64
  body,
}) {
  // Ensure strings
  // Ensure strings
  const cid = String(conversationId);
  // Match Frontend: Use getTime() (milliseconds)
  const tsVal = new Date(clientTimestamp).getTime();
  const ts = !isNaN(tsVal) ? String(tsVal) : ""; 

  const n = nonce ? String(nonce) : ""; // base64 string
  const b = String(body);

  // “conversationId|clientTimestamp|nonceBase64|body”
  const raw = `${cid}|${ts}|${n}|${b}`;
  
  return Buffer.from(raw, "utf8");
}
