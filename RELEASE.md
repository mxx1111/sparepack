# Releasing

Manual, from a maintainer's machine. Every step below has been run at least once; the gotchas
section is what actually went wrong rather than what might.

## Steps

```bash
# 1. bump the version in package.json, then
npm test                       # 80 tests, all must pass
npm publish --dry-run          # check the file list and note the shasum

# 2. commit the bump before publishing, so the tarball matches a commit
git commit -am "chore: 0.1.2"

# 3. publish. --tag latest overrides publishConfig.tag (see below)
npm publish --tag latest

# 4. move the beta tag too — the spare-cycles docs tell users `npx sparepack@beta`
npm dist-tag add sparepack@0.1.2 beta

# 5. tag and push
git tag -a v0.1.2 -m "sparepack 0.1.2

tarball shasum <shasum from step 1>"
git push origin main --follow-tags

# 6. verify from the outside, not from the build directory
npm view sparepack dist-tags
cd $(mktemp -d) && npm init -y >/dev/null && npm install sparepack && ./node_modules/.bin/sparepack --help
```

## Gotchas

**`npm publish` must run in a real terminal.** The account uses a passkey (WebAuthn) as its second
factor, and "require 2FA for write operations" is on. Publishing opens a browser for the passkey
prompt, so it needs an interactive TTY. A non-interactive shell — CI, a backgrounded command, an
agent session — fails with `EOTP`. `--otp=` does not help: there is no six-digit code to pass,
because a passkey is not a TOTP authenticator. The same applies to `npm dist-tag add`.

**The tag npm prints is a lie.** `npm publish` announces `with tag latest` no matter what is
configured. In npm 11.6.2 `lib/commands/publish.js` reads the tag into a variable before it merges
`publishConfig`, so the notice shows the default while the registry receives the configured value.
Trust `npm view sparepack dist-tags`, not the publish output.

**The first publish of a package always gets `latest`.** `publishConfig.tag: beta` only decides
which *additional* tag is applied. 0.1.0 landed on both `latest` and `beta` for this reason. From
0.1.1 on, `beta` is the configured default, which is why step 3 passes `--tag latest` explicitly.

**A published version is permanent.** npm refuses to publish over an existing version. Unpublishing
is only possible within 72 hours and burns the version number; after that the tool is
`npm deprecate`. Fix a bad release by publishing the next patch, never by trying to replace one.

**Check the shasum across steps 1 and 6.** It is the only cheap proof that what reached the
registry is what was reviewed in the dry run.

## What this process does not have

Listed so nobody assumes otherwise:

- **No CI.** Tests run only where someone remembers to run them.
- **No changelog.** The git log is the record; commit bodies carry the reasoning.
- **No provenance attestation.** Publishing from a laptop cannot produce one — that requires
  publishing from a workflow with an OIDC token.

Automating this is the obvious next step, and it removes the passkey friction rather than working
around it: a GitHub Actions job triggered by a version tag, publishing with npm's trusted publishing
so no long-lived token exists anywhere. Worth doing once the release cadence justifies it.
