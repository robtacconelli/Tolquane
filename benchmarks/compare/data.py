"""The data the application benchmarks read, fetched or generated deterministically.

    python benchmarks/compare/data.py [DIR]     # default /mnt/1T/home/st4ck/.cache/data

- enwik8: the first 100 MB of Wikipedia, from mattmahoney.net
  (md5 a1fa5ffddb56f4953e226637dabbb36a)
- sales.csv: 10,000,000 rows `region,product,amount` from a fixed seed
- matrix.bin: 20,000 x 1,000 float32, row-major, from a fixed seed
  (matrix.npy is the same data for numpy)
"""

from __future__ import annotations

import hashlib
import random
import sys
import urllib.request
import zipfile
from pathlib import Path

ENWIK8_MD5 = "a1fa5ffddb56f4953e226637dabbb36a"
REGIONS = ["north", "south", "east", "west", "centre", "coast", "hills", "islands"]
ROWS = 10_000_000
MATRIX = (20_000, 1_000)


def enwik8(root: Path) -> Path:
    target = root / "enwik8"
    if not target.exists():
        zipped = root / "enwik8.zip"
        urllib.request.urlretrieve("http://mattmahoney.net/dc/enwik8.zip", zipped)
        zipfile.ZipFile(zipped).extractall(root)
        zipped.unlink()
    digest = hashlib.md5(target.read_bytes()).hexdigest()
    if digest != ENWIK8_MD5:
        raise SystemExit(f"{target}: md5 {digest}, expected {ENWIK8_MD5}")
    return target


def sales(root: Path) -> Path:
    target = root / "sales.csv"
    if target.exists() and target.stat().st_size > 300_000_000:
        return target
    rng = random.Random(20260907)
    with target.open("w", encoding="ascii", newline="\n") as f:
        f.write("region,product,amount\n")
        chunk: list[str] = []
        for _ in range(ROWS):
            region = REGIONS[rng.randrange(8)]
            amount = rng.randrange(100, 100000) / 100
            chunk.append(f"{region},{rng.randrange(1, 1001)},{amount:.2f}\n")
            if len(chunk) == 100_000:
                f.write("".join(chunk))
                chunk = []
        f.write("".join(chunk))
    return target


def matrix(root: Path) -> Path:
    import numpy as np

    raw = root / "matrix.bin"
    npy = root / "matrix.npy"
    if not (raw.exists() and npy.exists()):
        data = np.random.RandomState(20260907).standard_normal(MATRIX).astype(np.float32)
        data.tofile(raw)
        np.save(npy, data)
    return raw


def main() -> int:
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/mnt/1T/home/st4ck/.cache/data")
    root.mkdir(parents=True, exist_ok=True)
    for make in (enwik8, sales, matrix):
        path = make(root)
        print(f"{path.name}: {path.stat().st_size:,} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
