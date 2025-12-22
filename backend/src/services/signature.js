import crypto from "crypto";

export function sha256(payloadBuffer) {
  return crypto.createHash("sha256").update(payloadBuffer).digest();
}

function normalizePem(pem) {
  if (!pem) return pem;
  let s = String(pem).trim().replace(/\\n/g, "\n");
  // remove \r
  s = s.replace(/\r/g, "");
  return s;
}

// PEM -> DER Buffer (SPKI)
function pemToDer(pem) {
  const s = normalizePem(pem);
  const b64 = s
    .replace(/-----BEGIN PUBLIC KEY-----/g, "")
    .replace(/-----END PUBLIC KEY-----/g, "")
    .replace(/\s+/g, "");
  return Buffer.from(b64, "base64");
}

export function verifySignaturePSS({ publicKeyPem, hashBuffer, signatureBuffer }) {
  const der = pemToDer(publicKeyPem);

  // Tạo public key từ DER SPKI (ổn định hơn)
  const keyObj = crypto.createPublicKey({
    key: der,
    format: "der",
    type: "spki",
  });

  return crypto.verify(
    null,
    hashBuffer,
    {
      key: keyObj,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    },
    signatureBuffer
  );
}
