"""Fetch every URL in urls.txt on 8 workers and write url, status (or error) and size to status.csv."""

import csv
import urllib.error
import urllib.request

import tolquane as tq

URLS = "urls.txt"
OUT = "status.csv"
TIMEOUT = 10.0


@tq.source
def read_urls():
    # One URL per line; blank lines and # comments are dropped here.
    with open(URLS, encoding="utf-8") as f:
        for line in f:
            url = line.strip()
            if url and not url.startswith("#"):
                yield url


@tq.node
def fetch(url: str):
    # The slow, I/O bound stage, so this is what the farm multiplies.
    # A failed request is a result to record, not a crash, hence the except.
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT) as response:
            body = response.read()
            return (url, response.status, len(body))
    except urllib.error.HTTPError as exc:
        return (url, exc.code, len(exc.read()))
    except Exception as exc:  # timeout, DNS failure, bad URL
        return (url, f"{type(exc).__name__}: {exc}", 0)


@tq.sink
class WriteCsv:
    # Stateful and single: it owns the CSV file and the success counter.
    def on_start(self, ctx: tq.Context) -> None:
        self.file = open(OUT, "w", newline="", encoding="utf-8")
        self.writer = csv.writer(self.file)
        self.writer.writerow(["url", "status", "size"])
        self.ok = 0

    def __call__(self, row: tuple) -> None:
        url, status, size = row
        if isinstance(status, int) and 200 <= status < 400:
            self.ok += 1
        self.writer.writerow([url, status, size])

    def on_end(self, ctx: tq.Context) -> None:
        self.file.close()
        print(f"{self.ok} succeeded, results in {OUT}")


def build(source=None):
    start = tq.from_iterable(source) if source is not None else read_urls
    return start >> tq.farm(fetch, workers=8) >> WriteCsv


def main() -> None:
    # Threads: eight sockets waiting at once is exactly what threads are for.
    print(tq.run(build()))


if __name__ == "__main__":
    main()
