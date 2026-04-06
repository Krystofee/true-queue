# true-queue

![Queue Editor](queue-editor.png)

A task queue extension for [pi](https://github.com/badlogic/pi). Prevents the agent from seeing future tasks, so it focuses on the current one instead of rushing through it.

## Steering vs. queuing

pi already lets you type while the agent works. That's **steering** — your message lands in the current context and the agent sees it mid-task. Good for corrections, follow-ups, adding detail.

Queuing is different. When you prefix a message with `+`, the agent never sees it. It's held back until the current task is done, then sent as a fresh prompt. The agent has no idea there's a queue.

Why it matters: when an LLM sees multiple tasks at once, it rushes through the early ones to get to the last one. This is well-documented (goal anchoring, completion bias). Steering makes it worse — you're adding future work into the context. Queuing fixes it by hiding what's next.

## How it works

You queue tasks with a `+` prefix. The agent never sees them. When it finishes the current task, the next one is sent automatically.

```
+refactor the auth module
+write tests for it
+update the docs
```

That's it. Three tasks, executed one at a time, each getting full attention.

Use `++` if you want a confirmation prompt before a task starts:

```
++deploy to production
```

## Queue editor

Press `ctrl+q` (or type `/queue`) to open the queue editor overlay. Works while the agent is running.

- `↑↓` navigate
- `⇧↑↓` reorder
- `a` add, `e` edit, `d` delete
- `c` toggle confirmation
- `p` pause/resume
- `esc` close

## Commands

```
/queue              open editor
/queue add <task>   add a task
/queue clear        clear all
/queue done         mark current done, start next
/queue skip         drop current task
/queue pause        pause auto-dequeue
/queue resume       resume
```

The agent also has an `enqueue_task` tool, so you can ask it to queue something for later.

## Install

```
pi install git:github.com/Krystofee/true-queue
```

Or try it without installing:

```
pi -e git:github.com/Krystofee/true-queue
```

