# -----------------------------------------------------------------------------
# Notary Arweave Bundler — Lambda Container Image
# Includes third-party license metadata to aid compliance reviews
# -----------------------------------------------------------------------------

ARG VERSION=unknown
ARG BUILD_TIMESTAMP=unknown
ARG GIT_COMMIT=unknown

# -----------------------------------------------------------------------------
# Builder stage – install deps, build app, and collect ALL licenses
# -----------------------------------------------------------------------------
FROM public.ecr.aws/lambda/nodejs:20 AS builder

WORKDIR /build

# Install license scanning tool
RUN npm install -g license-checker-rseidelsohn

# Copy package files first for better caching
COPY package*.json ./

# Install all dependencies (production + dev for build + complete attribution)
RUN npm ci

# Copy source code and scripts
COPY . .

# Build the application
RUN npm run build

# ---- COMPREHENSIVE LICENSE COLLECTION ----
RUN mkdir -p /build/licenses/nodejs /build/licenses/system

# 1) Capture ALL Node.js dependencies with license texts
RUN license-checker-rseidelsohn \
      --json \
      --out /build/licenses/nodejs/THIRD_PARTY_LICENSES.json

# 2) Generate human-readable attribution file with embedded license texts
COPY scripts/generate-licenses.js /tmp/generate-licenses.js
RUN node /tmp/generate-licenses.js && rm /tmp/generate-licenses.js

# 3) Export complete dependency trees for reproducibility
RUN npm list --production --json > /build/licenses/nodejs/DEPENDENCY_TREE.json 2>/dev/null || echo '{}' > /build/licenses/nodejs/DEPENDENCY_TREE.json
RUN npm list --production > /build/licenses/nodejs/DEPENDENCY_TREE.txt 2>/dev/null || echo 'No dependencies' > /build/licenses/nodejs/DEPENDENCY_TREE.txt

# 4) Copy Node.js NOTICE files from packages
RUN find node_modules -name "NOTICE*" -type f 2>/dev/null | \
    while read file; do \
      pkg_name=$(echo $file | cut -d'/' -f2); \
      cp "$file" "/build/licenses/nodejs/${pkg_name}-NOTICE" 2>/dev/null || true; \
    done

# 5) Capture Amazon Linux system packages
RUN rpm -qa --qf '%{NAME}-%{VERSION}-%{RELEASE}.%{ARCH} %{LICENSE}\n' | sort > /build/licenses/system/INSTALLED_PACKAGES.txt

# 6) Create build environment attribution
RUN echo "# Build Environment Attribution" > /build/licenses/BUILD_ENVIRONMENT.md && \
    echo "" >> /build/licenses/BUILD_ENVIRONMENT.md && \
    echo "## Build Tools Used" >> /build/licenses/BUILD_ENVIRONMENT.md && \
    echo "" >> /build/licenses/BUILD_ENVIRONMENT.md && \
    echo "- Node.js: $(node --version) (MIT License)" >> /build/licenses/BUILD_ENVIRONMENT.md && \
    echo "- npm: $(npm --version) (Artistic-2.0 License)" >> /build/licenses/BUILD_ENVIRONMENT.md && \
    echo "- Base image: public.ecr.aws/lambda/nodejs:20" >> /build/licenses/BUILD_ENVIRONMENT.md && \
    echo "" >> /build/licenses/BUILD_ENVIRONMENT.md && \
    echo "## Build Information" >> /build/licenses/BUILD_ENVIRONMENT.md && \
    echo "" >> /build/licenses/BUILD_ENVIRONMENT.md && \
    echo "- Build date: $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> /build/licenses/BUILD_ENVIRONMENT.md && \
    echo "- Platform: $(uname -m)" >> /build/licenses/BUILD_ENVIRONMENT.md

# 7) Run comprehensive license verification during build
COPY scripts/verify-attribution.cjs /tmp/verify-attribution.cjs
RUN node /tmp/verify-attribution.cjs && rm /tmp/verify-attribution.cjs

# 8) Generate compliance verification checksums
RUN find /build/licenses -name "*.json" -o -name "*.txt" -o -name "*.md" | \
    sort | xargs sha256sum > /build/licenses/ATTRIBUTION_CHECKSUMS.txt

# 9) Remove license scanning tools to keep runtime clean
RUN npm uninstall -g license-checker-rseidelsohn

# Prune to production-only dependencies for the final image
RUN npm ci --omit=dev

# -----------------------------------------------------------------------------
# Final stage – minimal Lambda runtime with complete license attribution
# -----------------------------------------------------------------------------
FROM public.ecr.aws/lambda/nodejs:20

# Re-declare args for final stage
ARG VERSION=unknown
ARG BUILD_TIMESTAMP=unknown
ARG GIT_COMMIT=unknown

# Copy production node_modules
COPY --from=builder /build/node_modules ${LAMBDA_TASK_ROOT}/node_modules

# Copy compiled application
COPY --from=builder /build/dist ${LAMBDA_TASK_ROOT}

# Copy package.json (needed at runtime for module resolution)
COPY --from=builder /build/package.json ${LAMBDA_TASK_ROOT}/package.json

# Copy project LICENSE
COPY LICENSE ${LAMBDA_TASK_ROOT}/LICENSE

# Copy comprehensive license attribution artifacts
COPY --from=builder /build/licenses ${LAMBDA_TASK_ROOT}/licenses

# OCI labels
LABEL org.opencontainers.image.title="Notary Arweave Bundler" \
      org.opencontainers.image.description="Self-hosted Arweave bundler for agentsystems-notary" \
      org.opencontainers.image.vendor="AgentSystems" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.license.files="/var/task/licenses" \
      org.opencontainers.image.license.verification="/var/task/licenses/ATTRIBUTION_CHECKSUMS.txt" \
      org.opencontainers.image.source="https://github.com/agentsystems/notary-arweave-bundler" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.created="${BUILD_TIMESTAMP}" \
      org.opencontainers.image.revision="${GIT_COMMIT}"

CMD ["handlers/verify.handler"]
