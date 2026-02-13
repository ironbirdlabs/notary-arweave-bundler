function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  get kmsKeyArn(): string {
    return required("KMS_KEY_ARN");
  },
  get sqsQueueUrl(): string {
    return required("SQS_QUEUE_URL");
  },
  get arweaveGatewayUrl(): string {
    return process.env.ARWEAVE_GATEWAY_URL ?? "https://arweave.net";
  },
  get apiKey(): string | undefined {
    return process.env.API_KEY || undefined;
  },
  get dryRun(): boolean {
    return process.env.DRY_RUN === "true";
  },
};
