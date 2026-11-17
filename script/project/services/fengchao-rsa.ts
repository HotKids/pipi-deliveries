import { utf8Data } from "./scripting-data";

function valueOf(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function derReader(bytes: Uint8Array) {
  let position = 0;
  return (tag: number): Uint8Array => {
    if (bytes[position++] !== tag || position >= bytes.length) throw new Error("Invalid RSA key");
    let size = bytes[position++];
    if (size >= 128) {
      const count = size - 128;
      if (count < 1 || count > 2 || position + count > bytes.length) throw new Error("Invalid RSA key");
      size = 0;
      for (let i = 0; i < count; i++) size = (size << 8) + bytes[position++];
    }
    if (position + size > bytes.length) throw new Error("Invalid RSA key");
    const item = bytes.subarray(position, position + size);
    position += size;
    return item;
  };
}

function modularPower(value: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  while (exponent > 0n) {
    if (exponent & 1n) result = result * value % modulus;
    exponent >>= 1n;
    value = value * value % modulus;
  }
  return result;
}

export function encryptFengchaoChallenge(text: string, spkiBase64: string): string {
  const der = Data.fromBase64String(spkiBase64);
  if (!der) throw new Error("Invalid RSA key");
  const publicKey = derReader(derReader(new Uint8Array(der.toArrayBuffer()))(0x30));
  const algorithm = derReader(publicKey(0x30))(0x06);
  if (Array.from(algorithm).join() !== "42,134,72,134,247,13,1,1,1") throw new Error("Invalid RSA key");
  const bits = publicKey(0x03);
  if (bits[0] !== 0) throw new Error("Invalid RSA key");
  const rsa = derReader(derReader(bits.subarray(1))(0x30));
  const keyBytes = rsa(0x02);
  const exponentBytes = rsa(0x02);
  const modulusBytes = keyBytes[0] === 0 ? keyBytes.subarray(1) : keyBytes;
  const size = modulusBytes.length;
  const message = new Uint8Array(utf8Data(text).toArrayBuffer());
  if (size < 128 || size > 512 || exponentBytes.length > 4 || message.length > size - 11) {
    throw new Error("Unsupported RSA key");
  }
  const exponent = valueOf(exponentBytes);
  if (exponent < 3n || !(exponent & 1n)) throw new Error("Unsupported RSA key");
  const block = new Uint8Array(size);
  block[1] = 2;
  const delimiter = size - message.length - 1;
  let offset = 2;
  while (offset < delimiter) {
    const bytes = new Uint8Array(Crypto.generateSymmetricKey(256).toArrayBuffer());
    if (bytes.length !== 32) throw new Error("Secure random data unavailable");
    for (const byte of bytes) {
      if (byte !== 0 && offset < delimiter) block[offset++] = byte;
    }
  }
  block.set(message, delimiter + 1);
  let value = modularPower(valueOf(block), exponent, valueOf(modulusBytes));
  const encrypted = new Uint8Array(size);
  for (let i = size - 1; i >= 0; i--) {
    encrypted[i] = Number(value & 255n);
    value >>= 8n;
  }
  const encoded = Data.fromUint8Array(encrypted);
  if (!encoded) throw new Error("Unable to encode challenge");
  return encoded.toBase64String();
}
