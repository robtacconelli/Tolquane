# Flows written by the builder

Each directory holds a `flow.py` written by `tolquane build` from the one-sentence
description below, unedited, plus `transcript.json`, the recorded conversation
(model text, tool calls, tool results). The builder checked and ran every flow before
finishing; `tests/test_generated_examples.py` checks and runs them again on every CI run.
Files the flows read (`sales.csv`, `app.log`, `records.jsonl`, `urls.txt`) are small
samples added by hand.

| Directory | Description given to the builder | Rounds | Tokens |
|---|---|---|---|
| `word_frequency` | count how often each word appears in a text, given as a multi-line string constant in the file, lowercase, ignoring punctuation, and print the ten most common words with their counts | 3 | 12,860 |
| `csv_region_totals` | read a CSV file sales.csv with columns region and amount, sum the amount per region using a farm where all rows of one region go to the same worker, and print one line per region sorted by region | 3 | 7,900 |
| `primes_in_order` | for the numbers from 2 to 20000, test each for primality on 8 workers, and print the primes in increasing order followed by how many there are | 4 | 20,176 |
| `log_error_counts` | read log lines from app.log (format: timestamp level module message), keep only ERROR lines, count errors per module, and print the modules with their counts, highest first | 4 | 40,150 |
| `dedupe_records` | read JSON records one per line from records.jsonl, each with an id field, drop later duplicates of the same id, and write the survivors to unique.jsonl in their original order | 2 | 6,332 |
| `fibonacci_ordered` | compute fibonacci(n) for n from 1 to 60 on 4 workers and print n and the value in input order | 2 | 4,019 |
| `row_normalize` | given a 200 by 50 matrix of random floats generated in the file with a fixed seed, split each row across 4 workers, divide every value by the row maximum, gather the row back in order, and print the first three normalized rows rounded to 3 decimals | 6 | 67,916 |
| `moving_average` | generate 100 random temperatures between 10 and 30 with a fixed seed, compute the moving average over a window of 5 readings, and print each reading with its moving average once the window is full | 3 | 6,078 |
| `newton_sqrt_feedback` | for each of the numbers 2, 3, 5, 7, 11, compute the square root with Newton's method where each iteration is one pass through a feedback loop: a worker refines the estimate, and the result is sent back until the change is below 1e-9, then printed with the number of iterations | 4 | 44,428 |
| `url_status_report` | read URLs one per line from urls.txt, fetch each with 8 workers using only the standard library with a 10 second timeout, and write a CSV status.csv with url, status code (or the error), and response size; also print how many succeeded | 3 | 12,994 |

All ten were built with Claude Opus 5 at effort `high`. No tool call returned an error
in any of the ten conversations: the extra rounds are the model reading an example or
re-running with a second sample. Tokens are input plus output as billed, cache reads
excluded.
