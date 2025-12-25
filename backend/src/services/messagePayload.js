// src/services/messagePayload.js

/**
 * Canonical payload MUST match frontend buildMessagePayload (crypto.js)
 * Output: Buffer of UTF-8 JSON string
 */
export function buildMessagePayload({
  conversationId,
  senderId,
  body,
  clientTimestamp,
  nonce,
}) {
  const payloadObj = {
    conversationId: Number(conversationId),
    senderId: Number(senderId),
    clientTimestamp: clientTimestamp ? String(clientTimestamp) : "",
    nonce: nonce ? String(nonce) : "",
    body: String(body),
  };

  const json = JSON.stringify(payloadObj);
  return Buffer.from(json, "utf8");
}
