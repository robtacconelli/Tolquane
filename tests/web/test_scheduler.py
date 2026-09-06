"""The scheduler loop: what fires, when, once, and what it survives."""

from __future__ import annotations

import logging
import threading
from collections.abc import Iterator
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from tolquane.web.scheduler import Scheduler, local_now
from tolquane.web.store import Schedule, Store

ROME = ZoneInfo("Europe/Rome")


class Clock:
    """A clock the test moves by hand, so no test ever sleeps."""

    def __init__(self, start: datetime) -> None:
        self.now = start

    def __call__(self) -> datetime:
        return self.now

    def advance(self, **fields: float) -> datetime:
        self.now += timedelta(**fields)
        return self.now


class Fires:
    """A ``fire`` that remembers what it was given, and can be told to raise."""

    def __init__(self, raises: bool = False) -> None:
        self.seen: list[Schedule] = []
        self.raises = raises
        self.rang = threading.Event()

    def __call__(self, schedule: Schedule) -> None:
        self.seen.append(schedule)
        self.rang.set()
        if self.raises:
            raise RuntimeError("the supervisor is not there")


@pytest.fixture
def store(tmp_path: Path) -> Iterator[Store]:
    with Store(tmp_path / "web.db") as opened:
        yield opened


@pytest.fixture
def clock() -> Clock:
    return Clock(datetime(2026, 9, 6, 9, 0, tzinfo=ROME))


def test_the_first_pass_only_writes_the_next_time(store: Store, clock: Clock) -> None:
    schedule = store.add_schedule("hello.py", "*/15 * * * *")
    fires = Fires()
    assert Scheduler(store, fires, clock=clock).tick() == 0
    assert fires.seen == []
    stored = store.get_schedule(schedule.id)
    assert stored is not None
    assert stored.next_run is not None
    assert datetime.fromisoformat(stored.next_run) == datetime(2026, 9, 6, 9, 15, tzinfo=ROME)


def test_a_due_schedule_fires_exactly_once(store: Store, clock: Clock) -> None:
    schedule = store.add_schedule("hello.py", "*/15 * * * *")
    fires = Fires()
    scheduler = Scheduler(store, fires, clock=clock)
    scheduler.tick()
    clock.advance(minutes=15)
    assert scheduler.tick() == 1
    assert [(s.id, s.flow) for s in fires.seen] == [(schedule.id, "hello.py")]
    assert scheduler.tick() == 0  # the same minute does not come round twice
    assert scheduler.tick() == 0
    assert len(fires.seen) == 1


def test_it_fires_once_per_due_minute(store: Store, clock: Clock) -> None:
    store.add_schedule("hello.py", "* * * * *")
    fires = Fires()
    scheduler = Scheduler(store, fires, clock=clock)
    fired_at = []
    for _ in range(21):  # ten minutes, two passes a minute
        if scheduler.tick():
            fired_at.append(clock.now)
        clock.advance(seconds=30)
    assert len(fires.seen) == 10
    assert fired_at == [datetime(2026, 9, 6, 9, minute, tzinfo=ROME) for minute in range(1, 11)]


def test_the_next_time_is_in_the_store_before_fire_runs(store: Store, clock: Clock) -> None:
    schedule = store.add_schedule("hello.py", "*/15 * * * *")
    seen_next: list[str | None] = []

    def fire(fired: Schedule) -> None:
        stored = store.get_schedule(schedule.id)
        assert stored is not None
        seen_next.append(stored.next_run)
        assert fired.next_run == stored.next_run

    scheduler = Scheduler(store, fire, clock=clock)
    scheduler.tick()
    clock.advance(minutes=15)
    scheduler.tick()
    assert [datetime.fromisoformat(when or "") for when in seen_next] == [
        datetime(2026, 9, 6, 9, 30, tzinfo=ROME)  # written as UTC, the same instant
    ]
    assert seen_next[0] is not None
    assert seen_next[0].endswith("+00:00")


def test_a_backlog_of_missed_runs_becomes_one_run(store: Store, clock: Clock) -> None:
    schedule = store.add_schedule("hello.py", "*/15 * * * *")
    fires = Fires()
    scheduler = Scheduler(store, fires, clock=clock)
    scheduler.tick()
    clock.advance(days=3)  # the laptop was shut
    assert scheduler.tick() == 1
    assert len(fires.seen) == 1
    stored = store.get_schedule(schedule.id)
    assert stored is not None
    assert stored.next_run is not None
    assert datetime.fromisoformat(stored.next_run) == datetime(2026, 9, 9, 9, 15, tzinfo=ROME)
    assert scheduler.tick() == 0


def test_a_fire_that_raises_does_not_stop_the_others_or_the_next_minute(
    store: Store, clock: Clock, caplog: pytest.LogCaptureFixture
) -> None:
    store.add_schedule("first.py", "* * * * *")
    store.add_schedule("second.py", "* * * * *")
    fires = Fires(raises=True)
    scheduler = Scheduler(store, fires, clock=clock)
    scheduler.tick()
    with caplog.at_level(logging.ERROR, logger="tolquane.web.scheduler"):
        clock.advance(minutes=1)
        assert scheduler.tick() == 2
        assert [s.flow for s in fires.seen] == ["first.py", "second.py"]
        clock.advance(minutes=1)
        assert scheduler.tick() == 2
    assert len(fires.seen) == 4
    assert "firing schedule 1 (first.py) failed" in caplog.text
    assert "firing schedule 2 (second.py) failed" in caplog.text


def test_a_disabled_schedule_is_left_alone(store: Store, clock: Clock) -> None:
    schedule = store.add_schedule("hello.py", "* * * * *", enabled=False)
    fires = Fires()
    scheduler = Scheduler(store, fires, clock=clock)
    scheduler.tick()
    clock.advance(minutes=5)
    assert scheduler.tick() == 0
    stored = store.get_schedule(schedule.id)
    assert stored is not None
    assert stored.next_run is None
    store.update_schedule(schedule.id, enabled=True)
    scheduler.tick()  # enabling it gives it a time again
    clock.advance(minutes=1)
    assert scheduler.tick() == 1


def test_an_unusable_cron_is_logged_and_the_rest_still_fire(
    store: Store, clock: Clock, caplog: pytest.LogCaptureFixture
) -> None:
    store.add_schedule("broken.py", "every friday")
    store.add_schedule("fine.py", "* * * * *")
    fires = Fires()
    scheduler = Scheduler(store, fires, clock=clock)
    with caplog.at_level(logging.ERROR, logger="tolquane.web.scheduler"):
        scheduler.tick()
        clock.advance(minutes=1)
        assert scheduler.tick() == 1
    assert [s.flow for s in fires.seen] == ["fine.py"]
    assert "unusable cron 'every friday'" in caplog.text


def test_a_cron_that_can_never_match_is_logged(
    store: Store, clock: Clock, caplog: pytest.LogCaptureFixture
) -> None:
    store.add_schedule("never.py", "0 0 30 2 *")
    fires = Fires()
    with caplog.at_level(logging.ERROR, logger="tolquane.web.scheduler"):
        assert Scheduler(store, fires, clock=clock).tick() == 0
    assert "will never fire" in caplog.text
    assert fires.seen == []


def test_a_schedule_deleted_between_passes_is_forgotten(store: Store, clock: Clock) -> None:
    schedule = store.add_schedule("hello.py", "* * * * *")
    fires = Fires()
    scheduler = Scheduler(store, fires, clock=clock)
    scheduler.tick()
    store.delete_schedule(schedule.id)
    clock.advance(minutes=5)
    assert scheduler.tick() == 0
    assert fires.seen == []


def test_a_naive_clock_is_read_as_local_time(store: Store) -> None:
    store.add_schedule("hello.py", "* * * * *")
    naive = Clock(datetime(2026, 9, 6, 9, 0))
    fires = Fires()
    scheduler = Scheduler(store, fires, clock=naive)
    scheduler.tick()
    naive.advance(minutes=1)
    assert scheduler.tick() == 1


def test_tick_can_be_given_the_moment(store: Store, clock: Clock) -> None:
    store.add_schedule("hello.py", "* * * * *")
    fires = Fires()
    scheduler = Scheduler(store, fires, clock=clock)
    scheduler.tick(datetime(2026, 9, 6, 9, 0, tzinfo=ROME))
    assert scheduler.tick(datetime(2026, 9, 6, 9, 30, tzinfo=ROME)) == 1


def test_local_now_is_aware() -> None:
    assert local_now().tzinfo is not None


# The thread --------------------------------------------------------------


def test_the_thread_fires_when_reload_wakes_it(store: Store, clock: Clock) -> None:
    schedule = store.add_schedule("hello.py", "* * * * *")
    fires = Fires()
    wakeup = threading.Event()
    # A long interval: only the event can wake the loop, so the test cannot pass by luck.
    scheduler = Scheduler(store, fires, clock=clock, interval=60.0, wakeup=wakeup)
    scheduler.tick()
    scheduler.start()
    try:
        assert scheduler.running
        clock.advance(minutes=2)
        scheduler.reload()
        assert fires.rang.wait(5), "the loop did not fire when it was woken"
    finally:
        scheduler.stop()
    assert [s.id for s in fires.seen] == [schedule.id]
    assert not scheduler.running


def test_the_thread_fires_on_its_own_interval(store: Store, clock: Clock) -> None:
    store.add_schedule("hello.py", "* * * * *")
    fires = Fires()
    scheduler = Scheduler(store, fires, clock=clock, interval=0.01)
    scheduler.tick()
    clock.advance(minutes=1)
    with scheduler:
        assert fires.rang.wait(5), "the loop never came round"
    assert not scheduler.running


def test_starting_twice_leaves_one_thread_and_stopping_twice_is_safe(
    store: Store, clock: Clock
) -> None:
    scheduler = Scheduler(store, Fires(), clock=clock, interval=0.01)
    scheduler.start()
    scheduler.start()
    try:
        assert sum(t.name == "tolquane-scheduler" for t in threading.enumerate()) == 1
    finally:
        scheduler.stop()
        scheduler.stop()
    assert not scheduler.running
    scheduler.start()  # and it can be started again
    scheduler.stop()


def test_a_pass_that_blows_up_does_not_kill_the_loop(
    store: Store, clock: Clock, caplog: pytest.LogCaptureFixture
) -> None:
    fires = Fires()
    scheduler = Scheduler(store, fires, clock=clock, interval=0.01)
    passes = threading.Event()
    real_list = store.list_schedules
    calls = 0

    def explode(flow: str | None = None) -> list[Schedule]:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise sqlite_gone()
        passes.set()
        return real_list(flow)

    def sqlite_gone() -> Exception:
        return RuntimeError("the database went away")

    store.list_schedules = explode  # type: ignore[method-assign]
    try:
        with caplog.at_level(logging.ERROR, logger="tolquane.web.scheduler"), scheduler:
            assert passes.wait(5), "the loop stopped at the first failure"
    finally:
        store.list_schedules = real_list  # type: ignore[method-assign]
    assert "scheduler pass failed" in caplog.text
