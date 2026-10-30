# Claude mods

Three mods for Claude Code. Each one has its own README in `plugins/`.

- **savvy-progress**: a live progress band above the prompt, with an Agents panel where each helper agent gets an animated critter for its role.
- **file-tree**: a side pane listing the files Claude read, edited or created, as a tree.
- **replay-theater**: a pane that records each action Claude takes so you can play the session back.

## Install

At the prompt of a terminal session:

```
/plugin install savvy-progress --marketplace LeJeunek/ClaudeMods
/plugin install file-tree --marketplace LeJeunek/ClaudeMods
/plugin install replay-theater --marketplace LeJeunek/ClaudeMods
```

Answer `y` to add the marketplace, then pick a scope (user loads them in every session).

From a shell:

```
claude plugin install savvy-progress --marketplace LeJeunek/ClaudeMods
claude plugin install file-tree --marketplace LeJeunek/ClaudeMods
claude plugin install replay-theater --marketplace LeJeunek/ClaudeMods
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `LeJeunek/ClaudeMods`, then Add plugin.

## Turn them on for everyone working in a repository

Add this to the repository's `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "my-mods": { "source": { "source": "github", "repo": "LeJeunek/ClaudeMods" } }
  },
  "enabledPlugins": {
    "savvy-progress@my-mods": true,
    "file-tree@my-mods": true,
    "replay-theater@my-mods": true
  }
}
```
