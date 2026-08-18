# Releasing

Tag-driven. Bump the version, push a tag, and GitHub Actions publishes. The manual path below
still works and is what to fall back on when CI is unavailable.

## The normal path

```bash
# 1. bump the version and commit it
npm version patch              # or minor / major — this commits and tags for you
# npm version writes package.json + package-lock.json, commits, and creates vX.Y.Z

# 2. push the commit and the tag
git push origin main --follow-tags
```

That is the whole release. The `release` workflow then:

1. refuses to continue if the tag disagrees with `package.json` (a wrong tag costs a version
   number, because npm never allows republishing one)
2. runs `npm ci`, the full test suite, and a CLI smoke check
3. publishes with npm **trusted publishing** — the GitHub OIDC token is the credential, so no npm
   token exists in secrets or on anyone's laptop, and the release carries a provenance attestation
   linking the tarball to this repository and commit

Then verify from the outside, never from the build directory:

```bash
npm view sparepack dist-tags
cd $(mktemp -d) && npm init -y >/dev/null && npm install sparepack && ./node_modules/.bin/sparepack --help
```

### One-time setup on npmjs.com

Trusted publishing has to be enabled once, per package: npmjs.com → the `sparepack` package →
**Settings** → **Trusted publisher** → GitHub Actions, repository `mxx1111/sparepack`, workflow
`release.yml`. Until that is configured the workflow will fail at the publish step with a 404 or
an authentication error, which is the correct failure — it means the registry does not yet trust
this repository to speak for the package.

## The manual path

For when CI is down, or the change is urgent enough to justify skipping it.

```bash
npm test
npm publish --dry-run          # check the file list, note the shasum
git commit -am "chore: 0.1.2"  # commit before publishing: the tarball should match a commit
npm publish
git tag -a v0.1.2 -m "sparepack 0.1.2

tarball shasum <shasum from the dry run>"
git push origin main --follow-tags
```

Compare the shasum from the dry run against `npm view sparepack@0.1.2 dist.shasum`. It is the only
cheap proof that what reached the registry is what was reviewed.

Note that a manual publish produces **no provenance attestation**. Only a workflow with an OIDC
token can, so a hand-published version is strictly less verifiable than a tagged one.

## Gotchas

**A manual `npm publish` needs a real terminal.** The account uses a passkey (WebAuthn) as its
second factor with "require 2FA for write operations" on, so publishing opens a browser for the
passkey prompt and needs an interactive TTY. A non-interactive shell — CI without trusted
publishing, a backgrounded command, an agent session — fails with `EOTP`. `--otp=` does not help:
a passkey is not a TOTP authenticator, so there is no six-digit code to pass. The same applies to
`npm dist-tag`. Trusted publishing sidesteps this entirely, which is half the reason it is worth
having.

**The tag npm prints is a lie.** `npm publish` announces `with tag latest` no matter what is
configured. In npm 11.6.2, `lib/commands/publish.js` reads the tag into a variable before merging
`publishConfig`, so the notice shows the default while the registry receives the configured value.
Trust `npm view sparepack dist-tags`, not the publish output.

**The first publish of a package always gets `latest`,** whatever `publishConfig.tag` says — that
setting only decides which *additional* tag is applied. 0.1.0 landed on both `latest` and `beta`
for this reason.

**There is no `beta` channel any more.** `publishConfig.tag: beta` was dropped after 0.1.1: with
every release going to both tags, `beta` and `latest` pointed at the same version and the channel
meant nothing. If prereleases are wanted later, do it properly — publish `0.2.0-beta.1` with
`--tag beta`, and let stable versions take `latest` on their own.

**A published version is permanent.** npm refuses to publish over an existing version.
Unpublishing is only possible within 72 hours and burns the version number; after that the tool is
`npm deprecate`. Fix a bad release with the next patch, never by trying to replace one.

## Still missing

- **No changelog.** The git log is the record and commit bodies carry the reasoning, but a user
  deciding whether to upgrade should not have to read it.
