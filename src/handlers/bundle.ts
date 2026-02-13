import type { SQSEvent } from "aws-lambda";
import Arweave from "arweave";
import { assembleBundle } from "../lib/assemble-bundle";
import { signTransaction } from "../lib/kms-signer";
import { config } from "../config";

const gatewayUrl = new URL(config.arweaveGatewayUrl);

const arweave = Arweave.init({
  host: gatewayUrl.hostname,
  port: gatewayUrl.port ? parseInt(gatewayUrl.port, 10) : 443,
  protocol: gatewayUrl.protocol.replace(":", ""),
});

export async function handler(event: SQSEvent): Promise<void> {
  const dataItems: Buffer[] = event.Records.map((record) =>
    Buffer.from(record.body, "base64"),
  );

  console.log(`Bundling ${dataItems.length} data items`);

  // Assemble ANS-104 bundle binary
  const bundleBuffer = assembleBundle(dataItems);

  // Create L1 transaction
  const tx = await arweave.createTransaction({ data: bundleBuffer });
  tx.addTag("Bundle-Format", "binary");
  tx.addTag("Bundle-Version", "2.0.0");

  // Sign with KMS
  await signTransaction(tx, config.kmsKeyArn);

  if (config.dryRun) {
    console.log(`[DRY RUN] Bundle ready but not submitted: ${tx.id} (${dataItems.length} items, ${bundleBuffer.length} bytes)`);
    return;
  }

  // TODO: Re-enable Arweave submission once end-to-end testing is complete
  // const submitResponse = await arweave.transactions.post(tx);
  // if (submitResponse.status !== 200 && submitResponse.status !== 208) {
  //   throw new Error(
  //     `Arweave transaction submission failed: ${submitResponse.status} ${JSON.stringify(submitResponse.data)}`,
  //   );
  // }

  console.log(`[SUBMIT DISABLED] Bundle signed but not submitted: ${tx.id} (${dataItems.length} items, ${bundleBuffer.length} bytes)`);
}
