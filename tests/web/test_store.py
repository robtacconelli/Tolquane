"""The SQLite store behind Tolquane Web: runs, schedules, settings and migrations."""

from __future__ import annotations

import sqlite3
import threading
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from tolquane.web import store as store_module
from tolquane.web.store import LOG_LIMIT, Store, schema_version


@pytest.fixture
def store(tmp_path: Path) -> Iterator[Store]:
    with Store(tmp_path / "web.db") as opened:
        yield opened


def columns_of(path: Path, table: str) -> set[str]:
    conn = sqlite3.connect(path)
    try:
        return {str(row[1]) for row in conn.execute(f"PRAGMA table_info({table})")}
    finally:
        conn.close()


# Schema and migrations ---------------------------------------------------


def test_an_empty_file_gets_the_current_schema(tmp_path: Path) -> None:
    path = tmp_path / "fresh.db"
    with Store(path) as store:
        assert store.version == schema_version()
        assert store.list_runs() == []
        assert store.list_schedules() == []
        assert store.settings() == {}
    assert columns_of(path, "runs") >= {"id", "flow", "trigger", "status", "report", "log"}


def test_a_missing_directory_is_created(tmp_path: Path) -> None:
    with Store(tmp_path / "deep" / "down" / "web.db") as store:
        assert store.add_run("a.py", "threads").id == 1
    assert (tmp_path / "deep" / "down" / "web.db").exists()


def test_a_schema_version_zero_file_is_migrated(tmp_path: Path) -> None:
    path = tmp_path / "old.db"
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE schema_version (version INTEGER NOT NULL)")
    conn.execute("INSERT INTO schema_version (version) VALUES (0)")
    conn.commit()
    conn.close()
    with Store(path) as store:
        assert store.version == schema_version()
        assert store.add_run("a.py", "threads").flow == "a.py"


def test_a_database_from_1_2_gains_the_new_columns_with_their_defaults(tmp_path: Path) -> None:
    """The 1.3 columns are added by a migration, so a workspace keeps its history."""
    path = tmp_path / "old.db"
    conn = sqlite3.connect(path)
    store_module._migration_1(conn)
    store_module._migration_2(conn)
    conn.execute("CREATE TABLE schema_version (version INTEGER NOT NULL)")
    conn.execute("INSERT INTO schema_version (version) VALUES (2)")
    conn.execute(
        'INSERT INTO runs (flow, runtime, "trigger", started, status)'
        " VALUES ('a.py', 'sync', 'manual', '2026-01-01T00:00:00+00:00', 'done')"
    )
    conn.execute(
        "INSERT INTO schedules (flow, cron, runtime, created)"
        " VALUES ('a.py', '@daily', 'sync', '2026-01-01T00:00:00+00:00')"
    )
    conn.commit()
    conn.close()
    with Store(path) as store:
        assert store.version == schema_version()
        run = store.list_runs()[0]
        assert (run.params, run.env) == ({}, {})
        schedule = store.list_schedules()[0]
        assert schedule.notify == {"events": [], "webhook": None, "emails": []}
        assert (schedule.retries, schedule.retry_delay, schedule.last_outcome) == (0, 60.0, None)
        assert store.list_notifications() == []
    assert columns_of(path, "runs") >= {"params", "env"}
    assert columns_of(path, "schedules") >= {"notify", "retries", "retry_delay", "last_outcome"}


def test_the_file_is_in_wal_mode(tmp_path: Path) -> None:
    path = tmp_path / "web.db"
    with Store(path):
        pass
    conn = sqlite3.connect(path)
    try:
        assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    finally:
        conn.close()


def test_reopening_keeps_the_data_and_migrates_nothing(tmp_path: Path) -> None:
    path = tmp_path / "web.db"
    with Store(path) as first:
        run = first.add_run("a.py", "threads")
        first.set_setting("theme", "dark")
    with Store(path) as second:
        assert second.version == schema_version()
        assert second.get_run(run.id) == run
        assert second.get_setting("theme") == "dark"


def test_a_later_migration_adds_a_column_to_an_existing_file(tmp_path: Path) -> None:
    path = tmp_path / "web.db"
    with Store(path) as first:
        run = first.add_run("a.py", "threads")

    def add_note(conn: sqlite3.Connection) -> None:
        conn.execute("ALTER TABLE runs ADD COLUMN note TEXT")

    store_module._MIGRATIONS.append(add_note)
    try:
        with Store(path) as second:
            assert second.version == schema_version() == len(store_module._MIGRATIONS)
            assert second.get_run(run.id) is not None
            assert "note" in columns_of(path, "runs")
    finally:
        store_module._MIGRATIONS.pop()


def test_a_database_from_a_newer_tolquane_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "web.db"
    with Store(path):
        pass
    conn = sqlite3.connect(path)
    conn.execute("UPDATE schema_version SET version = 99")
    conn.commit()
    conn.close()
    with pytest.raises(ValueError, match="newer than this Tolquane"):
        Store(path)


# Runs --------------------------------------------------------------------


def test_a_run_starts_as_running(store: Store) -> None:
    run = store.add_run("hello.py", "threads", sample="three lines", trigger="schedule:7")
    assert (run.flow, run.runtime, run.sample, run.trigger) == (
        "hello.py",
        "threads",
        "three lines",
        "schedule:7",
    )
    assert run.status == "running"
    assert (run.ended, run.report, run.trace_path, run.error) == (None, None, None, None)
    assert run.log == ""
    started = datetime.fromisoformat(run.started)
    assert started.tzinfo is not None
    assert abs(started - datetime.now(UTC)) < timedelta(seconds=30)


def test_finish_run_stores_the_report_and_the_end(store: Store) -> None:
    run = store.add_run("hello.py", "threads")
    report = {"runtime": "threads", "elapsed": 1.5, "nodes": {"double": {"items_in": 4}}}
    done = store.finish_run(run.id, "done", report, "all good\n", "trace.json", None)
    assert done.status == "done"
    assert done.report == report
    assert done.log == "all good\n"
    assert done.trace_path == "trace.json"
    assert done.ended is not None
    assert store.get_run(run.id) == done


def test_a_failed_run_keeps_its_error(store: Store) -> None:
    run = store.add_run("hello.py", "sync")
    failed = store.finish_run(run.id, "failed", None, "boom\n", None, "NodeError: boom")
    assert (failed.status, failed.report, failed.error) == ("failed", None, "NodeError: boom")


def test_the_log_keeps_the_last_64_kb(store: Store) -> None:
    run = store.add_run("hello.py", "threads")
    text = "".join(f"line {n}\n" for n in range(20000))
    kept = store.finish_run(run.id, "done", None, text).log
    assert len(kept.encode()) <= LOG_LIMIT
    assert len(kept.encode()) > LOG_LIMIT - 64
    assert text.endswith(kept)


def test_the_log_is_cut_on_a_character_boundary(store: Store) -> None:
    run = store.add_run("hello.py", "threads")
    kept = store.finish_run(run.id, "done", None, "é" * LOG_LIMIT).log
    assert set(kept) == {"é"}
    assert len(kept.encode()) <= LOG_LIMIT


def test_an_unknown_status_is_refused(store: Store) -> None:
    run = store.add_run("hello.py", "threads")
    with pytest.raises(ValueError, match="unknown run status 'finished'"):
        store.finish_run(run.id, "finished")


def test_finishing_a_run_that_is_not_there_is_an_error(store: Store) -> None:
    with pytest.raises(ValueError, match="no run 404"):
        store.finish_run(404, "done")


def test_get_run_of_an_unknown_id_is_none(store: Store) -> None:
    assert store.get_run(404) is None


def test_runs_come_back_newest_first_and_can_be_filtered(store: Store) -> None:
    for flow in ("a.py", "b.py", "a.py", "a.py"):
        store.add_run(flow, "threads")
    assert [run.flow for run in store.list_runs()] == ["a.py", "a.py", "b.py", "a.py"]
    assert [run.id for run in store.list_runs("a.py")] == [4, 3, 1]
    assert [run.id for run in store.list_runs(limit=2)] == [4, 3]
    assert store.list_runs("nowhere.py") == []


def test_run_to_dict_is_json_ready(store: Store) -> None:
    run = store.finish_run(store.add_run("a.py", "sync").id, "done", {"elapsed": 0.5}, "hi")
    data = run.to_dict()
    assert data["report"] == {"elapsed": 0.5}
    assert set(data) == {
        "id",
        "flow",
        "runtime",
        "sample",
        "trigger",
        "started",
        "ended",
        "status",
        "report",
        "log",
        "trace_path",
        "error",
        "user",
        "params",
        "env",
    }


# Schedules ---------------------------------------------------------------


def test_a_schedule_starts_enabled_without_a_next_run(store: Store) -> None:
    schedule = store.add_schedule("hello.py", "*/15 * * * *", sample="s", runtime="processes")
    assert (schedule.flow, schedule.cron, schedule.sample) == ("hello.py", "*/15 * * * *", "s")
    assert schedule.runtime == "processes"
    assert schedule.enabled is True
    assert (schedule.last_run, schedule.last_status, schedule.next_run) == (None, None, None)
    assert store.get_schedule(schedule.id) == schedule


def test_get_schedule_of_an_unknown_id_is_none(store: Store) -> None:
    assert store.get_schedule(404) is None


def test_update_schedule_changes_the_fields_it_is_given(store: Store) -> None:
    schedule = store.add_schedule("hello.py", "0 9 * * *")
    changed = store.update_schedule(schedule.id, enabled=False, last_run=3, last_status="done")
    assert changed.enabled is False
    assert (changed.last_run, changed.last_status) == (3, "done")
    assert changed.cron == "0 9 * * *"
    assert changed.created == schedule.created


def test_a_new_cron_clears_the_next_run(store: Store) -> None:
    schedule = store.add_schedule("hello.py", "0 9 * * *")
    store.update_schedule(schedule.id, next_run="2026-09-06T09:00:00+00:00")
    assert store.update_schedule(schedule.id, cron="0 10 * * *").next_run is None
    with_both = store.update_schedule(
        schedule.id, cron="0 11 * * *", next_run="2026-09-06T11:00:00+00:00"
    )
    assert with_both.next_run == "2026-09-06T11:00:00+00:00"


def test_next_run_accepts_an_aware_datetime(store: Store) -> None:
    schedule = store.add_schedule("hello.py", "0 9 * * *")
    moment = datetime(2026, 9, 6, 11, 0, tzinfo=UTC).astimezone()
    stored = store.update_schedule(schedule.id, next_run=moment)
    assert stored.next_run is not None
    assert datetime.fromisoformat(stored.next_run) == moment
    assert stored.next_run.endswith("+00:00")


def test_a_naive_next_run_is_refused(store: Store) -> None:
    schedule = store.add_schedule("hello.py", "0 9 * * *")
    with pytest.raises(ValueError, match="timezone-aware"):
        store.update_schedule(schedule.id, next_run=datetime(2026, 9, 6, 11, 0))


def test_update_schedule_refuses_unknown_fields(store: Store) -> None:
    schedule = store.add_schedule("hello.py", "0 9 * * *")
    with pytest.raises(ValueError, match="unknown schedule field\\(s\\) colour"):
        store.update_schedule(schedule.id, colour="red")
    with pytest.raises(ValueError, match="at least one field"):
        store.update_schedule(schedule.id)
    with pytest.raises(ValueError, match="no schedule 404"):
        store.update_schedule(404, enabled=False)


def test_schedules_are_listed_in_order_and_can_be_filtered(store: Store) -> None:
    for flow in ("a.py", "b.py", "a.py"):
        store.add_schedule(flow, "@daily")
    assert [s.id for s in store.list_schedules()] == [1, 2, 3]
    assert [s.id for s in store.list_schedules("a.py")] == [1, 3]


def test_delete_schedule_removes_it_and_forgives_a_second_go(store: Store) -> None:
    schedule = store.add_schedule("hello.py", "@daily")
    store.delete_schedule(schedule.id)
    assert store.list_schedules() == []
    store.delete_schedule(schedule.id)


def test_schedule_to_dict_is_json_ready(store: Store) -> None:
    schedule = store.add_schedule("hello.py", "@daily")
    assert schedule.to_dict()["enabled"] is True
    assert set(schedule.to_dict()) == {
        "id",
        "flow",
        "cron",
        "sample",
        "runtime",
        "enabled",
        "created",
        "last_run",
        "last_status",
        "next_run",
        "user",
        "params",
        "env",
        "notify",
        "retries",
        "retry_delay",
        "last_outcome",
    }


# Outcomes and notifications ----------------------------------------------


def test_a_schedule_keeps_its_input_and_its_outcome(store: Store) -> None:
    schedule = store.add_schedule(
        "a.py",
        "@daily",
        params={"threshold": 0.5},
        env={"TZ": "UTC"},
        notify={"events": ["failed", "done"], "webhook": "https://example.test/h"},
        retries=2,
        retry_delay=5,
    )
    assert schedule.params == {"threshold": 0.5}
    assert schedule.env == {"TZ": "UTC"}
    assert schedule.notify == {
        "events": ["failed", "done"],
        "webhook": "https://example.test/h",
        "emails": [],
    }
    assert (schedule.retries, schedule.retry_delay) == (2, 5.0)
    assert schedule.last_outcome is None

    changed = store.update_schedule(
        schedule.id, last_outcome={"status": "failed", "attempts": 3, "notified": True}
    )
    assert changed.last_outcome == {"status": "failed", "attempts": 3, "notified": True}
    assert store.get_schedule(schedule.id) == changed


def test_a_schedule_from_before_1_3_tells_nobody(store: Store) -> None:
    """The columns were added with defaults, so an old row reads as one that says no."""
    schedule = store.add_schedule("a.py", "@daily")
    assert schedule.notify == {"events": [], "webhook": None, "emails": []}
    assert schedule.retries == 0
    assert schedule.retry_delay == 60.0


@pytest.mark.parametrize(
    ("field", "value", "says"),
    [
        ("params", {"not a name": 1}, "not a parameter name"),
        ("env", {"9lives": "x"}, "environment variable name"),
        ("notify", {"events": ["exploded"]}, "notify.events must be"),
        ("notify", {"webhook": "ftp://x"}, "http:// or https://"),
        ("notify", {"emails": ["nope"]}, "not an email address"),
        ("retries", 6, "between 0 and 5"),
        ("retry_delay", -1, "0 or more"),
    ],
)
def test_a_schedule_field_that_is_not_what_it_should_be(
    store: Store, field: str, value: object, says: str
) -> None:
    schedule = store.add_schedule("a.py", "@daily")
    with pytest.raises(ValueError, match=says):
        store.update_schedule(schedule.id, **{field: value})
    assert store.get_schedule(schedule.id) == schedule


def test_a_run_keeps_what_it_was_given(store: Store) -> None:
    run = store.add_run("a.py", "sync", params={"n": [1, 2]}, env={"TZ": "UTC"})
    assert run.params == {"n": [1, 2]}
    assert run.env == {"TZ": "UTC"}
    assert store.get_run(run.id) == run
    with pytest.raises(ValueError, match="not a parameter name"):
        store.add_run("a.py", "sync", params={"two words": 1})


def test_notifications_are_recorded_and_read_back(store: Store) -> None:
    run = store.add_run("a.py", "sync", trigger="schedule:1")
    schedule = store.add_schedule("a.py", "@daily")
    sent = store.add_notification(
        "webhook", "https://example.test/h", "sent", run_id=run.id, schedule_id=schedule.id
    )
    store.add_notification(
        "email", "ada@example.test", "failed", run_id=run.id, error="no SMTP settings"
    )
    assert sent.created
    rows = store.list_notifications(run_id=run.id)
    assert [(row.channel, row.status) for row in rows] == [("webhook", "sent"), ("email", "failed")]
    assert rows[1].error == "no SMTP settings"
    assert store.list_notifications(schedule_id=schedule.id) == [sent]
    assert store.list_notifications(run_id=999) == []
    with pytest.raises(ValueError, match="unknown channel"):
        store.add_notification("pigeon", "ada", "sent")
    with pytest.raises(ValueError, match="unknown notification status"):
        store.add_notification("email", "ada@example.test", "maybe")


# Settings ----------------------------------------------------------------


def test_settings_hold_json_values(store: Store) -> None:
    store.set_setting("workspace", "/home/me/flows")
    store.set_setting("max_concurrent_runs", 4)
    store.set_setting("server", {"host": "127.0.0.1", "port": 8765})
    store.set_setting("recent", ["a.py", "b.py"])
    store.set_setting("browser", False)
    store.set_setting("model", None)
    assert store.get_setting("workspace") == "/home/me/flows"
    assert store.get_setting("server") == {"host": "127.0.0.1", "port": 8765}
    assert store.get_setting("recent") == ["a.py", "b.py"]
    assert store.get_setting("browser") is False
    assert store.get_setting("model") is None
    assert store.settings() == {
        "browser": False,
        "max_concurrent_runs": 4,
        "model": None,
        "recent": ["a.py", "b.py"],
        "server": {"host": "127.0.0.1", "port": 8765},
        "workspace": "/home/me/flows",
    }


def test_a_setting_is_replaced_not_duplicated(store: Store) -> None:
    store.set_setting("theme", "light")
    store.set_setting("theme", "dark")
    assert store.get_setting("theme") == "dark"
    assert list(store.settings()) == ["theme"]


def test_an_unset_setting_gives_the_default(store: Store) -> None:
    assert store.get_setting("theme") is None
    assert store.get_setting("theme", "dark") == "dark"


def test_delete_setting_brings_back_the_default(store: Store) -> None:
    store.set_setting("theme", "dark")
    store.delete_setting("theme")
    assert store.get_setting("theme", "light") == "light"
    store.delete_setting("theme")


@pytest.mark.parametrize(
    "key",
    ["anthropic_key", "ai.openai_key", "TOKEN_SECRET", "api_Key", "notifications.smtp_password"],
)
def test_secrets_are_refused_and_told_where_to_go(store: Store, key: str) -> None:
    with pytest.raises(ValueError, match="never go in the database") as caught:
        store.set_setting(key, "sk-not-a-real-key")
    message = str(caught.value)
    assert "web.toml" in message
    assert "environment" in message
    assert store.settings() == {}


@pytest.mark.parametrize("key", ["keyboard", "key", "secretariat", "workspace_keys"])
def test_ordinary_keys_that_only_look_like_secrets_are_kept(store: Store, key: str) -> None:
    store.set_setting(key, 1)
    assert store.get_setting(key) == 1


# Threads -----------------------------------------------------------------


def test_many_threads_may_write_at_once(store: Store) -> None:
    errors: list[BaseException] = []

    def work(worker: int) -> None:
        try:
            for n in range(25):
                run = store.add_run(f"flow{worker}.py", "threads")
                store.finish_run(run.id, "done", {"n": n}, f"worker {worker}\n")
                store.set_setting(f"worker{worker}", n)
                schedule = store.add_schedule(f"flow{worker}.py", "@hourly")
                store.update_schedule(schedule.id, last_run=run.id, last_status="done")
        except BaseException as exc:  # pragma: no cover - only on a broken store
            errors.append(exc)

    threads = [threading.Thread(target=work, args=(worker,)) for worker in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(20)

    assert errors == []
    runs = store.list_runs(limit=1000)
    assert len(runs) == 200
    assert len({run.id for run in runs}) == 200
    assert all(run.status == "done" for run in runs)
    assert len(store.list_schedules()) == 200
    assert len(store.settings()) == 8
    for worker in range(8):
        assert len(store.list_runs(f"flow{worker}.py", limit=1000)) == 25
