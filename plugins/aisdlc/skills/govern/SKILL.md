---
name: govern
description: Old name of /aisdlc:signoff, kept for one release. Hands over to the signoff skill with the same arguments. Use when the user runs /aisdlc:govern.
argument-hint: "[G-id] [--final]"
---

# aisdlc: govern (renamed to signoff)

Skills are named `<plugin>:<skill>` (`/aisdlc:signoff`); in an agent without plugin namespaces, such as GitHub Copilot, use only the `<skill>` part, both to load a skill and when you tell the user what to run (`/aisdlc:signoff` is `/signoff`).

`/aisdlc:govern` was renamed to `/aisdlc:signoff` in aisdlc 0.30.0. This name goes away in a later release.

1. Tell the user, in one line, that the command is now `/aisdlc:signoff` and that it works the same way.
2. Load the `aisdlc:signoff` skill and follow it with the same arguments the user gave this one (none, `<G-id>`, or `<G-id> --final`).
