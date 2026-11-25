---
name: challenge
description: Old name of /aisdlc:clarify, kept for one release. Hands over to the clarify skill with the same goal ID. Use when the user runs /aisdlc:challenge.
argument-hint: "<G-id>"
---

# aisdlc: challenge (renamed to clarify)

Skills are named `<plugin>:<skill>` (`/aisdlc:clarify`); in an agent without plugin namespaces, such as GitHub Copilot, use only the `<skill>` part, both to load a skill and when you tell the user what to run (`/aisdlc:clarify` is `/clarify`).

`/aisdlc:challenge` was renamed to `/aisdlc:clarify` in aisdlc 0.31.0. This name goes away in a later release.

1. Tell the user, in one line, that the command is now `/aisdlc:clarify` and that it works the same way.
2. Load the `aisdlc:clarify` skill and follow it with the goal ID the user gave this one.
