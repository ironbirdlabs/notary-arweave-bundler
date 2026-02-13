import {
  KMSClient,
  GetPublicKeyCommand,
  SignCommand,
} from "@aws-sdk/client-kms";
import crypto from "crypto";

const kmsClient = new KMSClient({});

// Cache public key modulus across warm Lambda invocations
let cachedOwner: Buffer | null = null;
let cachedKeyArn: string | null = null;

export async function getOwnerModulus(kmsKeyArn: string): Promise<Buffer> {
  if (cachedOwner && cachedKeyArn === kmsKeyArn) {
    return cachedOwner;
  }

  const response = await kmsClient.send(
    new GetPublicKeyCommand({ KeyId: kmsKeyArn }),
  );

  if (!response.PublicKey) {
    throw new Error("KMS GetPublicKey returned no public key");
  }

  // Parse DER-encoded SPKI public key to extract RSA modulus
  // SPKI structure: SEQUENCE { SEQUENCE { OID, NULL }, BIT STRING { SEQUENCE { INTEGER n, INTEGER e } } }
  const derBuffer = Buffer.from(response.PublicKey);
  const publicKey = crypto.createPublicKey({
    key: derBuffer,
    format: "der",
    type: "spki",
  });

  // Export as JWK to get modulus directly
  const jwk = publicKey.export({ format: "jwk" });
  if (!jwk.n) {
    throw new Error("Failed to extract modulus from KMS public key");
  }

  // JWK 'n' is base64url-encoded modulus — decode to raw bytes
  cachedOwner = Buffer.from(jwk.n, "base64url");
  cachedKeyArn = kmsKeyArn;
  return cachedOwner;
}

export async function kmsSign(
  kmsKeyArn: string,
  message: Uint8Array,
): Promise<Buffer> {
  const response = await kmsClient.send(
    new SignCommand({
      KeyId: kmsKeyArn,
      Message: message,
      MessageType: "RAW",
      SigningAlgorithm: "RSASSA_PSS_SHA_256",
    }),
  );

  if (!response.Signature) {
    throw new Error("KMS Sign returned no signature");
  }

  return Buffer.from(response.Signature);
}

export async function signTransaction(
  tx: {
    setOwner(owner: string): void;
    getSignatureData(): Promise<Uint8Array>;
    setSignature(sig: {
      id: string;
      owner: string;
      signature: string;
    }): void;
  },
  kmsKeyArn: string,
): Promise<void> {
  // Owner MUST be set before getSignatureData() — the owner is included
  // in the deep hash that gets signed. This matches arweave-js internals
  // (see transactions.js: setOwner() is called before getSignatureData()).
  const owner = await getOwnerModulus(kmsKeyArn);
  const ownerB64 = owner.toString("base64url");
  tx.setOwner(ownerB64);

  const signatureData = await tx.getSignatureData();
  const signature = await kmsSign(kmsKeyArn, signatureData);

  const id = crypto.createHash("sha256").update(signature).digest();

  tx.setSignature({
    id: id.toString("base64url"),
    owner: ownerB64,
    signature: signature.toString("base64url"),
  });
}
