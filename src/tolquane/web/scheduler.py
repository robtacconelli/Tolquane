"""The loop that fires Tolquane Web schedules when they come due.

One daemon thread wakes every ``interval`` seconds, asks the store which schedules there
are, and fires the enabled ones whose ``next_run`` has passed. The next time is written
to the store *before* ``fire`` is called, so a crash in ``fire``, or in the whole server,
cannot make a schedule fire twice; and the next time is computed from now rather than
from the missed one, so a laptop that was asleep for a week comes back to one run, not a
week of them.

``fire`` is the server's "start a run": it must return at once, and anything it raises is
logged and forgotten. The loop is the last thing that should stop.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from datetime import UTC, datetime
from types import TracebackType

from .cron import Cron
from .store import Schedule, Store

log = logging.getLogger(__name__)


def local_now() -> datetime:
    """Now, as an aware datetime in the machine's own zone: the clock cron thinks in."""
    return datetime.now().astimezone()


class Scheduler:
    """Fires due schedules through ``fire``.

    ``clock`` returns the current time and ``wakeup`` is the event the loop waits on, so
    a test can drive both without sleeping. The store is read on every pass, which keeps
    a second process's edits from going unnoticed; :meth:`reload` only wakes the loop so
    a schedule added a moment ago is picked up now rather than in a second.
    """

    def __init__(
        self,
        store: Store,
        fire: Callable[[Schedule], None],
        clock: Callable[[], datetime] = local_now,
        interval: float = 1.0,
        wakeup: threading.Event | None = None,
    ) -> None:
        self.store = store
        self.fire = fire
        self.clock = clock
        self.interval = interval
        self._wakeup = wakeup if wakeup is not None else threading.Event()
        self._stopping = threading.Event()
        self._thread: threading.Thread | None = None

    # The loop -----------------------------------------------------------

    def start(self) -> None:
        """Start the thread. Starting a running scheduler does nothing."""
        if self._thread is not None and self._thread.is_alive():
            return
        self._stopping.clear()
        self._thread = threading.Thread(target=self._loop, name="tolquane-scheduler", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        """Ask the thread to finish the pass it is in and join it. Safe to call twice."""
        self._stopping.set()
        self._wakeup.set()
        thread, self._thread = self._thread, None
        if thread is not None:
            thread.join(timeout)

    def reload(self) -> None:
        """Wake the loop now, after schedules changed."""
        self._wakeup.set()

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def __enter__(self) -> Scheduler:
        self.start()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.stop()

    def _loop(self) -> None:
        while not self._stopping.is_set():
            try:
                self.tick()
            except Exception:  # the loop outlives every mistake below it
                log.exception("scheduler pass failed")
            self._wakeup.wait(self.interval)
            self._wakeup.clear()

    # One pass -----------------------------------------------------------

    def tick(self, now: datetime | None = None) -> int:
        """One pass: fire what is due, write the next times, return how many fired.

        Public because it is also how tests and ``POST /api/schedules/{id}/run`` drive
        the scheduler by hand.
        """
        moment = now if now is not None else self.clock()
        if moment.tzinfo is None:
            moment = moment.astimezone()  # a naive clock means local time
        fired = 0
        for schedule in self.store.list_schedules():
            if not schedule.enabled:
                continue
            try:
                cron = Cron.parse(schedule.cron)
            except ValueError as exc:
                log.error(
                    "schedule %s has an unusable cron %r: %s", schedule.id, schedule.cron, exc
                )
                continue
            due = _due(schedule, moment)
            try:
                nxt = cron.next_after(moment)
            except ValueError as exc:
                log.error("schedule %s will never fire: %s", schedule.id, exc)
                continue
            if not due:
                if schedule.next_run is None:
                    self.store.update_schedule(schedule.id, next_run=nxt)
                continue
            # The store first: a schedule that has been picked up must not be picked up
            # again, whatever happens in fire.
            updated = self.store.update_schedule(schedule.id, next_run=nxt)
            fired += 1
            try:
                self.fire(updated)
            except Exception:
                log.exception("firing schedule %s (%s) failed", schedule.id, schedule.flow)
        return fired


def _due(schedule: Schedule, moment: datetime) -> bool:
    """Has this schedule's time passed? A schedule with no next time is not due: the
    first pass gives it one, so a schedule added while the server was down does not fire
    the moment it starts."""
    if schedule.next_run is None:
        return False
    try:
        planned = datetime.fromisoformat(schedule.next_run)
    except ValueError:
        log.error("schedule %s has an unreadable next_run %r", schedule.id, schedule.next_run)
        return False
    if planned.tzinfo is None:
        planned = planned.replace(tzinfo=UTC)
    return planned <= moment
