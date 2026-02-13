import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import crypto from "crypto";
import { parseDataItem } from "../lib/data-item";
import { validateDataItem } from "../lib/validate";
import { config } from "../config";

const sqsClient = new SQSClient({});

function checkApiKey(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  try {
    if (config.apiKey) {
      if (!checkApiKey(event.headers["x-api-key"], config.apiKey)) {
        return response(401, { error: "Unauthorized" });
      }
    }

    const body = event.body;
    if (!body) {
      return response(400, { error: "Missing request body" });
    }

    const buffer = event.isBase64Encoded
      ? Buffer.from(body, "base64")
      : Buffer.from(body, "binary");

    // Parse DataItem
    let parsed;
    try {
      parsed = parseDataItem(buffer);
    } catch (err) {
      return response(400, { error: `Invalid DataItem: ${(err as Error).message}` });
    }

    // Verify signature
    const valid = await parsed.isValid();
    if (!valid) {
      return response(400, { error: "DataItem signature verification failed" });
    }

    // Validate schema (signature type, tags, data payload, size, no target/anchor)
    const validation = validateDataItem(
      parsed.signatureType,
      parsed.tags,
      parsed.rawData,
      buffer.length,
      parsed.target,
      parsed.anchor,
    );
    if (!validation.valid) {
      return response(400, { error: validation.error });
    }

    // Send raw DataItem binary as base64 string to SQS
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: config.sqsQueueUrl,
        MessageBody: buffer.toString("base64"),
      }),
    );

    return response(200, { id: parsed.id });
  } catch (err) {
    console.error("Unexpected error:", err);
    return response(500, { error: "Internal server error" });
  }
}

function response(statusCode: number, body: Record<string, string>): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
