---
name: sequential-isolation
description: Teaches the agent about goal anchoring and completion bias — cognitive phenomena where knowing about future tasks degrades quality of the current one. Includes guidelines for self-triage and working with the task queue extension. Use when working on multi-step tasks, when the user queues work, or when task quality matters.
---

# Sequential Isolation

## The Problem

You have a documented cognitive bias called **goal anchoring**: when you see multiple sequential tasks (e.g., "review, fix bugs, push"), you rush through early steps because your attention is pulled toward the final goal.

This happens because of:

1. **Attention architecture** — your transformer attention follows a U-shaped curve. Strong primacy + recency bias, weak middle. The last instruction ("push") gets disproportionate attention weight, pulling your generation toward completion.

2. **RLHF completion bias** — you were trained to reward task completion. When multiple steps are visible, you optimize for "did everything" over "did this one thing well." You are 64% less likely to catch errors in your own output than identical errors in external text (Self-Correction Bench, 2025).

3. **Context accumulation** — as you work through steps, tool outputs and file reads crowd out the original instruction's causal influence. The current task's importance decays relative to newer context.

**This is not a hypothetical.** Research (SIFo, EMNLP 2024; Lost in the Middle, Liu et al. 2023) has measured this directly: models degrade significantly on intermediate steps in sequential instructions.

## Self-Triage Protocol

Before starting any task, assess:

1. **Am I seeing future work?** — If the conversation contains tasks I'll do later (queued tasks, multi-step plans, "and then do X"), I must recognize that my current work quality is at risk.

2. **Is this a qualitative task?** — Review, analysis, design, planning — tasks where thoroughness matters more than speed — are most vulnerable to goal anchoring.

3. **Am I producing shallow output?** — Concrete checks:
   - Review task but output is under 20 lines? Probably too shallow.
   - Analysis task but didn't read the actual code, just described it from memory? Redo.
   - Skipped edge cases or error paths? Go back.
   - Used phrases like "looks good overall" without specific file:line references? Completion bias is active.

**When any trigger fires: slow down, not speed up.** The current task is the only task that exists.

## Working with the Task Queue

The user has a **task queue extension** that solves this at the infrastructure level:

- **`+ task`** — The user queues a task. **You never see it.** It's intercepted before reaching your context. Don't acknowledge it, don't reference it, don't plan for it.

- **`++ task`** — Same, but the user will be asked to confirm before you receive it.

- **Normal input** — This is a steer for your current task. Respond to it immediately.

- **When a queued task arrives** — It appears as a normal user message prefixed with `[Queued task]` after the previous task finishes. Treat it as a fresh task. Don't reference "the queue" or "the previous task" unless the context naturally contains that information.

- **`enqueue_task` tool** — If the user explicitly asks you to queue or defer something for later, you may use this tool to add it to the queue. Important: this is bookkeeping convenience, not true isolation — because you are the one creating the queued task, you already know it exists.



## Guidelines for Multi-Step Work

When a user gives you a multi-step task in a single message (e.g., "review this, then fix the bugs"):

1. **Use subagent chains** — orchestrate via `subagent` tool with `chain` parameter. Each step gets an isolated context where it doesn't know about future steps.

2. **Formulate each step as self-contained** — The task description for each subagent should read as if it's the only task in the world. No "after this, we'll..." or "this is step 1 of 3".

3. **Use strong models for qualitative work** — Never delegate review, analysis, or design to fast/cheap models. These tasks are exactly where goal anchoring hits hardest and where model quality matters most.

4. **Let each step finish completely** — Don't pre-optimize for the next step. A thorough review that finds 8 issues is more valuable than a quick review that finds 3 issues but "saves time" for fixing.

## What NOT to Do

- Don't mention this skill, the queue, or goal anchoring to the user unless asked
- Don't say "I'm being careful because of completion bias" — just be careful
- Don't over-decompose simple tasks — if it's one clear thing, just do it
- Don't add artificial delays or verbosity — thoroughness ≠ length
