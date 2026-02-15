# notary-arweave-bundler

Self-hosted Arweave bundler for [agentsystems-notary](https://github.com/agentsystems/agentsystems-notary). Receives signed ANS-104 DataItems from SDK clients, batches them via SQS, and submits multi-item bundles as L1 Arweave transactions.

## Architecture

```
Client (SDK) → API Gateway → Lambda (verify) → SQS → Lambda (bundle + submit)
                                                  ↓ (on repeated failure)
                                                 DLQ
```

## Prerequisites

- AWS account
- GitHub account

## Deploy

### Step 1: AWS Console Setup (~10 min)

**Create a deployer IAM user:**

1. Go to **IAM > Users > Create user**. Name it `notary-arweave-bundler-deployer`.
2. Open the user, go to **Permissions > Add permissions > Create inline policy**. Switch to the **JSON** tab, paste the contents of [`iam-policy.json`](iam-policy.json) from this repo, and name it `deployer`.
3. Go to **Security credentials > Create access key**. Select **Application running outside AWS**. Note the access key ID and secret.

**Create a KMS signing key:**

4. Go to **KMS > Customer managed keys > Create key**.
5. Key type: **Asymmetric**. Key spec: **RSA_4096**. Key usage: **Sign and verify**. Click through to create.
6. Note the key ARN (e.g. `arn:aws:kms:us-east-1:123456789012:key/abcd-1234-...`).

**Create an API key (optional):**

7. Go to **Secrets Manager > Store a new secret** with a random API key string. Note the ARN. Skip this step to leave the endpoint open.

### Step 2: Fork & Configure (~2 min)

1. Fork this repo on GitHub.
2. In your fork, go to **Settings > Secrets and variables > Actions**.
3. Add these repository secrets:

| Secret | Value |
|---|---|
| `AWS_ACCESS_KEY_ID` | From step 1.3 |
| `AWS_SECRET_ACCESS_KEY` | From step 1.3 |
| `KMS_KEY_ARN` | From step 1.6 |
| `API_KEY_SECRET_ARN` | From step 1.7 (optional) |

### Step 3: Deploy

1. Go to **Actions > Release > Run workflow**.
2. Enter a version (e.g. `0.1.0`) and click **Run workflow**.
3. The workflow builds the image, pushes to GHCR + ECR, runs `sam deploy` to create the full stack, and creates a GitHub release.
4. When complete, check the **workflow summary** for your API Gateway endpoint URL and Arweave address.

### Step 4: Fund

Send AR to the Arweave address shown in the workflow summary.

### Step 5: Configure SDK

Configure the agentsystems-notary SDK (>= 0.2.0) to use your bundler:

```python
from agentsystems_notary import NotaryCore

notary = NotaryCore(
    bundler_url="https://XXXXXXXXXX.execute-api.us-east-1.amazonaws.com",
    bundler_api_key="...",  # omit if no API key
)
```
