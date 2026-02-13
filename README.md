# notary-arweave-bundler

Self-hosted Arweave bundler for [agentsystems-notary](https://github.com/agentsystems/notary). Receives signed ANS-104 DataItems from SDK clients, batches them via SQS, and submits multi-item bundles as L1 Arweave transactions.

The operator pays for Arweave storage (AR tokens) and AWS compute. Clients submit DataItems for free — the operator subsidizes the uploads.

## Architecture

```
Client (SDK) → API Gateway → Lambda (verify) → SQS → Lambda (bundle + submit)
                                                  ↓ (on repeated failure)
                                                 DLQ
```

## Prerequisites

- AWS CLI configured with credentials (see Step 0 below)
- [SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) installed
- Docker installed
- Node.js installed (for wallet address derivation in step 6)

## Deploy

### 0. Create a Deployer IAM User

Create a dedicated IAM user for deploying this stack. This avoids using a root or admin account.

1. In the AWS Console, go to **IAM > Users > Create user** (or use the CLI below).
2. Attach the following inline policy (name it `notary-arweave-bundler-deployer`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "KMS",
      "Effect": "Allow",
      "Action": [
        "kms:CreateKey",
        "kms:CreateAlias",
        "kms:DescribeKey",
        "kms:GetPublicKey"
      ],
      "Resource": "*"
    },
    {
      "Sid": "SecretsManager",
      "Effect": "Allow",
      "Action": [
        "secretsmanager:CreateSecret",
        "secretsmanager:GetSecretValue"
      ],
      "Resource": "*"
    },
    {
      "Sid": "ECRAuth",
      "Effect": "Allow",
      "Action": "ecr:GetAuthorizationToken",
      "Resource": "*"
    },
    {
      "Sid": "ECRPush",
      "Effect": "Allow",
      "Action": [
        "ecr:CreateRepository",
        "ecr:BatchCheckLayerAvailability",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage"
      ],
      "Resource": "arn:aws:ecr:*:*:repository/notary-arweave-bundler"
    },
    {
      "Sid": "STS",
      "Effect": "Allow",
      "Action": "sts:GetCallerIdentity",
      "Resource": "*"
    },
    {
      "Sid": "SAMDeploy",
      "Effect": "Allow",
      "Action": [
        "cloudformation:*",
        "s3:*",
        "lambda:*",
        "apigateway:*",
        "sqs:*",
        "iam:*",
        "logs:*"
      ],
      "Resource": "*"
    }
  ]
}
```

3. Create an access key for the user and configure a named CLI profile:

```bash
aws configure --profile notary-arweave-bundler-deployer
```

All commands below use `--profile notary-arweave-bundler-deployer` to target this user.

### 1. Create KMS Key

This RSA-4096 key is your Arweave wallet. The bundler uses KMS to sign Arweave transactions without the private key ever being exposed to application code.

```bash
aws kms create-key \
  --key-spec RSA_4096 \
  --key-usage SIGN_VERIFY \
  --description "Arweave bundler signing key" \
  --profile notary-arweave-bundler-deployer
```

Note the `Arn` field from the output (e.g. `arn:aws:kms:us-east-1:123456789012:key/abcd-1234-...`). You'll need it in step 4.

### 2. Create API Key (Optional)

To protect your endpoint, store a randomly generated API key in Secrets Manager:

```bash
aws secretsmanager create-secret \
  --name notary-arweave-bundler/api-key \
  --secret-string "$(openssl rand -base64 32)" \
  --profile notary-arweave-bundler-deployer
```

Note the `ARN` field from the output. You'll need it in step 4. Skip this step to leave the endpoint open (anyone with the URL can submit DataItems and spend your AR).

### 3. Pull Image and Push to ECR

AWS Lambda requires container images in ECR. Pull the pre-built image from GHCR and push to your account:

```bash
REGION=$(aws configure get region --profile notary-arweave-bundler-deployer)
ACCOUNT=$(aws sts get-caller-identity --query Account --output text --profile notary-arweave-bundler-deployer)
ECR_URI=$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/notary-arweave-bundler

# Create ECR repository (first time only)
aws ecr create-repository --repository-name notary-arweave-bundler --profile notary-arweave-bundler-deployer

# Pull from GHCR
docker pull ghcr.io/agentsystems/notary-arweave-bundler:latest

# Tag and push to ECR
aws ecr get-login-password --profile notary-arweave-bundler-deployer | docker login --username AWS --password-stdin $ACCOUNT.dkr.ecr.$REGION.amazonaws.com
docker tag ghcr.io/agentsystems/notary-arweave-bundler:latest $ECR_URI:latest
docker push $ECR_URI:latest
```

### 4. Deploy Stack

Download the SAM template and deploy:

```bash
curl -fLO https://raw.githubusercontent.com/agentsystems/notary-arweave-bundler/main/template.yaml

KMS_KEY_ARN="arn:aws:kms:..."   # from step 1

sam deploy \
  --template-file template.yaml \
  --stack-name notary-arweave-bundler \
  --parameter-overrides \
    KmsKeyArn=$KMS_KEY_ARN \
    ImageUri=$ECR_URI:latest \
    DryRun=true \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --profile notary-arweave-bundler-deployer
```

If you created an API key in step 2, add it to the parameter overrides:

```
    ApiKeySecretArn=arn:aws:secretsmanager:...   # from step 2
```

The stack deploys with `DryRun=true` — the full pipeline runs (verify, sign, bundle) but skips Arweave submission so you can test without spending AR. Check CloudWatch logs to verify everything works.

The API Gateway endpoint URL will be printed in the stack outputs.

### 5. Fund Your Wallet

Derive your Arweave wallet address from the KMS key:

```bash
aws kms get-public-key --key-id "$KMS_KEY_ARN" --output text --query PublicKey --profile notary-arweave-bundler-deployer | \
  node -e "
    const crypto = require('crypto');
    let d = '';
    process.stdin.on('data', c => d += c);
    process.stdin.on('end', () => {
      const pub = crypto.createPublicKey({
        key: Buffer.from(d.trim(), 'base64'),
        format: 'der', type: 'spki',
      });
      const n = pub.export({ format: 'jwk' }).n;
      const addr = crypto.createHash('sha256')
        .update(Buffer.from(n, 'base64url')).digest().toString('base64url');
      console.log(addr);
    });
  "
```

Send AR to this address. You can acquire AR from an exchange and transfer it, or fund it from an existing wallet. The bundler needs AR to pay for L1 transaction storage. See [arweave.net](https://arweave.net) for current pricing.

You can check your balance at `https://arweave.net/wallet/<ADDRESS>/balance`.

### 6. Go Live

Once your wallet is funded, redeploy with the same parameters as step 4 but set `DryRun=false` (or omit it — the default is `false`):

```bash
sam deploy \
  --template-file template.yaml \
  --stack-name notary-arweave-bundler \
  --parameter-overrides \
    KmsKeyArn=$KMS_KEY_ARN \
    ImageUri=$ECR_URI:latest \
    DryRun=false \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --profile notary-arweave-bundler-deployer
```

Include `ApiKeySecretArn=...` again if you set it in step 4.

### 7. Point SDK

Retrieve your API key (if you created one in step 2):

```bash
aws secretsmanager get-secret-value \
  --secret-id notary-arweave-bundler/api-key \
  --query SecretString --output text \
  --profile notary-arweave-bundler-deployer
```

Configure the agentsystems-notary SDK (>= 0.2.0) to use your bundler:

```python
from agentsystems_notary import NotaryCore

notary = NotaryCore(
    bundler_url="https://XXXXXXXXXX.execute-api.us-east-1.amazonaws.com",
    bundler_api_key="...",  # the value from above; omit if no API key
)
```

## Building from Source

If you prefer to build the image yourself instead of pulling from GHCR:

```bash
git clone https://github.com/agentsystems/notary-arweave-bundler.git
cd notary-arweave-bundler
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
| `API_KEY_SECRET_ARN` | verify | Optional Secrets Manager ARN for API key (default: empty/open) |
| `KMS_KEY_ARN` | bundle | KMS key ARN for signing L1 transactions |
| `ARWEAVE_GATEWAY_URL` | bundle | Arweave gateway (default: `https://arweave.net`) |
| `DRY_RUN` | bundle | Skip Arweave submission when `true` (default: `false`) |
