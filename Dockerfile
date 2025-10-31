# Use Node.js 23 slim as base image (recommended by Docker Scout)
FROM node:23-slim

# Set working directory in the container
WORKDIR /app

# Copy package files for dependency installation
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy only the TypeScript config and source files
COPY tsconfig.json ./
COPY src/ ./src/
COPY .env.example ./

# Build TypeScript code
RUN npm run build

# Install AWS CLI with architecture detection
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    curl \
    unzip \
    ca-certificates && \
    # Detect architecture and download appropriate AWS CLI version
    ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then \
        echo "Installing AWS CLI for x86_64" && \
        curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"; \
    elif [ "$ARCH" = "aarch64" ]; then \
        echo "Installing AWS CLI for ARM64" && \
        curl "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o "awscliv2.zip"; \
    else \
        echo "Unsupported architecture: $ARCH" && exit 1; \
    fi && \
    unzip awscliv2.zip && \
    ./aws/install && \
    rm -rf aws awscliv2.zip && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Default command that will show usage information
CMD ["sh", "-c", "echo \"Usage: docker run --rm -v $(pwd):/app trusted-setup [contribute|verify]\" && echo \"  - contribute: Run the contribution process\" && echo \"  - verify: Run the verification process\""]

ENTRYPOINT ["npm", "run"]