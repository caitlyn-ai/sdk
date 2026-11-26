# The agent evaluation's sandbox (the CLI design, 20.3): the CLI under test, the mock server, bash and jq, and nothing
# else. eval.mjs --executor docker --image <this image> starts one on an internal Docker network (no route out), runs
# each of the agent's commands in it with `docker exec`, and controls the mock the same way.
#
#   (cd cli && CGO_ENABLED=0 GOOS=linux go build -o ../build/cli/caitlyn ./cmd/caitlyn)
#   docker build -f cli/agent-eval/Dockerfile -t caitlyn-agent-eval .
FROM node:24.11.1-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash jq ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY build/cli/caitlyn /opt/caitlyn/bin/caitlyn
COPY conformance/mock-server/ /opt/caitlyn/conformance/mock-server/
COPY conformance/cases/examples.json /opt/caitlyn/conformance/cases/examples.json
ENV PORT=4010
CMD ["node", "/opt/caitlyn/conformance/mock-server/server.mjs"]
