FROM node:20-slim

# System deps needed by the child-process execution tests.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      bash \
      procps \
      curl \
      git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# --- Model-facing assets only -------------------------------------------
# The private verifier (evaluation/) is deliberately NOT copied into this
# image. The agent works inside this sandbox, so baking the verifier in
# would hand it the answer key. Mount it at scoring time instead:
#   docker run -v "$PWD/evaluation:/workspace/evaluation" rl-gym-job-scheduler npm run score
COPY task/ /workspace/task/
COPY app-setup/ /workspace/app-setup/
COPY package.json /workspace/package.json
COPY package-lock.json* /workspace/
RUN chmod +x /workspace/app-setup/*.sh

# The agent's solution is written into /workspace/reference/. Ship the
# reference implementation so the image is self-verifying once the
# evaluation suite is mounted; the harness overwrites this directory.
COPY reference/ /workspace/reference/

RUN npm install --silent

# Build the solution. build.sh skips the verifier when it is not mounted.
RUN bash /workspace/app-setup/build.sh

# Idle sandbox by default: the agent runs its own commands in here.
CMD ["bash"]
