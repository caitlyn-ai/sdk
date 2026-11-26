# The Caitlyn CLI's container image, built by scripts/release-image.sh (the cli:image job) from the release's own
# linux archives: the binary in linux/<arch>/ is the one the release checksummed and signed, not a second build.
# It has a shell, so CI jobs can use it as their image and run `caitlyn` in their script:
#
#   image: ghcr.io/caitlyn-ai/caitlyn:0.12
#   script: [caitlyn apply -f caitlyn/ --yes]
#
# or run it directly: docker run --rm ghcr.io/caitlyn-ai/caitlyn:0.12 caitlyn version
FROM alpine:3.22
# curl and jq for the GitLab component's merge-request comment (integrations/gitlab/templates/diff.yml).
RUN apk add --no-cache ca-certificates curl jq \
 && adduser -D -u 10001 caitlyn
ARG TARGETARCH
COPY linux/${TARGETARCH}/caitlyn /usr/local/bin/caitlyn
# `caitlyn update` prints the newer image tag instead of replacing the binary (8.4).
ENV CAITLYN_INSTALL_METHOD=container
USER caitlyn
WORKDIR /home/caitlyn
CMD ["caitlyn", "--help"]
