# Writing Goal Mode

## Product direction

The writing studio now supports two complementary ways of working:

- **Partner mode** keeps a human approval gate after every generated artifact.
- **AI Lead mode** lets the model plan and execute the remaining steps continuously, while every manuscript mutation is protected by a version snapshot.

The goal is not unattended “one-click book generation.” It is an inspectable production loop in which the AI owns progress toward a concrete deliverable and the author retains creative authority, pause control, references, acceptance criteria, and rollback.

## Research signals

The implementation draws on recurring patterns in established products and public writer discussions:

- [Sudowrite Story Bible](https://docs.sudowrite.com/using-sudowrite/1ow1qkGqof9rtcyGnrWUBS/what-is-story-bible/jmWepHcQdJetNrE991fjJC) uses a visible dependency chain from idea and genre through synopsis, characters, worldbuilding, outline, scenes, and draft. It treats the Story Bible as both an author workspace and an AI source of truth.
- [Novelcrafter Codex](https://www.novelcrafter.com/features/codex) emphasizes automatic mentions, linked entries, progression tracking, flexible research metadata, and contextual generation grounded in the Codex.
- Public r/WritingWithAI discussions such as [six months of tool research](https://www.reddit.com/r/WritingWithAI/comments/1rlgqm2/i_spent_last_6_months_researching_what_ai_writing/), [the problem with current AI writing workflows](https://www.reddit.com/r/WritingWithAI/comments/1m4ufcj/the_problem_with_using_ai_for_writing_isnt_the_ai/), and [AI writing burnout](https://www.reddit.com/r/WritingWithAI/comments/1sxgozy/im_burned_out_on_ai_writing/) repeatedly surface the same failure modes: brittle chapter-summary workflows, repetition used to fill word counts, overly literal dialogue, context drift, and disappointing results when an entire story is handed to AI without intermediate controls.

These signals led to four design decisions:

1. A goal is an acceptance contract, not a long prompt.
2. Planning and execution are separate, observable phases.
3. References are durable project data with explicit inclusion controls.
4. Autonomous execution is reversible and interruptible.

## Data model

Writing projects retain backward compatibility with schema version 1 and add optional normalized collections:

- `references`: source type, title, content, usage notes, source URL, tags, and enabled state.
- `goals`: deliverable, collaboration mode, target document, word target, audience, constraints, acceptance criteria, plan, status, and run summary.
- `goal.plan`: typed steps with `note`, `new_document`, `append`, or `replace` operations and persistent outputs/errors.

Legacy projects load with empty collections. References and goals are included in project JSON, Markdown exports, autosave signatures, and snapshots.

## Execution lifecycle

1. The author defines the goal contract.
2. The model returns a constrained JSON plan of 3-6 steps. Malformed plans fall back to a deterministic plan appropriate to the requested deliverable.
3. Each step receives the project direction, ranked Codex entries, enabled or pinned references, prior step outputs, and the current target manuscript.
4. Partner mode stores output for review. AI Lead mode applies it immediately.
5. `new_document`, `append`, and `replace` operations create a snapshot before changing a manuscript. `note` operations preserve analysis without mutating prose.
6. The final audit checks the result against the author’s acceptance criteria and common long-form failure modes.

All running requests can be cancelled. A cancelled goal returns to a resumable paused state; interrupted persisted steps normalize back to pending on the next launch.
