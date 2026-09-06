"""What happens after a scheduled run ends: the next attempt, and the news.

Two things live here, and they are the two halves of the contract's "schedule outcomes".

:class:`Notifier` delivers. A webhook is one ``POST`` of JSON with a ten second timeout
and one retry half a minute later; an email is ``smtplib`` with STARTTLS when the
settings ask for it. Every attempt, sent or failed, becomes a row in the ``notifications``
table, so the run page can say what was tried and what came of it. Delivery never happens
on the thread that reaped the child: :meth:`Notifier.deliver_later` hands the work to a
daemon thread, because a mail server that is not answering must not hold up a run's own
bookkeeping, let alone the supervisor.

:class:`Outcomes` decides. It is the supervisor's ``on_finish``: it works out which
schedule a run belonged to and which attempt it was, starts the next attempt after
``retry_delay`` when the run failed and attempts remain, and tells the notifier once, at
the end of the chain, with the final status and how many attempts it took.

Nothing here reaches into the supervisor: starting a run is a callback the server passes
in, which is what keeps the retry chain testable without a child process.
"""

from __future__ import annotations

import contextlib
import json
import logging
import smtplib
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field
from email.message import EmailMessage
from typing import Any

import tolquane as tq

from .settings import WebSettings
from .store import Run, Schedule, Store

log = logging.getLogger(__name__)

WEBHOOK_TIMEOUT = 10.0
"""Seconds a webhook has to answer. A receiver that is slower than this is down."""

WEBHOOK_RETRY_AFTER = 30.0
"""How long before the one retry. One, not many: this is news, not a queue."""

LOG_TAIL = 2048
"""Bytes of the run's log the message carries. Enough to see the traceback that ended it."""

TEST_EVENT = "test"
"""The ``event`` of the message ``POST /api/schedules/{id}/test`` sends."""


@dataclass(frozen=True)
class Target:
    """One place a message goes: a URL, or an address."""

    channel: str
    target: str


@dataclass(frozen=True)
class Delivery:
    """What came of one target: exactly the shape the test route answers with."""

    channel: str
    target: str
    status: str
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "channel": self.channel,
            "target": self.target,
            "status": self.status,
            "error": self.error,
        }


@dataclass(frozen=True)
class Outcome:
    """The news itself: how a run ended, after how many attempts, and for which schedule."""

    event: str
    run: Run
    schedule: Schedule | None = None
    attempts: int = 1

    @property
    def status(self) -> str:
        return self.run.status


def targets_of(notify: dict[str, Any], default_webhook: str | None) -> list[Target]:
    """Where a schedule's messages go: its webhook or the default, and its addresses."""
    url = notify.get("webhook") or default_webhook
    found = [Target("webhook", str(url))] if url else []
    found += [Target("email", str(address)) for address in notify.get("emails") or []]
    return found


def wants(notify: dict[str, Any], event: str) -> bool:
    """Is this one of the ends the schedule asked to be told about?"""
    return event in (notify.get("events") or [])


def log_tail(text: str, limit: int = LOG_TAIL) -> str:
    """The last ``limit`` bytes of a log, cut on a character boundary."""
    data = (text or "").encode("utf-8", "replace")
    if len(data) <= limit:
        return text or ""
    return data[-limit:].decode("utf-8", "ignore")


def base_url(host: str, port: int) -> str:
    """The address a person would type to reach this server, for the link in the message."""
    reachable = "127.0.0.1" if host in ("0.0.0.0", "::", "") else host
    bracket = f"[{reachable}]" if ":" in reachable else reachable
    return f"http://{bracket}:{port}"


def message_of(outcome: Outcome, url_base: str) -> dict[str, Any]:
    """The JSON body of a webhook, and the facts an email repeats in words.

    The run comes as ``Run.to_dict()`` with its log left out: the tail is here under
    ``log_tail``, and a receiver has no use for sixty-four kilobytes of it twice.
    """
    report = outcome.run.report or {}
    busiest = report.get("busiest") if isinstance(report, dict) else None
    return {
        "event": outcome.event,
        "status": outcome.status,
        "attempts": outcome.attempts,
        "flow": outcome.run.flow,
        "schedule": (
            {"id": outcome.schedule.id, "cron": outcome.schedule.cron}
            if outcome.schedule is not None
            else None
        ),
        "run": {**outcome.run.to_dict(), "log": ""},
        "busiest": list(busiest) if isinstance(busiest, list) else [],
        "error": outcome.run.error,
        "log_tail": log_tail(outcome.run.log),
        "url": f"{url_base}/runs/{outcome.run.id}",
    }


def email_body(body: dict[str, Any]) -> str:
    """The same facts as the webhook, as the plain text an email carries."""
    lines = [
        f"{body['flow']} ended {body['status']} after {body['attempts']} attempt(s).",
        "",
        f"Run:      {body['run']['id']} ({body['run']['trigger']})",
        f"Started:  {body['run']['started']}",
        f"Ended:    {body['run']['ended'] or 'not recorded'}",
    ]
    if body["schedule"] is not None:
        lines.append(f"Schedule: {body['schedule']['id']} ({body['schedule']['cron']})")
    if body["busiest"]:
        lines.append(f"Busiest:  {', '.join(body['busiest'])}")
    if body["error"]:
        lines.append(f"Error:    {body['error']}")
    lines += ["", body["url"], ""]
    if body["log_tail"]:
        lines += ["The end of the log:", "", body["log_tail"]]
    return "\n".join(lines)


class Notifier:
    """Delivers a run's outcome and records every attempt.

    ``opener`` and ``smtp_factory`` are the two seams a test needs: the first stands in
    for ``urllib.request.urlopen``, the second for ``smtplib.SMTP``. Both are looked up
    when they are used rather than kept as defaults, so monkeypatching either module
    works as well as passing a fake in.
    """

    def __init__(
        self,
        store: Store,
        web: WebSettings,
        *,
        url_base: str = "http://127.0.0.1:8765",
        timeout: float = WEBHOOK_TIMEOUT,
        retry_after: float = WEBHOOK_RETRY_AFTER,
        opener: Callable[..., Any] | None = None,
        smtp_factory: Callable[..., Any] | None = None,
    ) -> None:
        self.store = store
        self.web = web
        self.url_base = url_base
        self.timeout = timeout
        self.retry_after = retry_after
        self.opener = opener
        self.smtp_factory = smtp_factory

    # Sending -------------------------------------------------------------

    def deliver(self, outcome: Outcome, *, retry: bool = True) -> list[Delivery]:
        """Send this outcome everywhere the schedule asks, and record what happened.

        Blocks until every target has answered or failed, which is what the test route
        wants; the run's own notification goes through :meth:`deliver_later` instead.
        """
        notify = outcome.schedule.notify if outcome.schedule is not None else {}
        body = message_of(outcome, self.url_base)
        results = []
        for target in targets_of(notify, self.web.webhook_default):
            results.append(self._one(target, outcome, body, retry=retry))
        return results

    def deliver_later(self, outcome: Outcome) -> threading.Thread:
        """The same, on a daemon thread, so the reaper never waits for a mail server."""
        worker = threading.Thread(
            target=self._quietly,
            args=(outcome,),
            name=f"tolquane-notify-{outcome.run.id}",
            daemon=True,
        )
        worker.start()
        return worker

    def _quietly(self, outcome: Outcome) -> None:
        try:
            self.deliver(outcome)
        except Exception:  # pragma: no cover - a notification must not kill its thread
            log.exception("could not deliver the outcome of run %s", outcome.run.id)

    def _one(
        self, target: Target, outcome: Outcome, body: dict[str, Any], *, retry: bool
    ) -> Delivery:
        error = self._attempt(target, outcome, body)
        if error is not None and retry and target.channel == "webhook":
            # One retry, half a minute later: a receiver restarting is the usual reason a
            # first POST fails, and it is back by then or it is not coming back.
            if self.retry_after > 0:
                time.sleep(self.retry_after)
            error = self._attempt(target, outcome, body)
        return Delivery(target.channel, target.target, "failed" if error else "sent", error)

    def _attempt(self, target: Target, outcome: Outcome, body: dict[str, Any]) -> str | None:
        """One try at one target, recorded whichever way it went. Returns the failure."""
        error: str | None = None
        try:
            if target.channel == "webhook":
                self.send_webhook(target.target, body)
            else:
                self.send_email(target.target, body)
        except Exception as exc:
            error = _reason(exc)
        self.store.add_notification(
            target.channel,
            target.target,
            "failed" if error else "sent",
            # A test message may describe a placeholder run (id 0), which is no run at all.
            run_id=outcome.run.id or None,
            schedule_id=outcome.schedule.id if outcome.schedule is not None else None,
            error=error,
        )
        return error

    def send_webhook(self, url: str, body: dict[str, Any]) -> None:
        """One ``POST`` of JSON. Anything but a 2xx raises, and so becomes a failed row."""
        # The URL was checked when it was saved: http(s) only, and never a file.
        request = urllib.request.Request(
            url,
            data=json.dumps(body, default=str).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "User-Agent": f"tolquane/{tq.__version__}",
            },
            method="POST",
        )
        opener = self.opener or urllib.request.urlopen
        with opener(request, timeout=self.timeout) as answer:
            code = int(getattr(answer, "status", 0) or 0)
        if code and not 200 <= code < 300:  # pragma: no cover - urllib raises for these
            raise OSError(f"the webhook answered {code}")

    def send_email(self, address: str, body: dict[str, Any]) -> None:
        """One message through the configured SMTP server. No settings is a failure."""
        smtp = self.web.smtp
        if not smtp:
            raise ValueError(
                "there are no SMTP settings: fill in notifications.smtp on the settings "
                "page, or use a webhook instead"
            )
        message = EmailMessage()
        message["Subject"] = f"[Tolquane] {body['flow']}: {body['status']}"
        message["From"] = smtp.get("from") or f"tolquane@{smtp['host']}"
        message["To"] = address
        message.set_content(email_body(body))
        factory = self.smtp_factory or smtplib.SMTP
        server = factory(smtp["host"], int(smtp.get("port") or 25), timeout=self.timeout)
        try:
            if smtp.get("starttls"):
                server.starttls()
            username, password = smtp.get("username"), self.web.smtp_password
            if username and password:
                server.login(username, password)
            server.send_message(message)
        finally:
            # A server that has already gone leaves nothing to close politely.
            with contextlib.suppress(Exception):
                server.quit()


def _reason(exc: BaseException) -> str:
    """One line saying why a delivery failed, without a traceback nobody asked for."""
    if isinstance(exc, urllib.error.HTTPError):
        return f"the webhook answered {exc.code} {exc.reason}"
    if isinstance(exc, urllib.error.URLError):
        return f"could not reach it: {exc.reason}"
    text = str(exc).strip()
    return text or type(exc).__name__


# ------------------------------------------------------------------- the retry chain


def attempt_of(trigger: str) -> tuple[int, int] | None:
    """The schedule and the attempt a run belongs to, from its trigger.

    ``schedule:7`` is the first attempt of schedule 7; ``retry:7:2`` is its second.
    Anything else -- a manual run, an API run -- is nobody's chain and answers ``None``.
    """
    parts = (trigger or "").split(":")
    try:
        if len(parts) == 2 and parts[0] == "schedule":
            return int(parts[1]), 1
        if len(parts) == 3 and parts[0] == "retry":
            return int(parts[1]), max(1, int(parts[2]))
    except ValueError:
        return None
    return None


def retry_trigger(schedule_id: int, attempt: int) -> str:
    return f"retry:{schedule_id}:{attempt}"


StartRun = Callable[[Schedule, str], Run]
"""How a retry is started: the server's own "run this schedule", with a trigger."""


@dataclass
class Outcomes:
    """The supervisor's ``on_finish``: retry a failed scheduled run, then tell somebody.

    A run that ended is looked up against its schedule. While attempts remain and the
    end was ``failed`` or ``deadlock``, a timer starts the next one after ``retry_delay``
    and nothing is sent; a run that has run out of attempts, or that ended any other way,
    ends the chain: the schedule's ``last_outcome`` is written and the notifier is given
    the final status and the number of attempts.

    ``sleeper`` is the seam for the delay -- a ``threading.Timer`` in the server, a
    direct call in a test that does not want to wait a minute for a retry.
    """

    store: Store
    notifier: Notifier
    start_run: StartRun
    sleeper: Callable[[float, Callable[[], None]], None] | None = None
    timers: set[threading.Timer] = field(default_factory=set)
    closed: bool = False

    def finished(self, run: Run) -> None:
        """One run has ended. Called from the thread that reaped it, so it must not block."""
        found = attempt_of(run.trigger)
        if found is None:
            return
        schedule_id, attempt = found
        self.store.update_schedule(schedule_id, last_status=run.status)
        schedule = self.store.get_schedule(schedule_id)
        if schedule is None:  # the schedule was deleted while its run was going
            return
        if run.status in ("failed", "deadlock") and attempt <= schedule.retries:
            self._outcome(schedule, run.status, attempt, notified=False)
            self._later(schedule, attempt + 1)
            return
        told = wants(schedule.notify, run.status) and bool(
            targets_of(schedule.notify, self.notifier.web.webhook_default)
        )
        self._outcome(schedule, run.status, attempt, notified=told)
        if told:
            self.notifier.deliver_later(
                Outcome(event=run.status, run=run, schedule=schedule, attempts=attempt)
            )

    def _outcome(self, schedule: Schedule, status: str, attempts: int, *, notified: bool) -> None:
        self.store.update_schedule(
            schedule.id,
            last_outcome={"status": status, "attempts": attempts, "notified": notified},
        )

    def _later(self, schedule: Schedule, attempt: int) -> None:
        """Start the next attempt after ``retry_delay``, without holding a thread on it."""
        delay = max(0.0, schedule.retry_delay)

        def again() -> None:
            if self.closed:
                return
            fresh = self.store.get_schedule(schedule.id)
            if fresh is None or not fresh.enabled:
                return  # the schedule went away, or was switched off, while we waited
            try:
                self.start_run(fresh, retry_trigger(schedule.id, attempt))
            except Exception:  # a retry that cannot start must not take the timer down
                log.exception("could not start attempt %s of schedule %s", attempt, schedule.id)

        if self.sleeper is not None:
            self.sleeper(delay, again)
            return
        timer = threading.Timer(delay, self._run_timer, args=(again,))
        timer.daemon = True
        self.timers.add(timer)
        timer.start()

    def _run_timer(self, work: Callable[[], None]) -> None:
        try:
            work()
        finally:
            for timer in list(self.timers):
                if not timer.is_alive():
                    self.timers.discard(timer)

    def close(self) -> None:
        """Forget every retry that has not happened yet. The server is going away."""
        self.closed = True
        for timer in list(self.timers):
            timer.cancel()
        self.timers.clear()


__all__ = [
    "LOG_TAIL",
    "TEST_EVENT",
    "WEBHOOK_RETRY_AFTER",
    "WEBHOOK_TIMEOUT",
    "Delivery",
    "Notifier",
    "Outcome",
    "Outcomes",
    "Target",
    "attempt_of",
    "base_url",
    "message_of",
    "retry_trigger",
    "targets_of",
    "wants",
]
