# House style for Tolquane flows

Every example in this repository, and every flow the AI builder writes, follows these
rules. The point is that a reader sees the whole flow at a glance.

1. **One file, one flow.** A module docstring says what the flow does in one sentence.
2. **Small named functions.** One per node, four to ten lines, named after what they do
   (`fetch`, `keep_ok`, `write_title`), decorated with `@tq.source`, `@tq.node` or
   `@tq.sink`. No lambdas in the graph line except for trivial arithmetic.
3. **A comment on every node** saying what it does and, when it matters, why it is a
   separate node (I/O bound, needs state, must run in order).
4. **The graph is one line** with `>>`, right after the nodes, assigned to `graph` or
   passed straight to `tq.run`.
5. **`tq.SKIP` for filters**, never `return None`; `None` travels.
6. **Classes only for state.** A node that accumulates or holds a connection is a class
   with `__call__`, and `on_end` for flushing.
7. **Explicit runtimes.** `tq.run(graph)` for threads; say `runtime="processes"` or a
   deploy file when that is the intent. Say why in a comment.
8. **Errors are the framework's job.** No `try/except` around the graph; let `NodeError`
   name the node.
9. **A `main()` guarded by `if __name__ == "__main__":`** so the flow is importable and
   testable with `tq.from_iterable` and `tq.to_list`.
10. **Twenty lines of logic is a lot.** If a flow grows past that, split nodes into a
    module and keep the graph file short.
