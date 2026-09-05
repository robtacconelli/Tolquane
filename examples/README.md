# Examples

Every file here follows [docs/style.md](../docs/style.md): small named nodes, one graph
line, a comment on each node. They are also what the AI builder reads to learn the
house style, so keep them short.

| File | Shows |
|---|---|
| `hello.py` | source, node, sink, an ordered farm |
| `word_count.py` | a generator node (flat map), a keyed farm with stateful class workers, `on_end` |
| `som.py` | the thesis use case: broadcast farm, custom emitter and collector, feedback loop |

Run one with `python examples/hello.py`.
