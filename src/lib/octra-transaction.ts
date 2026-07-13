import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign } from "node:crypto";

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_ZERO = "1";

export interface OctraTransaction {
  from: string;
  to_: string;
  amount: string;
  nonce: number;
  ou: string;
  timestamp: number;
  op_type: string;
  signature?: string;
  public_key?: string;
  encrypted_data?: string;
  message?: string;
}

export interface OperatorWallet {
  address: string;
  privateKeySeed: Buffer;
  publicKey: Buffer;
  publicKeyBase64: string;
}

export interface WalletEnvOptions {
  privateKeyEnv?: string[];
  addressEnv?: string[];
  label?: string;
}

function jsonString(value: string): string {
  return JSON.stringify(value);
}

export function canonicalTransactionJson(tx: OctraTransaction): string {
  let value = `{`;
  value += `"from":${jsonString(tx.from)}`;
  value += `,"to_":${jsonString(tx.to_)}`;
  value += `,"amount":${jsonString(tx.amount)}`;
  value += `,"nonce":${tx.nonce}`;
  value += `,"ou":${jsonString(tx.ou)}`;
  value += `,"timestamp":${JSON.stringify(tx.timestamp)}`;
  value += `,"op_type":${jsonString(tx.op_type || "standard")}`;
  if (tx.encrypted_data) value += `,"encrypted_data":${jsonString(tx.encrypted_data)}`;
  if (tx.message) value += `,"message":${jsonString(tx.message)}`;
  value += `}`;
  return value;
}

export function transactionHash(tx: OctraTransaction): string {
  return createHash("sha256").update(canonicalTransactionJson(tx)).digest("hex");
}

export function normalizeTransactionHash(value: unknown): string | null {
  if (!value) return null;
  const text = String(value).replace(/^sha256:/, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(text) ? text : null;
}

export function submittedTransactionHash(submitResult: any, preparedHash: string): {
  txHash: string;
  returnedTxHash: string | null;
  hashSource: "rpc" | "prepared_transaction";
} {
  const rawReturnedHash = submitResult?.tx_hash || submitResult?.hash || submitResult?.transaction_hash;
  const returnedTxHash = normalizeTransactionHash(rawReturnedHash);
  if (rawReturnedHash && !returnedTxHash) {
    throw new Error("Octra RPC returned a malformed transaction hash");
  }
  return {
    txHash: returnedTxHash || preparedHash,
    returnedTxHash,
    hashSource: returnedTxHash ? "rpc" : "prepared_transaction"
  };
}

function ed25519PrivateKeyFromSeed(seed: Buffer) {
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8"
  });
}

function derivePublicKey(seed: Buffer): Buffer {
  const publicKey = createPublicKey(ed25519PrivateKeyFromSeed(seed));
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return der.subarray(-32);
}

export function signTransaction(tx: OctraTransaction, wallet: OperatorWallet): OctraTransaction {
  const derivedPublicKey = derivePublicKey(wallet.privateKeySeed);
  if (!wallet.publicKey.equals(derivedPublicKey)) {
    throw new Error("operator private key public half does not match derived Ed25519 public key");
  }
  const key = ed25519PrivateKeyFromSeed(wallet.privateKeySeed);
  const signature = cryptoSign(null, Buffer.from(canonicalTransactionJson(tx)), key).toString("base64");
  return {
    ...tx,
    signature,
    public_key: wallet.publicKeyBase64
  };
}

function base58Encode(bytes: Buffer): string {
  let value = BigInt(`0x${bytes.toString("hex")}`);
  let encoded = "";
  while (value > 0n) {
    const remainder = Number(value % 58n);
    value /= 58n;
    encoded = BASE58_ALPHABET.charAt(remainder) + encoded;
  }
  for (const byte of bytes) {
    if (byte === 0) encoded = `${BASE58_ZERO}${encoded}`;
    else break;
  }
  return encoded || BASE58_ZERO;
}

export function deriveOctraAddress(publicKey: Buffer): string {
  const digest = createHash("sha256").update(publicKey).digest();
  let body = base58Encode(digest);
  while (body.length < 44) body = `1${body}`;
  return `oct${body}`;
}

function firstEnv(names: string[]): string | null {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return null;
}

export function loadWalletFromEnv(options: WalletEnvOptions = {}): OperatorWallet | null {
  const privateKeyEnv = options.privateKeyEnv || ["VITALS_OPERATOR_PRIVATE_KEY_B64", "OCTRA_PRIVATE_KEY_B64"];
  const addressEnv = options.addressEnv || ["VITALS_OPERATOR_ADDRESS"];
  const label = options.label || "operator";
  const privateKeyBase64 = firstEnv(privateKeyEnv);
  if (!privateKeyBase64) return null;

  const raw = Buffer.from(privateKeyBase64, "base64");
  if (raw.length < 32) throw new Error(`${privateKeyEnv[0] || "private key"} must decode to at least 32 bytes`);

  const seed = raw.subarray(0, 32);
  const derivedPublicKey = derivePublicKey(seed);
  const publicKey = raw.length >= 64 ? raw.subarray(32, 64) : derivedPublicKey;
  if (!publicKey.equals(derivedPublicKey)) {
    throw new Error("operator private key public half does not match derived Ed25519 public key");
  }

  const derivedAddress = deriveOctraAddress(publicKey);
  const configuredAddress = firstEnv(addressEnv);
  if (configuredAddress && configuredAddress !== derivedAddress) {
    throw new Error(`${label} address does not match private key address ${derivedAddress}`);
  }

  return {
    address: configuredAddress || derivedAddress,
    privateKeySeed: Buffer.from(seed),
    publicKey: Buffer.from(publicKey),
    publicKeyBase64: Buffer.from(publicKey).toString("base64")
  };
}

export function loadOperatorWalletFromEnv(): OperatorWallet | null {
  return loadWalletFromEnv({
    privateKeyEnv: ["VITALS_OPERATOR_PRIVATE_KEY_B64", "OCTRA_PRIVATE_KEY_B64"],
    addressEnv: ["VITALS_OPERATOR_ADDRESS"],
    label: "operator"
  });
}

export function publicTransactionJson(tx: OctraTransaction): Record<string, unknown> {
  const body: Record<string, unknown> = {
    from: tx.from,
    to_: tx.to_,
    amount: tx.amount,
    nonce: tx.nonce,
    ou: tx.ou,
    timestamp: tx.timestamp
  };
  if (tx.signature) body.signature = tx.signature;
  if (tx.public_key) body.public_key = tx.public_key;
  if (tx.op_type) body.op_type = tx.op_type;
  if (tx.encrypted_data) body.encrypted_data = tx.encrypted_data;
  if (tx.message) body.message = tx.message;
  return body;
}
