#!/usr/bin/env bash
# Change an agent safely: change the draft's instructions, save the draft as a version, compare it with live, publish
# it, then roll back. The workspace's HR assistant, GHT7YRWXPL, has the versions v12 and v13, with v13 live.
set -euo pipefail
# As a person sees it, on a terminal 100 columns wide (see output-formats.sh)
export CAITLYN_FORCE_TTY=100 CAITLYN_PAGER=cat CAITLYN_COLOR=never TERM=dumb CAITLYN_GLYPHS=unicode CAITLYN_DISPLAY_NOW=2026-11-06T09:00:00Z

# #region edit
# Read the draft's ETag, then change its instructions only if nobody has changed the draft since
etag=$(caitlyn agents draft get GHT7YRWXPL --jq .etag)
caitlyn agents draft update GHT7YRWXPL --if-match "$etag" \
  --set 'guidance.instructions=Answer from the HR policies, and quote the clause you relied on.' \
  --jq .configuration.guidance.instructions
# #endregion

echo "## save table"
# #region save
caitlyn agents draft save GHT7YRWXPL --name november-candidate --note "Quotes the policy clause it relied on."
# #endregion

echo "## compare table"
# #region compare
caitlyn agents versions compare GHT7YRWXPL@v13 --with-version november-candidate
# #endregion
echo "## compare json"
caitlyn agents versions compare GHT7YRWXPL@v13 --with-version november-candidate --output json

echo "## publish table"
# #region publish
# Publishing changes what everyone talking to the agent gets
caitlyn agents versions publish GHT7YRWXPL@november-candidate --expected-live v13 --note "Reviewed by HR" --yes
# #endregion

echo "## roll-back table"
# #region roll-back
# Roll back: publish the earlier version again
caitlyn agents versions publish GHT7YRWXPL@v13 --expected-live november-candidate --note "Back to v13" --yes
# #endregion

echo "## history table"
# #region history
caitlyn agents history list --agent GHT7YRWXPL
# #endregion
echo "## history json"
caitlyn agents history list --agent GHT7YRWXPL --output json

# The same steps again from the start, printing JSON, for the docs' output tabs. Writes can't run twice, so the mock
# goes back to where the example began.
curl -fsS -X POST "$CAITLYN_ENDPOINT/__mock/reset"
etag=$(caitlyn agents draft get GHT7YRWXPL --jq .etag)
caitlyn agents draft update GHT7YRWXPL --if-match "$etag" \
  --set 'guidance.instructions=Answer from the HR policies, and quote the clause you relied on.' --output json > /dev/null
echo "## save json"
caitlyn agents draft save GHT7YRWXPL --name november-candidate --note "Quotes the policy clause it relied on." --output json
echo "## publish json"
caitlyn agents versions publish GHT7YRWXPL@november-candidate --expected-live v13 --note "Reviewed by HR" --yes --output json
echo "## roll-back json"
caitlyn agents versions publish GHT7YRWXPL@v13 --expected-live november-candidate --note "Back to v13" --yes --output json
