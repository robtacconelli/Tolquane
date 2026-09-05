# Coming from FastFlow and BBFlow

Tolquane keeps the vocabulary of the FastFlow building blocks, so the papers and the
BBFlow thesis read the same way here. What changed is the surface: a function is a
node, `>>` is a pipeline, a farm is one call.

--8<-- "DESIGN.md:mapping"

Every program in BBFlow's `src/tests` has a counterpart here; the table is in
[docs/bbflow-tests.md](https://github.com/robtacconelli/Tolquane/blob/main/docs/bbflow-tests.md).
The MSOM use case is ported faithfully, grid links and all, and its parallel map
equals the sequential one exactly.

What BBFlow could not do that Tolquane does: end of stream that cannot be lost or
raced, a deadlock that is reported instead of hung, ordered farms and on-demand
scheduling built in, feedback loops that close by rule, batching, processes, and a
distributed runtime that keeps backpressure across hosts. The
[design document](design.md) lists the twenty bugs and traps found in the Java code and
the rule that closes each one.
