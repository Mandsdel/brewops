# Implementation plan: dashboard date-range filter

Ticket: `tickets/005-date-filter.md`. Goal: let the dashboard be scoped to a
date range instead of always showing all-time totals.

This plan assumes you have zero prior context on this codebase. Read the
"Background" section first, then follow the file-by-file changes in order.
Each step says exactly what to change and how to check it worked.

## Background

- Timestamps are stored in SQLite as naive local strings, format
  `'YYYY-MM-DD HH:MM:SS'` (see `src/brewops/db/schema.py` docstring). String
  comparison (`<`, `>=`) on this format works correctly for ordering because
  it's zero-padded and ISO-ish.
- `src/brewops/db/queries.py` has the SQL. `src/brewops/api/main.py` is the
  FastAPI layer that calls into it. `src/brewops/frontend/app.js` +
  `index.html` are the vanilla-JS frontend (no build step, no framework).
- Two endpoints supply the dashboard's numbers:
  - `GET /api/stats` → `queries.get_stats()` → total brews, per-drink counts,
    per-day counts.
  - `GET /api/machines/{id}` → `queries.get_machine_health()` → per-machine
    brew count, last brew timestamp, "specialty" drink, maintenance info.
- The frontend's `loadDashboard()` in `app.js` calls both and renders them.

## 1. `src/brewops/db/queries.py`

### 1a. `get_stats`

Current signature: `get_stats(conn: sqlite3.Connection) -> dict[str, Any]`

Change to:

```python
def get_stats(
    conn: sqlite3.Connection, start: str | None = None, end: str | None = None
) -> dict[str, Any]:
```

`start` and `end` are `'YYYY-MM-DD'` strings or `None`. Semantics: **inclusive
start, exclusive end** — i.e. the range is `[start, end)` in calendar days.
This avoids off-by-one errors from time-of-day (e.g. a brew logged at
`2026-01-05 23:50:00` must count when `end='2026-01-06'` is intended as "up
to and including Jan 5").

Build a `WHERE` clause fragment once and reuse it across the three queries:

```python
conditions = []
params: list[str] = []
if start is not None:
    conditions.append("be.timestamp >= ?")
    params.append(start)
if end is not None:
    conditions.append("be.timestamp < ?")
    params.append(end)
where_sql = f"WHERE {' AND '.join(conditions)}" if conditions else ""
```

Apply to each sub-query:

- **`total`**: currently `SELECT COUNT(*) AS n FROM brew_events`. Add
  `where_sql` (no alias needed, or alias the table `be`).
- **`per_drink`**: this one uses `LEFT JOIN` from `drink_types` so that every
  drink type shows up even with zero brews. **Do not put the date filter in a
  `WHERE` clause here** — that would turn unmatched rows into `NULL` first
  and then filter them out inconsistently. Put the date condition in the
  `ON` clause of the `LEFT JOIN` instead, so drink types with zero brews *in
  range* still appear with `count: 0`:

  ```sql
  SELECT dt.name, dt.label, COUNT(be.id) AS count
  FROM drink_types dt
  LEFT JOIN brew_events be
    ON be.drink_type = dt.name
    AND be.timestamp >= ? AND be.timestamp < ?   -- only the params that apply
  GROUP BY dt.id
  ORDER BY dt.id
  ```

  If `start`/`end` are `None`, omit that half of the `AND` condition (build
  the `ON` clause conditionally the same way as `where_sql` above, just
  applied after `ON be.drink_type = dt.name` instead of as a `WHERE`).

- **`per_day`**: currently groups `brew_events` by `DATE(timestamp)` with no
  filter. Add `where_sql` before `GROUP BY`.

Return value shape is unchanged: `{"total_brews": ..., "per_drink": [...],
"per_day": [...]}`.

### 1b. `get_machine_health`

Current signature:
`get_machine_health(conn: sqlite3.Connection, machine_id: int) -> dict[str, Any] | None`

Change to:

```python
def get_machine_health(
    conn: sqlite3.Connection, machine_id: int, start: str | None = None, end: str | None = None
) -> dict[str, Any] | None:
```

Same `[start, end)` semantics as above. Apply the date filter to:

- the `brews` query (`COUNT(*)`, `MAX(timestamp)`) — add to its `WHERE
  machine_id = ?` with `AND`.
- the `specialty` query — same, add to its `WHERE be.machine_id = ?`.

**Do not** filter `last_maintenance` or `recent_errors` by date — maintenance
and error history should stay lifetime data regardless of the brew-stats
range. The ticket is about brew numbers/charts, and maintenance isn't shown
on the timeline or bar chart. (If the user later asks for maintenance to be
scoped too, that's a separate change to the same function.)

Build the extra `WHERE` fragments the same conditional-parameter way as in
`get_stats` — don't duplicate a helper unless you want to factor out a small
`_date_clause(column, start, end) -> tuple[str, list[str]]` helper used by
both functions. That factoring is optional and up to you; keep it simple.

## 2. `src/brewops/api/main.py`

### 2a. New date parsing helper

The existing `parse_timestamp()` (line ~41) parses full datetimes and
**rejects future timestamps** — that's correct for brew/maintenance logging
but wrong for a filter's `end` date (a user picking "today" as the end of
the range is normal, not an error). Add a separate, simpler helper:

```python
def parse_date(value: str) -> str:
    """Parse a 'YYYY-MM-DD' filter-range boundary. No future-date rejection."""
    try:
        datetime.strptime(value.strip(), "%Y-%m-%d")
    except ValueError:
        raise HTTPException(400, f"unparsable date {value!r}, expected YYYY-MM-DD")
    return value.strip()
```

Put it near `parse_timestamp`, not inside it — different validation rules,
don't try to merge them.

### 2b. `GET /api/stats`

Current:

```python
@app.get("/api/stats")
def stats(conn: sqlite3.Connection = Depends(get_db)):
    return queries.get_stats(conn)
```

Change to accept optional query params `start` and `end`:

```python
@app.get("/api/stats")
def stats(
    start: str | None = None,
    end: str | None = None,
    conn: sqlite3.Connection = Depends(get_db),
):
    start_parsed = parse_date(start) if start is not None else None
    end_parsed = parse_date(end) if end is not None else None
    if start_parsed is not None and end_parsed is not None and start_parsed > end_parsed:
        raise HTTPException(400, "start must not be after end")
    return queries.get_stats(conn, start_parsed, end_parsed)
```

The `end` param here is the **user-facing inclusive end date** (e.g. picking
"2026-01-05" means "include all of Jan 5"). Since `queries.get_stats` treats
`end` as exclusive, you have two choices — pick one and be consistent:

- (a) convert here: pass `end` to the query as the day *after* the picked
  date, or
- (b) keep the query's `end` param exclusive and have the frontend always
  send the day after the picked end date.

**Recommended: do the conversion in the API layer (option a)**, so
`queries.py` stays a clean `[start, end)` interface and the frontend just
sends the plain calendar date the user picked, for both `start` and `end`.
Concretely:

```python
from datetime import timedelta
...
end_exclusive = None
if end_parsed is not None:
    end_exclusive = (datetime.strptime(end_parsed, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
return queries.get_stats(conn, start_parsed, end_exclusive)
```

### 2c. `GET /api/machines/{machine_id}`

Same treatment — add `start`/`end` query params, validate/convert the same
way, pass through to `queries.get_machine_health(conn, machine_id,
start_parsed, end_exclusive)`.

## 3. `src/brewops/frontend/index.html`

Add a date-range control inside the `#dashboard` section, above the stat
tiles (after the `<h1>`/tagline header, before `.stat-tiles`). Keep it
simple — two native date inputs plus a clear/reset, no JS date-picker
library (this project has "no dependencies, no build step" per the `app.js`
header comment):

```html
<div class="panel filter-panel">
  <label for="filter-start">From</label>
  <input type="date" id="filter-start">
  <label for="filter-end">To</label>
  <input type="date" id="filter-end">
  <button type="button" id="filter-apply">Apply</button>
  <button type="button" id="filter-clear">Clear</button>
  <p id="filter-message" class="message" role="status"></p>
</div>
```

Leave both inputs empty by default (empty = no filter = current all-time
behavior). No new CSS classes are strictly required — `panel` and `message`
already exist in `style.css`; only add rules if the inline layout looks
broken when you check it in the browser.

## 4. `src/brewops/frontend/app.js`

### 4a. Track and read the filter state

Add two module-level (or closure) variables, or just read the two `<input>`
elements directly each time — this codebase doesn't use any state
management, keep it consistent with that style. Simplest: read directly from
the DOM whenever building request URLs.

Add a small helper:

```js
function currentRange() {
  const start = document.getElementById("filter-start").value; // "" or "YYYY-MM-DD"
  const end = document.getElementById("filter-end").value;
  const params = new URLSearchParams();
  if (start) params.set("start", start);
  if (end) params.set("end", end);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}
```

### 4b. Use it in `loadDashboard()`

Current (lines ~80–92):

```js
async function loadDashboard() {
  const stats = await fetchJSON("/api/stats");
  ...
  const healths = await Promise.all(machines.map((m) => fetchJSON(`/api/machines/${m.id}`)));
  ...
}
```

Change to:

```js
async function loadDashboard() {
  const range = currentRange();
  const stats = await fetchJSON(`/api/stats${range}`);
  ...
  const healths = await Promise.all(
    machines.map((m) => fetchJSON(`/api/machines/${m.id}${range}`))
  );
  ...
}
```

`machines` (the `/api/machines` list) itself is not date-scoped — it's the
fleet roster, not brew data — leave that call as-is.

### 4c. Wire up the new controls

Near `setupForms()`'s call site at the bottom of the file, add:

```js
function setupFilter() {
  document.getElementById("filter-apply").addEventListener("click", () => {
    const start = document.getElementById("filter-start").value;
    const end = document.getElementById("filter-end").value;
    const message = document.getElementById("filter-message");
    message.textContent = "";
    message.className = "message";
    if (start && end && start > end) {
      message.textContent = "From date must not be after To date.";
      message.classList.add("error");
      return;
    }
    loadDashboard().catch((error) => {
      message.textContent = error.message;
      message.classList.add("error");
    });
  });

  document.getElementById("filter-clear").addEventListener("click", () => {
    document.getElementById("filter-start").value = "";
    document.getElementById("filter-end").value = "";
    document.getElementById("filter-message").textContent = "";
    loadDashboard().catch((error) => console.error("Dashboard failed to load:", error));
  });
}
```

Call it alongside the existing bottom-of-file calls:

```js
loadDashboard().catch((error) => { ... });   // existing, unchanged
setupForms().catch((error) => ...);          // existing, unchanged
setupFilter();                               // new
```

The string comparison `start > end` on `"YYYY-MM-DD"` values works correctly
in JS the same way it does in SQL, for the same reason (zero-padded ISO
format).

## Edge cases to handle and verify

1. **Empty range (no dates picked / Clear pressed)**: both `start` and `end`
   query params absent → `/api/stats` and `/api/machines/{id}` behave exactly
   as before (all-time). Verify: load the app fresh, confirm totals match
   what they were before this change.

2. **`start` after `end`**: reject client-side (4c, before calling
   `loadDashboard`) *and* server-side (2b, `start_parsed > end_parsed` check)
   — don't rely on only one layer. Verify: pick From = tomorrow-ish, To =
   today (or just pick From later than To), click Apply, confirm you get the
   inline error message and no request is fired with bad params; also hit
   `/api/stats?start=2026-02-01&end=2026-01-01` directly (e.g. via browser
   URL bar or curl) and confirm a `400` with a clear message, not a silent
   empty result.

3. **`start` only, or `end` only**: e.g. "everything since Jan 1" or
   "everything up to and including Mar 15". Both must work — don't assume
   the two params are always given together. Verify by hitting `/api/stats`
   with just `?start=...` and just `?end=...` and checking the totals differ
   sensibly from the unfiltered total.

4. **Days with zero brews inside the range**: `per_day` should not
   silently skip days with no brews if the frontend or a future consumer
   expects a contiguous series — but note the *current* unfiltered behavior
   already only returns days that have at least one row (it's a `GROUP BY
   DATE(timestamp)` with no calendar-day generation/zero-fill). **Don't
   change that behavior as part of this ticket** — the timeline chart in
   `app.js` (`renderTimeline`) computes bar width by dividing total SVG width
   by `perDay.length`, so it already tolerates gaps in the day sequence by
   just spacing whatever days *are* present evenly, not by calendar
   position. Verify: pick a range that includes at least one day with no
   brews and confirm the chart still renders without a JS error (open
   browser devtools console) — it will just not show a bar for that day,
   which matches existing behavior for unfiltered data too.

5. **Range with literally zero brews at all** (e.g. picking a week before
   the seed data starts): `get_stats` should return `total_brews: 0`,
   `per_drink` = every drink type with `count: 0` (thanks to the `LEFT JOIN
   ... ON` fix in 1a — verify this specifically, it's the easiest part to
   get wrong), `per_day: []`. Verify: `renderTimeline` already has an early
   return `if (perDay.length === 0) return;` (see `app.js` line ~32) so the
   chart should just render empty, not throw. Also verify
   `document.getElementById("brews-today")` (line ~84,
   `stats.per_day[stats.per_day.length - 1]`) handles an empty array — it
   already falls back to `lastDay ? lastDay.count : 0`, so it should show
   `0`, not crash. Confirm this in the browser, don't just read the code.

6. **Per-machine health with zero brews in range**: `get_machine_health`'s
   `brews` query uses `MAX(timestamp)` which returns `NULL` on zero rows —
   this already happens today for a machine with literally zero brews ever,
   so `last_brew: null` is already handled by the frontend (`app.js` line
   ~72, `m.last_brew ? ... : "never"`). Confirm the date-filtered case hits
   the same path and shows "never" too, not a crash from trying to slice a
   `null`.

7. **Single-day range (`start === end`)**: with `[start, end)` semantics
   inside `queries.py` and the API layer converting the user's inclusive
   `end` to exclusive `end + 1 day`, picking the *same* date for From and To
   should show that one day's data, not zero. This is the case most likely
   to be silently broken if the exclusive/inclusive conversion (step 2b) is
   done wrong — test it explicitly: pick From = To = a date you know has
   brews in the seed data, confirm `total_brews` matches that day's
   `per_day` count from the unfiltered view.

8. **Malformed date input**: browser `<input type="date">` normally
   constrains input to valid dates, but verify the server rejects garbage
   too — hit `/api/stats?start=not-a-date` directly and confirm a `400` with
   the message from `parse_date`, not a `500`.

## How to verify the whole thing works

1. `uv run start`, open `http://localhost:8123`.
2. Before touching the filter: note the current "brews total" tile value —
   this is your all-time baseline.
3. Set From/To to a narrow range you can reason about from the seed data
   (check `src/brewops/db/schema.py` / wherever seed data is generated, or
   just query the running SQLite DB directly, to know what to expect).
   Click Apply. Confirm:
   - the total tile drops to a smaller, correct number
   - the per-drink bars update
   - the timeline chart shows only days in range
   - each machine card's brew count/last-brew updates, and maintenance
     info does **not** change (per the deliberate exclusion in step 1b)
4. Click Clear. Confirm everything returns to the step-2 baseline.
5. Walk through edge cases 2–8 above manually (browser + curl/`Invoke-WebRequest`
   for the direct API checks).
6. Check the browser devtools console throughout for JS errors — none of
   the manual steps above should log anything to `console.error`.
7. If there's an existing test suite (check for a `tests/` directory before
   assuming there isn't one), add/run tests for `get_stats` and
   `get_machine_health` covering: no range, start-only, end-only, full
   range, inverted range (should be caller's job to reject, so this may not
   even reach the query layer), and zero-result range. This plan doesn't
   specify exact test file paths since none were found during planning —
   locate the convention (`pytest`? `unittest`?) before adding tests.
