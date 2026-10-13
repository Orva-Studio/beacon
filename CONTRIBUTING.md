# Contributing to Beacon

Thanks for wanting to help. Beacon doesn't take pull requests: the way to
contribute is to **open an issue**.

## Why no pull requests

Beacon is built by one developer working with AI coding agents. Every change
is planned against [`PLAN.md`](PLAN.md), made by an agent, reviewed and tested
before it lands, so outside pull requests don't fit how it's made. They're
closed without review, however good. An issue that explains the problem well
is worth more than a patch: it gets fixed the same way as everything else.

## How issues are handled

Issues are read, triaged and fixed in due course, by an agent working through
them with the maintainer. There's no timeline: some are fixed quickly, some
wait for the phase of [`PLAN.md`](PLAN.md) they belong to, and some are closed
as out of scope with a note why. A fix lands as a commit that mentions the
issue.

## Filing an issue

Use **New issue** on GitHub and pick a form:

- **Bug report**: something doesn't work as it should.
- **Feature request**: something Beacon should do, or do differently.

Before you file:

- Search the [open and closed issues](../../issues?q=is%3Aissue) first; if
  yours is there, add what you know to it rather than opening another.
- One problem per issue.
- Say what you expected and what happened instead, and the steps that get
  there. "It crashed" can't be fixed; "importing this `.trec` while a proxy is
  building crashes" can.
- Include your Beacon version (Beacon › About), your macOS version and your
  Mac.
- For recording problems, name the devices (camera, capture card,
  microphone): they behave differently.
- Screenshots and short screen recordings help a lot.

**Don't attach anything private.** Recordings and projects can show your
screen, your email and your face: if a file is needed to reproduce a bug, say
so in the issue and we'll find a safe way to share it.

## Security

Please don't report a security problem in a public issue. Use **Report a
vulnerability** under the repository's Security tab, which reaches the
maintainer privately.

## Forking

Beacon is licensed under [FSL-1.1-ALv2](LICENSE): you may fork it, change it
and use it for anything but a competing product, and each version becomes
Apache 2.0 two years after it's released.
