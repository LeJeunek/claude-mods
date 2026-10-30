# Claude mods

Three mods for Claude Code. Each one has its own README in `plugins/`.

- **savvy-progress**: a live progress band above the prompt, with an Agents panel where each helper agent gets an animated critter for its role.
- **file-tree**: a side pane listing the files Claude read, edited or created, as a tree.
- **replay-theater**: a pane that records each action Claude takes so you can play the session back.

## Install

At the prompt of a terminal session:

```
/plugin install savvy-progress --marketplace LeJeunek/claude-mods
/plugin install file-tree --marketplace LeJeunek/claude-mods
/plugin install replay-theater --marketplace LeJeunek/claude-mods
```

Answer `y` to add the marketplace, then pick a scope (user loads them in every session).

From a shell:

```
claude plugin install savvy-progress --marketplace LeJeunek/claude-mods
claude plugin install file-tree --marketplace LeJeunek/claude-mods
claude plugin install replay-theater --marketplace LeJeunek/claude-mods
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `LeJeunek/claude-mods`, then Add plugin.

## Turn them on for everyone working in a repository

Add this to the repository's `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "my-mods": { "source": { "source": "github", "repo": "LeJeunek/claude-mods" } }
  },
  "enabledPlugins": {
    "savvy-progress@my-mods": true,
    "file-tree@my-mods": true,
    "replay-theater@my-mods": true
  }
}
```
