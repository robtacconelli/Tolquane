# BBFlow programs and where they live in Tolquane

Every program under BBFlow's `src/tests` and what reproduces it here. "Test" means a
pytest case that runs on both the threads and the sync runtime and asserts the result.

| BBFlow program | What it exercises | Tolquane |
|---|---|---|
| `manual_examples` (Code 16, 17) | two nodes, manual channel / pipeline | `examples/hello.py`, `tests/test_run.py::test_hello_world` |
| `manual_examples` (Code 21, 22) | custom emitter and collector on a blank farm | `tests/test_bbflow_ports.py::test_manual_examples_custom_ends_on_a_blank_farm` |
| `myjob` | a node that reads and writes channels by hand | `tests/test_bbflow_ports.py::test_myjob_manual_channel_loop` |
| `pipeline_farm_node` (Code 20) | generator, farm, filter | `tests/test_bbflow_ports.py::test_pipeline_farm_node` |
| `sumTestInline` | stateful workers, four inputs | `tests/test_bbflow_ports.py::test_sum_test_inline` |
| `farmInline`, `pipelineInline` | stateful workers, first-come collector, summing sink, bounded queues | `tests/test_bbflow_ports.py::test_farm_inline_and_pipeline_inline` |
| `complete_farm_test`, `complete_farm_testWorker`, `complete_farm_testOutnode`, `time_testing` | running-sum workers, out node, capacity 16 | `tests/test_bbflow_ports.py::test_complete_farm_test_and_time_testing` |
| `ff_tests/combine` | five-stage pipeline vs. fused pairs | `tests/test_bbflow_ports.py::test_combine_pipeline_and_fused_variants_agree` |
| `ff_tests/combine2` | fused workers, custom emitter routing, collector seeing sources | `tests/test_bbflow_ports.py::test_combine2` |
| `ff_tests/combine2_multi` | broadcast inside a fused node | `tests/test_bbflow_ports.py::test_combine2_multi_broadcast_inside_comb` |
| `ff_tests/combine2_benchmark` | fused workers with a filtering second stage | `tests/test_bbflow_ports.py::test_combine2_benchmark_shape_matches_sequential` |
| `ff_tests/combine3` | one fused node as collector of farm 1 and emitter of farm 2 | `tests/test_bbflow_ports.py::test_combine3_comb_as_collector_and_next_emitter` |
| `ff_tests/combine6` | fused nodes before and after a farm | `tests/test_bbflow_ports.py::test_combine6_fused_ends_around_a_farm` |
| `ff_tests/ordered_farm_RR` | round-robin emitter and collector keep order | `tests/test_bbflow_ports.py::test_ordered_farm_rr_round_robin_both_ends` |
| `ff_tests/ordered_farm_labeling` | packet ids reordered after a first-come collector; also `ordered=True` | `tests/test_bbflow_ports.py::test_ordered_farm_labeling_manual_and_builtin` |
| `ff_tests/all2all` | self-fed workers into collectors, all to all | `tests/test_all2all.py::test_thesis_all2all_generators_to_sinks` |
| `ff_tests/all2all2` | routers to even/odd accumulators | `tests/test_all2all.py::test_thesis_all2all2_router_farms` |
| `ff_tests/all2all3` | the same with a generator as emitter | `tests/test_bbflow_ports.py::test_all2all3` |
| `ff_tests/all2all4` | two all-to-alls joined N-N | `tests/test_all2all.py::test_thesis_all2all4_two_all2alls_in_pipeline` |
| `ff_tests/all2all5` | farm without collector into an all-to-all | `tests/test_all2all.py::test_thesis_all2all5_farm_without_collector_into_all2all` |
| `ff_tests/all2all6` | farm with collector into an all-to-all (1-1) | `tests/test_bbflow_ports.py::test_all2all6_farm_with_collector_into_all2all` |
| `ff_tests/all2all7` | multi-output collector into workers (1xN) | `tests/test_all2all.py::test_thesis_all2all7_multi_output_collector_into_workers` |
| `ff_tests/all2all8` | feedback over an all-to-all with explicit stop | `tests/test_feedback.py::test_thesis_all2all8_feedback_over_all2all` |
| `benchmarks/benchmark_blocking`, `benchmark_pipeline` | two-node and N-stage pipelines | `benchmarks/pipeline2.py`, `tests/test_bbflow_ports.py::test_benchmark_pipeline_shape`, `::test_benchmark_blocking_and_farm_shapes` |
| `benchmarks/benchmark_farm`, `benchmark_farm_sequential` | farm scalability against a sequential baseline | `benchmarks/farm_scaling.py`, `tests/test_bbflow_ports.py::test_benchmark_blocking_and_farm_shapes` |
| `MSOM/*` (`SOM`, `Emitter`, `Collector`, `MSOM`, `SOMData`, `bestPosition`, `test_MSOM`, `MSOM_real_usage`, `SOM_sequential`) | grid of slices linked to their neighbours, search/learn protocol with redirects and acknowledgements, feedback to the emitter, sequential reference | `examples/msom.py`, `tests/test_msom.py` (the parallel map equals the sequential map exactly, across slice borders) |
| `networkTest` | farm with round-robin ends, TCP channel, out node on another host | `tests/test_net.py::test_network_test_farm_then_tcp_then_out_node` |
| `pipeline_network` | two nodes on two hosts | `tests/test_net.py::test_pipeline_network`, `::test_cli_run_with_deploy` |
| `ff_tests/combine2_network_feedback` | the last stage sends its items back over TCP | `tests/test_net.py::test_combine2_network_feedback_shape` |
| `benchmarks/distributed/benchmark_network` | a stream of integers over one channel | `benchmarks/network_pipeline.py`, `tests/test_net.py::test_benchmark_network_two_nodes_batched` |
| `benchmarks/distributed/benchmark_network_farm` | emitter and collector on one host, workers on another | `benchmarks/network_farm.py`, `tests/test_net.py::test_benchmark_network_farm_shape_workers_on_another_host` |

Not ported on purpose: `preloader` (JVM warm-up), `customWatch` (replaced by the run
report), and the `bb_settings` toggles for blocking or bounded queues (every Tolquane
channel is blocking and bounded by default).
