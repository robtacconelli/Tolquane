"""A five-field cron parser for Tolquane Web schedules.

``Cron.parse`` reads the usual five fields (minute, hour, day of month, month, day of
week) with ``*``, lists, ranges, steps and three-letter names, plus the ``@hourly``
family of aliases. ``next_after`` answers the only question the scheduler asks: when
does this fire next? It computes in the zone of the datetime it is given, so a schedule
written as "at 02:30" means half past two on the clock on the wall, whatever the clock
did overnight: on the spring-forward day 02:30 does not exist and is skipped, and on the
fall-back day it exists twice and fires on the first one only.

Two old cron habits are kept because expressions get copied out of crontabs: day of week
uses ``0`` or ``7`` for Sunday, and when both the day of month and the day of week are
given the entry fires when *either* matches, not both.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta, tzinfo

SEARCH_DAYS = 366 * 9
"""How far ``next_after`` looks before giving up: long enough for 29 February."""

ALIASES = {
    "@yearly": "0 0 1 1 *",
    "@annually": "0 0 1 1 *",
    "@monthly": "0 0 1 * *",
    "@weekly": "0 0 * * 0",
    "@daily": "0 0 * * *",
    "@midnight": "0 0 * * *",
    "@hourly": "0 * * * *",
}

MONTH_NAMES = (
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
)
DAY_NAMES = ("sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday")


def _name_table(names: tuple[str, ...], first: int) -> dict[str, int]:
    table: dict[str, int] = {}
    for offset, name in enumerate(names):
        table[name] = first + offset
        table[name[:3]] = first + offset
    return table


@dataclass(frozen=True)
class _Field:
    """One column of the expression: what it is called, its range and its names."""

    name: str
    lo: int
    hi: int
    names: dict[str, int]
    sunday_seven: bool = False

    def value(self, text: str) -> int:
        word = text.strip().lower()
        if not word:
            raise ValueError(f"{self.name}: empty value")
        if word in self.names:
            return self.names[word]
        if not word.isdigit():
            expected = "a number or a name" if self.names else "a number"
            raise ValueError(f"{self.name}: {text.strip()!r} is not {expected}")
        number = int(word)
        if not self.lo <= number <= self.hi:
            raise ValueError(f"{self.name}: {number} is out of range {self.lo}-{self.hi}")
        return number

    def normalise(self, value: int) -> int:
        return 0 if self.sunday_seven and value == 7 else value


_FIELDS = (
    _Field("minute", 0, 59, {}),
    _Field("hour", 0, 23, {}),
    _Field("day of month", 1, 31, {}),
    _Field("month", 1, 12, _name_table(MONTH_NAMES, 1)),
    _Field("day of week", 0, 7, _name_table(DAY_NAMES, 0), sunday_seven=True),
)


def _parse_field(text: str, field: _Field) -> frozenset[int]:
    """Expand one column into the set of values it stands for."""
    values: set[int] = set()
    for item in text.split(","):
        part = item.strip()
        if not part:
            raise ValueError(f"{field.name}: empty item in {text!r}")
        body, slash, step_text = part.partition("/")
        step = 1
        if slash:
            if not step_text.strip().isdigit() or int(step_text) < 1:
                raise ValueError(
                    f"{field.name}: step {step_text.strip()!r} in {part!r} must be a whole "
                    "number of at least 1"
                )
            step = int(step_text)
        if body == "*":
            lo, hi = field.lo, field.hi
        elif "-" in body:
            start, _, end = body.partition("-")
            lo, hi = field.value(start), field.value(end)
            if hi < lo:
                raise ValueError(
                    f"{field.name}: range {body!r} runs backwards; write it as a list, "
                    f"'{end.strip()},{start.strip()}'"
                )
        else:
            lo = field.value(body)
            # "5/15" is the common extension: from 5 to the end of the field, by 15.
            hi = field.hi if step > 1 else lo
        values.update(range(lo, hi + 1, step))
    return frozenset(field.normalise(value) for value in values)


@dataclass(frozen=True)
class Cron:
    """A parsed cron expression: immutable, hashable, cheap to keep beside a schedule."""

    expression: str
    minutes: frozenset[int]
    hours: frozenset[int]
    days: frozenset[int]
    months: frozenset[int]
    weekdays: frozenset[int]
    day_of_month_given: bool = False
    day_of_week_given: bool = False

    @classmethod
    def parse(cls, expression: str) -> Cron:
        """Parse ``"*/15 8-18 * * mon-fri"`` and friends. Raises ``ValueError`` naming the
        field and the reason when the expression is not one Tolquane understands."""
        text = expression.strip()
        if not text:
            raise ValueError("empty cron expression; write five fields, for example '0 9 * * *'")
        alias = ALIASES.get(text.lower())
        if text.startswith("@") and alias is None:
            known = ", ".join(sorted(ALIASES))
            raise ValueError(f"unknown alias {text!r}; the aliases are {known}")
        fields = (alias or text).split()
        if len(fields) != 5:
            raise ValueError(
                "expected five fields (minute hour day-of-month month day-of-week), "
                f"got {len(fields)} in {expression!r}"
            )
        sets = [_parse_field(part, field) for part, field in zip(fields, _FIELDS, strict=True)]
        return cls(
            expression=text,
            minutes=sets[0],
            hours=sets[1],
            days=sets[2],
            months=sets[3],
            weekdays=sets[4],
            # Vixie's rule: a field counts as given only when it does not start with a star.
            day_of_month_given=not fields[2].startswith("*"),
            day_of_week_given=not fields[4].startswith("*"),
        )

    def __str__(self) -> str:
        return self.expression

    def matches_date(self, day: date) -> bool:
        """Does a day pass the month, day-of-month and day-of-week fields?"""
        if day.month not in self.months:
            return False
        weekday = (day.weekday() + 1) % 7  # Python counts from Monday, cron from Sunday
        by_day = day.day in self.days
        by_weekday = weekday in self.weekdays
        if self.day_of_month_given and self.day_of_week_given:
            return by_day or by_weekday
        return by_day and by_weekday

    def next_after(self, dt: datetime) -> datetime:
        """The first firing strictly after ``dt``, in ``dt``'s own zone.

        ``dt`` must be timezone-aware. Wall-clock times the zone skips are skipped; times
        the zone repeats fire on the first of the two; and the result is always later
        than ``dt`` in real time, so feeding a result back in walks forward.
        """
        if dt.tzinfo is None:
            raise ValueError(
                "next_after needs a timezone-aware datetime; "
                "use datetime.now().astimezone() or attach a ZoneInfo"
            )
        zone = dt.tzinfo
        # Compare in UTC: two aware datetimes with the same tzinfo compare by wall clock,
        # which on the fall-back day would let an earlier instant look later.
        after = dt.astimezone(UTC)
        wall = dt.replace(tzinfo=None, second=0, microsecond=0) + timedelta(minutes=1)
        hours = sorted(self.hours)
        minutes = sorted(self.minutes)
        day = wall.date()
        last_day = day + timedelta(days=SEARCH_DAYS)
        from_minute = wall.hour * 60 + wall.minute
        while day <= last_day:
            if self.matches_date(day):
                for hour in hours:
                    for minute in minutes:
                        if hour * 60 + minute < from_minute:
                            continue
                        moment = _localise(datetime.combine(day, time(hour, minute)), zone)
                        if moment is not None and moment.astimezone(UTC) > after:
                            return moment
            day += timedelta(days=1)
            from_minute = 0
        raise ValueError(
            f"{self.expression!r} has no matching time within {SEARCH_DAYS // 366} years; "
            "check the day of month against the month"
        )

    def describe(self) -> str:
        """A short English sentence, or the expression itself when it is too unusual to
        put into words: "every 15 minutes from 8:00 to 18:59, Monday to Friday"."""
        when = self._describe_time()
        days = self._describe_days()
        if when is None or days is None:
            return self.expression
        if not days:
            return f"{when} daily" if when.startswith("at ") else when
        return f"{when}, {days}"

    # Describing ---------------------------------------------------------

    def _describe_time(self) -> str | None:
        minutes = sorted(self.minutes)
        hours = sorted(self.hours)
        every_hour = len(hours) == 24
        span = _span(hours)
        # The window the hours make: nothing to say, a "from ... to ...", or unsayable.
        window: str | None = None
        if every_hour:
            window = ""
        elif span:
            window = f" from {span[0]}:00 to {span[1]}:59"
        if window is not None:
            if len(minutes) == 60:
                return f"every minute{window}"
            minute_step = _step(minutes, 60)
            if minute_step:
                return f"every {minute_step} minutes{window}"
        if len(minutes) == 1:
            minute = minutes[0]
            past = "" if minute == 0 else f" at {minute} minutes past"
            if every_hour:
                return f"every hour{past}"
            hour_step = _step(hours, 24)
            if hour_step:
                return f"every {hour_step} hours{past}"
            if window and len(hours) > 4:
                return f"every hour{past}{window}"
        if len(minutes) * len(hours) <= 4:
            stamps = [f"{hour:02d}:{minute:02d}" for hour in hours for minute in minutes]
            return "at " + _join(sorted(stamps))
        return None

    def _describe_days(self) -> str | None:
        parts: list[str] = []
        if self.day_of_month_given and self.day_of_week_given:
            return None  # the either-or rule is not worth a sentence
        if self.day_of_week_given:
            days = sorted(self.weekdays)
            names = [DAY_NAMES[day].capitalize() for day in days]
            if _span(days) and len(days) > 2:
                parts.append(f"{names[0]} to {names[-1]}")
            else:
                parts.append(f"on {_join(names)}")
        months = sorted(self.months)
        names = [MONTH_NAMES[month - 1].capitalize() for month in months]
        if self.day_of_month_given:
            ordinals = _join([_ordinal(day) for day in sorted(self.days)])
            # "on the 1st of January" beats "on the 1st, in January" for a yearly job.
            of = names[0] if len(months) == 1 else "the month"
            parts.append(f"on the {ordinals} of {of}")
            if len(months) == 1:
                return ", ".join(parts)
        if len(months) != 12:
            if _span(months) and len(months) > 2:
                parts.append(f"from {names[0]} to {names[-1]}")
            else:
                parts.append(f"in {_join(names)}")
        return ", ".join(parts)


def _localise(naive: datetime, zone: tzinfo) -> datetime | None:
    """Attach ``zone`` to a wall-clock time, or return ``None`` when the zone skipped it.

    A time in the spring-forward gap is mapped by ``zoneinfo`` to an instant an hour
    away, which no longer reads back as the same clock time; that is how we spot it.
    Ambiguous times keep ``fold=0``, the first of the two.
    """
    moment = naive.replace(tzinfo=zone)
    if moment.astimezone(UTC).astimezone(zone).replace(tzinfo=None) != naive:
        return None
    return moment


def _step(values: list[int], size: int) -> int | None:
    """The ``n`` of ``*/n`` when the values are exactly that, and worth saying (n > 1)."""
    if len(values) < 2 or size % len(values) != 0:
        return None
    step = size // len(values)
    return step if step > 1 and values == list(range(0, size, step)) else None


def _span(values: list[int]) -> tuple[int, int] | None:
    """The ends of a run of consecutive values, or ``None`` when there are gaps."""
    if len(values) < 2 or values[-1] - values[0] + 1 != len(values):
        return None
    return values[0], values[-1]


def _join(words: list[str]) -> str:
    if len(words) == 1:
        return words[0]
    return f"{', '.join(words[:-1])} and {words[-1]}"


def _ordinal(number: int) -> str:
    if 11 <= number % 100 <= 13:
        return f"{number}th"
    suffix = {1: "st", 2: "nd", 3: "rd"}.get(number % 10, "th")
    return f"{number}{suffix}"
