# File Tree

A side pane that shows, as a folder tree, every file Claude has read, edited or created this session.

## What you see

- A **Files** pane that opens when the session starts. Each file has a badge: **A** for created, **M** for modified (**M×3** if edited three times), **R** for only read. The file Claude touched most recently is highlighted.
- A line at the top counts how many files were created, edited and read.
- Files outside your project folder appear under "Outside this folder".

## How to use it

- **Touched** (key `t`) shows only the files Claude worked with.
- **All files** (key `a`) lets you browse the whole project folder. Click a folder to open or close it, and **Collapse** closes them all. Folders that contain files Claude touched are marked with a dot. Bulky folders such as `node_modules` and `.git` are dimmed.
- Click any file to insert an `@` mention of it into your prompt.
- `/file-tree` reopens the pane if you closed it.

## Tests

One test checks that touched files form a tree, that the whole folder can be browsed, and that clicking a file mentions it.
