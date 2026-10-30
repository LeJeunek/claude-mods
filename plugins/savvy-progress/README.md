# Savvy Progress

A live progress band above the prompt that shows how far Claude is through a reply and what it is doing right now.

## What you see

- While Claude works: a spinner, the elapsed time, and a progress bar. If Claude keeps a task list, the bar follows its steps. If not, it compares this reply with how long your replies usually take. Until it has seen a few replies, it says "learning your pace".
- A "Now:" line showing the current action (for example "Reading app.ts"), plus counts of tools used and files changed.
- When the reply ends, a one-line summary: how long it took, how many steps were finished, and whether it was quicker or slower than usual.
- An **Agents** panel with one card per helper agent. Each card shows a small animated character for the agent's role (such as Researcher or Tester), the model it runs on, its progress, an estimated cost and its time.

## How to use it

- **▸ More / ▾ Less** opens or closes a summary with Steps, Tools, Files and Agents tiles. Click a tile to see its details.
- **Hide** removes the band. `/progress` brings it back, and `/progress expand` brings it back already opened.
- `/agents-panel` or **Open panel** opens the Agents panel. On a card, **▸ Tools** lists what that agent ran.

## Tests

10 tests cover the progress bar following a reply and its task list, the More summary, agent cards and how long finished agents stay on the band, and each role's character and animation.
