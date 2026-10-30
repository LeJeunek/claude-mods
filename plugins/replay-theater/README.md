# Replay Theater

A pane that records every action Claude takes so you can play the session back step by step, like a film.

## What you see

- Each action (reading a file, running a command, making an edit) is a **scene**. Each prompt you send starts a new **act**, headed by your prompt.
- The current scene shows what happened: before-and-after changes for edits, the command and its output for commands, and the content for written files. It also shows whether the action succeeded, failed or was blocked, and how long it took.
- A timeline of the act. When helper agents were involved, each one gets its own row, and a **Cast** list shows every agent and its status.
- A **Script** list of nearby scenes. Click any scene to jump to it.

## How to use it

- Buttons: **⏮** first scene (`g`), **◀ Prev** (`h`), **▶ Play / ⏸ Pause** (`p`), **Next ▶** (`l`), **Live ⏭** to follow along as Claude works (`e`), and a speed button that cycles 1×, 2×, 4× and 0.5× (`s`).
- **◀ Act / Act ▶** (`k` / `j`) jump between prompts.
- `/replay` reopens the pane.

## Tests

Two tests cover recording actions as scenes and acts and playing them back, plus the agent rows, the cast list and the agent label on each scene.
