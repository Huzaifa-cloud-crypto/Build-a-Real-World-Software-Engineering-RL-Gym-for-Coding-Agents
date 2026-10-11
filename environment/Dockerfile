FROM node:20-slim

# Install system dependencies for child process execution tests
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      bash \
      procps \
      curl \
      git \
    && rm -rf /var/lib/apt/lists/*

# Create workspace directory
WORKDIR /workspace

# Copy task instruction and public materials (model-facing)
COPY task/ /workspace/task/

# Copy lifecycle scripts
COPY app-setup/ /workspace/app-setup/
RUN chmod +x /workspace/app-setup/*.sh

# Copy evaluation suite (hidden from model, mounted at runtime)
COPY evaluation/ /workspace/evaluation/

# Copy root configuration
COPY package.json /workspace/package.json
COPY package-lock.json /workspace/package-lock.json

# Install root dependencies
RUN npm install --silent

# Build evaluation suite
RUN cd /workspace/evaluation && npm install --silent && npm run build

# The model's generated solution will be placed in /workspace/reference/
# and built via app-setup/build.sh
RUN mkdir -p /workspace/reference

# Default command: run the verifier against whatever is in reference/
CMD ["npm", "run", "score"]
