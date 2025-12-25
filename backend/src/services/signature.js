// src/services/signature.js
import crypto from "crypto";

/** sha256(Buffer) -> Buffer(32) */
export function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest();
}

/**
 * Verify RSA-PSS where the CLIENT SIGNS THE HASH DIRECTLY.
 * That means on Node side we must verify "raw" bytes without hashing again.
 *
 * We do this by using RSA_NO_PADDING? (không phù hợp) -> NO.
 * Cách đúng, an toàn, phổ biến cho "sign hash" là:
 * - Dùng crypto.verify với algorithm = null và message = hash bytes
 * - Key phải là RSA-PSS + set padding/saltLength
 *
 * Lưu ý: Node vẫn sẽ coi message là bytes đầu vào và không tự hash nếu algo=null.
 */
export function verifySignaturePSS({ publicKeyPem, hashBuffer, signatureBuffer }) {
  try {
    // Node crypto.verify:
    // - algorithm: null => treat data as pre-hashed / raw
    // - padding: RSA_PKCS1_PSS_PADDING
    // - saltLength: 32 (match frontend)
    return crypto.verify(
      null,
      hashBuffer,
      {
        key: publicKeyPem,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: 32,
      },
      signatureBuffer
    );
  } catch (e) {
    console.error("verifySignaturePSS error:", e?.message || e);
    return false;
  }
}
