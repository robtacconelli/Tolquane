import pytest

RUNTIMES = ["threads", "sync"]


@pytest.fixture(params=RUNTIMES)
def runtime(request: pytest.FixtureRequest) -> str:
    return str(request.param)
