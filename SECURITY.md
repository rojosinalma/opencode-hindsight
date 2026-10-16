# Security policy

## Supported versions

Only the latest release receives security fixes. Upgrade to the newest tag before reporting.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's security advisories:
<https://github.com/rojosinalma/opencode-hindsight/security/advisories/new>. Never open a public
issue for a security problem.

Include what the issue is, how to reproduce it, which version is affected and what impact you
expect. You get an acknowledgement within a few days; fixes ship as a new release with a
`CHANGELOG.md` entry and the advisory is published once the fix is out.

## Scope

The plugin runs inside the OpenCode server and sends prompt text and transcript slices to the
Hindsight server you configure. Anything that lets a third party read or alter that traffic, leak
the bearer token or inject content into the system prompt is in scope. Vulnerabilities in OpenCode
or Hindsight themselves belong to those projects.
