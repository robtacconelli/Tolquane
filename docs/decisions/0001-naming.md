# Naming decision: BBFlow → Tolquane

Date: 2026-09-05

## Decision

The project formerly known as **BBFlow** (https://github.com/robtacconelli/BBFlow) is renamed
**Tolquane**. It will be rebuilt from scratch, most likely in Python, dropping the Java
codebase and the FastFlow-derived naming (`ff_node`, `ff_farm`, etc.).

- Prose / logo: `Tolquane`
- Code, package, URLs, handles: `tolquane` (all lowercase, e.g. `import tolquane`)
- Do not use alternate spellings (Talkane, Talquane) anywhere official.

## What the project is

A parallel-programming framework based on composable building blocks:
sequential nodes, combinators, farm (emitter / workers / collector), pipeline,
all-to-all, and channels (in-process queues and network/TCP channels) connecting them.

## Why this name

- Coined word, no dictionary meaning, no existing company, product, or project.
- Two syllables, pronounceable in English and Italian.
- Reads as "talk-ane": the blocks' whole job is talking to each other over channels.
  This is a discoverable wordplay, not an official tagline spelling.
- Suggested metaphor for docs/API: nodes *speak* on channels, a farm *broadcasts*,
  a collector *listens*.

## Availability at time of decision

Checked 2026-09-05:

| Check                          | Result                    |
|--------------------------------|---------------------------|
| PyPI `tolquane`                | free                      |
| npm `tolquane`                 | free                      |
| crates.io `tolquane`           | free                      |
| GitHub user/org `tolquane`     | free                      |
| GitHub repos named tolquane    | 0                         |
| DNS .com .io .dev .org .net .ai .it .eu | no records       |
| Search engine, exact match     | 0 hits (only Cornish/Scottish place names with similar spelling) |

DNS "no record" is strong evidence but not proof of an unregistered domain; confirm at a registrar.

## Rejected candidates (for the record)

- BBFlow: opaque abbreviation, many unrelated "BBFlow" businesses.
- Rivulon: rivulon.com is an existing company.
- Fluvion, Parvex, Nodara, Tessellar, Confluvia, Quorra, Modulith, Taskara: PyPI or GitHub taken.
- Quorveth: Amazon dropship brand.
- Strevane, Calquith: also fully clean, kept as fallbacks.

## To do (lock the name down)

1. Register tolquane.com and tolquane.io.
2. Create GitHub organization `tolquane`; new repo lives there.
3. Publish placeholder `tolquane` 0.0.1 on PyPI.
4. Reserve social handles used for announcements.
5. Later, once there is traction: EUIPO trademark search / filing (class 9 and 42).
