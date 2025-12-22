/**
 * Canonical payload để hash + ký (tránh mơ hồ delimiter)
 * IMPORTANT: Client phải tạo payload y hệt cấu trúc này.
 */
export function buildMessagePayload({ conversationId, senderId, body, clientTimestamp, nonce }) {
  const payloadObj = {
    conversationId: Number(conversationId),
    senderId: Number(senderId),
    // chuẩn hóa timestamp về string (milli hoặc ISO đều được miễn thống nhất)
    clientTimestamp: clientTimestamp ? String(clientTimestamp) : "",
    // nonce optional (để mở rộng chống replay)
    nonce: nonce ? String(nonce) : "",
    body: String(body),
  };

  return Buffer.from(JSON.stringify(payloadObj), "utf8");
}
