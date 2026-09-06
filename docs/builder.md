# The AI builder

```
pip install "tolquane[ai]"
export ANTHROPIC_API_KEY=...         # or OPENAI_API_KEY with --provider openai
tolquane build "read urls.txt, fetch each with 8 workers, write url, status and size to status.csv"
```

The builder writes one short, commented `flow.py` in the [house style](style.md),
checks its wiring, runs it on the sync runtime with a sample it makes up or with
`--sample file`, fixes what fails, and then asks what to change. Claude Opus 5 is the
default; GPT works with `--provider openai`. The same loop is a function:

```python
from tolquane.ai import build
result = build("count words per line in log.txt, 8 workers", workdir="out")
print(result.summary)
```

The same builder is a panel in the GUI: `tolquane web`, then **AI builder** beside the
editor, with the open flow as its context (see the [user guide](web-user.md)).

Every flow the builder writes defines `build(source=None)`, which returns the graph and
swaps in `tq.from_iterable(source)` when a sample is given, and `main()`. That is what
`tolquane check`, `run`, `explain` and `draw` expect from any file.

Ten flows it wrote, unedited, with their transcripts, are in
[examples/generated](https://github.com/robtacconelli/Tolquane/tree/main/examples/generated);
none of the ten conversations had a tool error. Generated code runs on your machine in a
subprocess with a timeout. Keys are read from the environment and never stored.
