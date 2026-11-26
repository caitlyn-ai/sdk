---
type: feat
scope: cli
commit: d653da1e
summary: usage data for Caitlyn, when you turn it on, is sent the way Caitlyn's intake takes it
---

- **Sent in small batches:** each request holds at most 100 events and 64 KB. A request Caitlyn can't accept is
  dropped rather than sent again, and one it can't take yet waits for next time. See
  [How usage data for Caitlyn is sent](/cli/telemetry/#how-usage-data-for-caitlyn-is-sent).
- **Told to stop, it stops:** if Caitlyn asks a version of the CLI to stop sending, it deletes what it queued and
  sends nothing more, `caitlyn telemetry status` says so, and `caitlyn telemetry on` starts it again. See
  [How usage data for Caitlyn is sent](/cli/telemetry/#how-usage-data-for-caitlyn-is-sent).
- **The exact time:** each event carries the time its run started, to the millisecond, in place of the hour. See
  [What is sent](/cli/telemetry/#what-is-sent).
