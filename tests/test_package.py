import pickle
from importlib.metadata import version

import tolquane


def test_version_matches_installed_metadata() -> None:
    assert tolquane.__version__ == version("tolquane")


def test_skip_is_a_singleton() -> None:
    assert repr(tolquane.SKIP) == "tolquane.SKIP"
    assert tolquane.SKIP is not None


def test_skip_survives_pickle_as_the_same_object() -> None:
    assert pickle.loads(pickle.dumps(tolquane.SKIP)) is tolquane.SKIP
