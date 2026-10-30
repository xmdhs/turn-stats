# turn-stats

A Claude Code plugin that appends per-turn statistics to the closing line. It reports output throughput, cache hit percentage, context remaining, elapsed turn duration, and the completion time. Output throughput includes the local wait from the start of each model request until its stop event, including time before the first response chunk. It does not change the existing UI layout.

## Install in Claude Code

At a Claude Code terminal prompt:

```text
/plugin install turn-stats --marketplace xmdhs/turn-stats
```

From a shell:

```bash
claude plugin install turn-stats --marketplace xmdhs/turn-stats
```

In the desktop app, open **Plugins**, choose **Add marketplace**, enter `xmdhs/turn-stats`, then add the `turn-stats` plugin.
