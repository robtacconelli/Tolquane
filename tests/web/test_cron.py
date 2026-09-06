"""The five-field cron parser: fields, names, the next time, and what daylight saving
does to a schedule."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from itertools import pairwise
from zoneinfo import ZoneInfo

import pytest

from tolquane.web.cron import Cron

ROME = ZoneInfo("Europe/Rome")
NEW_YORK = ZoneInfo("America/New_York")


def times(expression: str, start: datetime, count: int) -> list[datetime]:
    """The next ``count`` firings, each computed from the one before it."""
    cron = Cron.parse(expression)
    moment = start
    out = []
    for _ in range(count):
        moment = cron.next_after(moment)
        out.append(moment)
    return out


# Fields ------------------------------------------------------------------


def test_stars_mean_every_value() -> None:
    cron = Cron.parse("* * * * *")
    assert cron.minutes == frozenset(range(60))
    assert cron.hours == frozenset(range(24))
    assert cron.days == frozenset(range(1, 32))
    assert cron.months == frozenset(range(1, 13))
    assert cron.weekdays == frozenset(range(7))
    assert not cron.day_of_month_given
    assert not cron.day_of_week_given


def test_a_single_value_per_field() -> None:
    cron = Cron.parse("5 9 13 6 2")
    assert (cron.minutes, cron.hours) == (frozenset({5}), frozenset({9}))
    assert (cron.days, cron.months, cron.weekdays) == (
        frozenset({13}),
        frozenset({6}),
        frozenset({2}),
    )
    assert cron.day_of_month_given
    assert cron.day_of_week_given


def test_ranges() -> None:
    cron = Cron.parse("0-4 8-10 1-3 * *")
    assert cron.minutes == frozenset({0, 1, 2, 3, 4})
    assert cron.hours == frozenset({8, 9, 10})
    assert cron.days == frozenset({1, 2, 3})


def test_steps() -> None:
    assert Cron.parse("*/15 * * * *").minutes == frozenset({0, 15, 30, 45})
    assert Cron.parse("* */6 * * *").hours == frozenset({0, 6, 12, 18})
    assert Cron.parse("10-40/10 * * * *").minutes == frozenset({10, 20, 30, 40})
    # A bare value with a step runs from that value to the end of the field.
    assert Cron.parse("5/15 * * * *").minutes == frozenset({5, 20, 35, 50})


def test_lists_and_lists_of_ranges() -> None:
    assert Cron.parse("0,30 * * * *").minutes == frozenset({0, 30})
    assert Cron.parse("0-2,30,45-46 * * * *").minutes == frozenset({0, 1, 2, 30, 45, 46})
    assert Cron.parse("0 8,12,17 * * *").hours == frozenset({8, 12, 17})
    assert Cron.parse("0 0 * * mon,wed,fri").weekdays == frozenset({1, 3, 5})


def test_names_of_months_and_weekdays_in_any_case() -> None:
    assert Cron.parse("0 0 * jan *").months == frozenset({1})
    assert Cron.parse("0 0 * DEC *").months == frozenset({12})
    assert Cron.parse("0 0 * jan-mar *").months == frozenset({1, 2, 3})
    assert Cron.parse("0 0 * * mon-FRI").weekdays == frozenset({1, 2, 3, 4, 5})
    assert Cron.parse("0 0 * * Sun").weekdays == frozenset({0})
    assert Cron.parse("0 0 * february *").months == frozenset({2})
    assert Cron.parse("0 0 * * wednesday").weekdays == frozenset({3})


def test_sunday_is_both_zero_and_seven() -> None:
    assert Cron.parse("0 0 * * 7").weekdays == frozenset({0})
    assert Cron.parse("0 0 * * 5-7").weekdays == frozenset({5, 6, 0})


def test_whitespace_is_forgiven() -> None:
    spaced = Cron.parse("  0   9  *  *  *  ")
    assert (spaced.minutes, spaced.hours) == (frozenset({0}), frozenset({9}))
    assert spaced.next_after(datetime(2026, 9, 6, tzinfo=UTC)) == datetime(
        2026, 9, 6, 9, 0, tzinfo=UTC
    )


@pytest.mark.parametrize(
    ("alias", "same_as"),
    [
        ("@hourly", "0 * * * *"),
        ("@daily", "0 0 * * *"),
        ("@midnight", "0 0 * * *"),
        ("@weekly", "0 0 * * 0"),
        ("@monthly", "0 0 1 * *"),
        ("@yearly", "0 0 1 1 *"),
        ("@annually", "0 0 1 1 *"),
        ("@DAILY", "0 0 * * *"),
    ],
)
def test_aliases(alias: str, same_as: str) -> None:
    aliased, spelled_out = Cron.parse(alias), Cron.parse(same_as)
    assert aliased.minutes == spelled_out.minutes
    assert aliased.hours == spelled_out.hours
    assert aliased.days == spelled_out.days
    assert aliased.months == spelled_out.months
    assert aliased.weekdays == spelled_out.weekdays
    assert str(aliased) == alias.strip()


def test_a_cron_is_frozen_and_hashable() -> None:
    cron = Cron.parse("0 9 * * *")
    assert cron == Cron.parse("0 9 * * *")
    assert len({cron, Cron.parse("0 9 * * *")}) == 1
    with pytest.raises(AttributeError):
        cron.expression = "0 10 * * *"  # type: ignore[misc]


# Bad expressions ---------------------------------------------------------


@pytest.mark.parametrize(
    ("expression", "message"),
    [
        ("", "empty cron expression"),
        ("0 9 * *", "expected five fields"),
        ("0 9 * * * *", "expected five fields"),
        ("@fortnightly", "unknown alias"),
        ("61 * * * *", "minute: 61 is out of range 0-59"),
        ("* 24 * * *", "hour: 24 is out of range 0-23"),
        ("* * 0 * *", "day of month: 0 is out of range 1-31"),
        ("* * 32 * *", "day of month: 32 is out of range 1-31"),
        ("* * * 13 *", "month: 13 is out of range 1-12"),
        ("* * * * 8", "day of week: 8 is out of range 0-7"),
        ("* * * smarch *", "month: 'smarch' is not a number or a name"),
        ("* * * * funday", "day of week: 'funday' is not a number or a name"),
        ("mon * * * *", "minute: 'mon' is not a number"),
        ("*/0 * * * *", "minute: step '0'"),
        ("*/x * * * *", "minute: step 'x'"),
        ("* * * * fri-mon", "day of week: range 'fri-mon' runs backwards"),
        ("30-10 * * * *", "minute: range '30-10' runs backwards"),
        ("0,,5 * * * *", "minute: empty item"),
        ("0- * * * *", "minute: empty value"),
    ],
)
def test_a_bad_expression_names_the_field_and_the_reason(expression: str, message: str) -> None:
    with pytest.raises(ValueError, match=str(message).replace("(", "\\(")):
        Cron.parse(expression)


def test_an_impossible_date_is_reported_rather_than_searched_forever() -> None:
    cron = Cron.parse("0 0 30 2 *")
    with pytest.raises(ValueError, match="no matching time within"):
        cron.next_after(datetime(2026, 1, 1, tzinfo=UTC))


# The next time -----------------------------------------------------------


def test_next_after_needs_a_zone() -> None:
    with pytest.raises(ValueError, match="timezone-aware"):
        Cron.parse("@daily").next_after(datetime(2026, 9, 6, 10, 0))


def test_next_after_keeps_the_zone_and_drops_the_seconds() -> None:
    start = datetime(2026, 9, 6, 10, 0, 41, 123456, tzinfo=ROME)
    moment = Cron.parse("* * * * *").next_after(start)
    assert moment == datetime(2026, 9, 6, 10, 1, tzinfo=ROME)
    assert moment.tzinfo is ROME
    assert (moment.second, moment.microsecond) == (0, 0)


def test_next_after_is_strictly_after() -> None:
    exactly_nine = datetime(2026, 9, 6, 9, 0, tzinfo=UTC)
    assert Cron.parse("0 9 * * *").next_after(exactly_nine) == exactly_nine + timedelta(days=1)


def test_every_quarter_hour_within_office_hours_on_weekdays() -> None:
    friday_evening = datetime(2026, 9, 4, 18, 50, tzinfo=UTC)  # a Friday
    assert times("*/15 8-18 * * mon-fri", friday_evening, 3) == [
        datetime(2026, 9, 7, 8, 0, tzinfo=UTC),  # Monday, the weekend skipped
        datetime(2026, 9, 7, 8, 15, tzinfo=UTC),
        datetime(2026, 9, 7, 8, 30, tzinfo=UTC),
    ]


def test_the_last_minute_of_a_window_is_the_hour_plus_45() -> None:
    assert times("*/15 8-18 * * *", datetime(2026, 9, 6, 18, 40, tzinfo=UTC), 2) == [
        datetime(2026, 9, 6, 18, 45, tzinfo=UTC),
        datetime(2026, 9, 7, 8, 0, tzinfo=UTC),
    ]


def test_a_monthly_schedule_walks_the_months() -> None:
    assert times("0 0 1 * *", datetime(2026, 1, 15, tzinfo=UTC), 3) == [
        datetime(2026, 2, 1, tzinfo=UTC),
        datetime(2026, 3, 1, tzinfo=UTC),
        datetime(2026, 4, 1, tzinfo=UTC),
    ]


def test_the_29th_of_february_waits_for_a_leap_year() -> None:
    assert Cron.parse("0 0 29 2 *").next_after(datetime(2026, 3, 1, tzinfo=UTC)) == datetime(
        2028, 2, 29, tzinfo=UTC
    )


def test_named_months_limit_the_year() -> None:
    assert times("0 12 * jan,jul *", datetime(2026, 3, 3, tzinfo=UTC), 2) == [
        datetime(2026, 7, 1, 12, 0, tzinfo=UTC),
        datetime(2026, 7, 2, 12, 0, tzinfo=UTC),
    ]


def test_day_of_month_and_day_of_week_together_mean_either_of_them() -> None:
    # The old cron rule: the 13th, or any Friday.
    fired = times("0 0 13 3 *", datetime(2026, 3, 1, tzinfo=UTC), 1)
    assert fired == [datetime(2026, 3, 13, tzinfo=UTC)]
    both = times("0 0 13 3 fri", datetime(2026, 3, 1, tzinfo=UTC), 4)
    assert both == [
        datetime(2026, 3, 6, tzinfo=UTC),  # a Friday
        datetime(2026, 3, 13, tzinfo=UTC),  # a Friday and the 13th
        datetime(2026, 3, 20, tzinfo=UTC),
        datetime(2026, 3, 27, tzinfo=UTC),
    ]


def test_a_star_day_of_month_keeps_the_weekday_rule_strict() -> None:
    assert times("0 0 * * mon", datetime(2026, 3, 1, tzinfo=UTC), 2) == [
        datetime(2026, 3, 2, tzinfo=UTC),
        datetime(2026, 3, 9, tzinfo=UTC),
    ]


# Daylight saving ---------------------------------------------------------


def test_rome_skips_a_time_that_the_spring_forward_swallows() -> None:
    # On 29 March 2026 Rome goes 02:00 CET -> 03:00 CEST; 02:30 does not happen.
    assert times("30 2 * * *", datetime(2026, 3, 28, 12, 0, tzinfo=ROME), 2) == [
        datetime(2026, 3, 30, 2, 30, tzinfo=ROME),
        datetime(2026, 3, 31, 2, 30, tzinfo=ROME),
    ]


def test_new_york_skips_a_time_that_the_spring_forward_swallows() -> None:
    # On 8 March 2026 New York goes 02:00 EST -> 03:00 EDT.
    assert times("0 2 * * *", datetime(2026, 3, 6, 12, 0, tzinfo=NEW_YORK), 3) == [
        datetime(2026, 3, 7, 2, 0, tzinfo=NEW_YORK),
        datetime(2026, 3, 9, 2, 0, tzinfo=NEW_YORK),
        datetime(2026, 3, 10, 2, 0, tzinfo=NEW_YORK),
    ]


def test_a_time_around_the_gap_still_fires_on_the_spring_forward_day() -> None:
    assert times("30 1 * * *", datetime(2026, 3, 28, 12, 0, tzinfo=ROME), 2) == [
        datetime(2026, 3, 29, 1, 30, tzinfo=ROME),
        datetime(2026, 3, 30, 1, 30, tzinfo=ROME),
    ]


def test_rome_fires_once_on_a_time_the_fall_back_repeats() -> None:
    # On 25 October 2026 Rome goes 03:00 CEST -> 02:00 CET, so 02:30 happens twice.
    fired = times("30 2 * * *", datetime(2026, 10, 24, 12, 0, tzinfo=ROME), 2)
    assert fired == [
        datetime(2026, 10, 25, 2, 30, tzinfo=ROME),
        datetime(2026, 10, 26, 2, 30, tzinfo=ROME),
    ]
    assert fired[0].utcoffset() == timedelta(hours=2)  # the first 02:30, not the second


def test_new_york_fires_once_on_a_time_the_fall_back_repeats() -> None:
    # On 1 November 2026 New York goes 02:00 EDT -> 01:00 EST.
    fired = times("30 1 * * *", datetime(2026, 10, 31, 12, 0, tzinfo=NEW_YORK), 2)
    assert fired == [
        datetime(2026, 11, 1, 1, 30, tzinfo=NEW_YORK),
        datetime(2026, 11, 2, 1, 30, tzinfo=NEW_YORK),
    ]
    assert fired[0].utcoffset() == timedelta(hours=-4)


def test_the_repeated_hour_is_lived_through_once() -> None:
    fired = times("*/30 * * * *", datetime(2026, 10, 25, 1, 0, tzinfo=ROME), 5)
    assert [moment.strftime("%H:%M %z") for moment in fired] == [
        "01:30 +0200",
        "02:00 +0200",
        "02:30 +0200",
        "03:00 +0100",  # the second 02:00 and 02:30 are skipped
        "03:30 +0100",
    ]
    assert fired == sorted(fired)  # and time still only goes forward


def test_every_firing_is_an_hour_apart_in_real_time_across_the_gap() -> None:
    fired = times("0 * * * *", datetime(2026, 3, 29, 0, 30, tzinfo=ROME), 4)
    utc = [moment.astimezone(UTC) for moment in fired]
    gaps = {later - earlier for earlier, later in pairwise(utc)}
    assert gaps == {timedelta(hours=1)}
    assert [moment.hour for moment in fired] == [1, 3, 4, 5]  # 02:00 never happened


def test_a_second_occurrence_of_an_ambiguous_start_still_moves_forward() -> None:
    cron = Cron.parse("*/30 * * * *")
    second_half_past_two = datetime(2026, 10, 25, 2, 30, tzinfo=ROME, fold=1)
    assert cron.next_after(second_half_past_two) == datetime(2026, 10, 25, 3, 0, tzinfo=ROME)


# Describing --------------------------------------------------------------


@pytest.mark.parametrize(
    ("expression", "sentence"),
    [
        ("*/15 8-18 * * mon-fri", "every 15 minutes from 8:00 to 18:59, Monday to Friday"),
        ("* * * * *", "every minute"),
        ("*/5 * * * *", "every 5 minutes"),
        ("*/10 9-17 * * *", "every 10 minutes from 9:00 to 17:59"),
        ("@hourly", "every hour"),
        ("30 * * * *", "every hour at 30 minutes past"),
        ("0 */2 * * *", "every 2 hours"),
        ("0 8-18 * * *", "every hour from 8:00 to 18:59"),
        ("0 9 * * *", "at 09:00 daily"),
        ("@daily", "at 00:00 daily"),
        ("30 6 * * mon", "at 06:30, on Monday"),
        ("0 0 * * sat,sun", "at 00:00, on Sunday and Saturday"),
        ("0 12 * * mon-wed", "at 12:00, Monday to Wednesday"),
        ("0,30 9 * * *", "at 09:00 and 09:30 daily"),
        ("0 9,18 * * *", "at 09:00 and 18:00 daily"),
        ("0 0 1 * *", "at 00:00, on the 1st of the month"),
        ("30 6 1,15 * *", "at 06:30, on the 1st and 15th of the month"),
        ("0 0 2,3,23 * *", "at 00:00, on the 2nd, 3rd and 23rd of the month"),
        ("@yearly", "at 00:00, on the 1st of January"),
        ("15 3 * jan-mar *", "at 03:15, from January to March"),
        ("15 3 * jan,jul *", "at 03:15, in January and July"),
    ],
)
def test_describe_says_it_in_english(expression: str, sentence: str) -> None:
    assert Cron.parse(expression).describe() == sentence


@pytest.mark.parametrize(
    "expression", ["7,23,44 * * * *", "0 12 1,15 * mon", "3-9 1,2,3,4,5 * * *"]
)
def test_describe_falls_back_to_the_expression_when_it_is_exotic(expression: str) -> None:
    assert Cron.parse(expression).describe() == expression
