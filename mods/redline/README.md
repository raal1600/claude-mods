# Redline

A pane beside the chat that keeps a timeline of the session: what has been done, and what is being done right now. It is for people who run several sessions and want to see at a glance where each one stands.

## What it shows

- **Now.** While Claude works: a spinner, the step in progress, a progress bar for Claude's plan, and the turn's latest events as they happen. When Claude stops: "Waiting on you".
- **Timeline.** One line per request, newest first, joined by a line. An orange dot marks a milestone (something was built, changed, fixed or decided); a grey dot marks a smaller exchange.
- **Request.** Click a line to open it: what you asked, how it ended, and every event in it.
- **Event.** Click an event to open its full record: the command that ran or the diff of the edit, and what came back.

A strip above the prompt box shows the current step and reopens the pane. `/redline` opens it too.

## Install

At the prompt of a terminal session:

```
/plugin install redline --marketplace raal1600/claude-mods
```

From a shell:

```
claude plugin install redline --marketplace raal1600/claude-mods
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `raal1600/claude-mods`, then **Add plugin**.

Answer `y` to add the marketplace, then choose the user scope to have the mod in every session.

## Good to know

- **It calls a model.** When a turn ends, Redline asks Haiku for a short title and whether the turn was a milestone. That is one small request per turn, billed to the account the session runs on. With no answer, the entry keeps your own words as its title.
- **Nothing leaves the session otherwise.** The timeline is kept in the session's own state. An event's full record is read from the session's transcript when you open it, so an old event in a compacted session shows only its name, time and status.
- **Long output is cut.** An event shows up to about 6,000 characters of input and 8,000 of result.
- **Early access.** Mods use an API that changes between Claude Code releases. This one was written against Claude Code 2.1.321.

## Develop

```
claude plugin validate mods/redline
claude plugin test mods/redline
```

## Licence

MIT. See [LICENSE](LICENSE).
