# notary-arweave-bundler

Self-hosted Arweave bundler for agentsystems-notary. Receives signed ANS-104 DataItems, batches them via SQS, and submits multi-item bundles as L1 Arweave transactions — paid for by an operator-funded AWS KMS RSA-4096 wallet.

Anyone can fork, deploy, and run their own subsidized bundler.

## Architecture

```
Client (SDK) → API Gateway → Lambda (verify) → SQS → Lambda (bundle + submit)
                                                  ↓ (on repeated failure)
                                                 DLQ
```

## Prerequisites

- AWS CLI configured with credentials (`aws configure`)
- [SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) installed
- Docker installed
- agentsystems-notary SDK >= 0.2.0 (must include namespace hashing support)

## Deploy

### 1. Clone This Repo

```bash
git clone https://github.com/agentsystems/notary-arweave-bundler.git
cd notary-arweave-bundler
```

If you forked this repo, replace the URL with your fork.

### 2. Create KMS Key

```bash
aws kms create-key \
  --key-spec RSA_4096 \
  --key-usage SIGN_VERIFY \
  --description "Arweave bundler signing key"
```

Note the `Arn` field from the output (e.g. `arn:aws:kms:us-east-1:123456789012:key/abcd-1234-...`). You'll need it in step 4.

### 3. Pull Image and Push to ECR

AWS Lambda requires images in ECR. Pull the pre-built image from GHCR and push to your account:

```bash
REGION=$(aws configure get region)
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
ECR_URI=$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/notary-arweave-bundler

# Create ECR repository (first time only)
aws ecr create-repository --repository-name notary-arweave-bundler

# Pull from GHCR (replace with your fork's image path if applicable)
docker pull ghcr.io/agentsystems/notary-arweave-bundler:main

# Tag and push to ECR
aws ecr get-login-password | docker login --username AWS --password-stdin $ACCOUNT.dkr.ecr.$REGION.amazonaws.com
docker tag ghcr.io/agentsystems/notary-arweave-bundler:main $ECR_URI:latest
docker push $ECR_URI:latest
```

### 4. Deploy Stack

```bash
KMS_KEY_ARN="arn:aws:kms:..."  # paste the Arn from step 2

sam deploy \
  --template-file template.yaml \
  --stack-name notary-arweave-bundler \
  --parameter-overrides \
    KmsKeyArn=$KMS_KEY_ARN \
    ImageUri=$ECR_URI:latest \
    ApiKey=your-secret-key \
    DryRun=true \
  --capabilities CAPABILITY_IAM \
  --resolve-s3
```

The `ApiKey` parameter is optional. Omit it to leave the endpoint open. If set, the SDK must send the same key via the `bundler_api_key` parameter.

Set `DryRun=true` to test the full pipeline without submitting to Arweave or spending AR. The bundle Lambda will assemble and sign the transaction but skip submission. Check CloudWatch logs to verify everything works, then redeploy with `DryRun=false` (or omit it) to go live.

The API Gateway endpoint URL will be printed in the stack outputs.

### 5. Point SDK

Set `bundler_url` in the agentsystems-notary SDK to the API Gateway endpoint from the stack outputs:

```python
from agentsystems_notary import NotaryCore

notary = NotaryCore(
    bundler_url="https://XXXXXXXXXX.execute-api.us-east-1.amazonaws.com",
    bundler_api_key="your-secret-key",  # omit if no API key was set
)
```

## Building from Source

If you prefer to build the image yourself instead of pulling from GHCR:

```bash
npm ci
npm run build
docker build -t notary-arweave-bundler .
```

Then tag and push to your ECR as shown in step 3.

## Environment Variables

These are set automatically by the SAM template. Listed here for reference.

| Variable | Lambda | Description |
|---|---|---|
| `SQS_QUEUE_URL` | verify | SQS queue URL |
| `API_KEY` | verify | Optional API key for endpoint protection (default: empty/open) |
| `KMS_KEY_ARN` | bundle | KMS key ARN for signing L1 transactions |
| `ARWEAVE_GATEWAY_URL` | bundle | Arweave gateway (default: `https://arweave.net`) |
| `DRY_RUN` | bundle | Skip Arweave submission when `true` (default: `false`) |
