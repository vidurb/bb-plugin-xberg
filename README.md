# Xberg for BB

Lets [BB](https://getbb.app) agents read PDFs, Word, Excel and PowerPoint files,
scanned images, email and other documents with
[Xberg](https://github.com/xberg-io/xberg).

Extraction runs on the machine that holds the thread's workspace. The server
loads the plugin, and each enrolled machine runs `xberg` itself, so documents
stay on that machine and agents pass file paths instead of file contents.

## Install

```sh
bb plugin install https://github.com/vidurb/bb-plugin-xberg
```

There is nothing else to set up. The first extraction on a machine downloads the
pinned Xberg release (a 50–90 MB download), checks its SHA-256 against a digest in this
plugin, and unpacks it to the plugin's data directory on that machine. It needs
to reach `github.com`, and `tar` must be on the machine.

To check or install ahead of time, or to delete cached text:

```sh
bb xberg status --machine <name>
bb xberg install --machine <name>
bb xberg cache clear --machine <name>
```

Supported machines: Apple Silicon macOS, and Linux on x86-64 or arm64. Linux uses
the musl builds, which bundle their own loader and libraries.

## The tool

`xberg_extract` takes:

| Parameter   | Default    | Meaning                                                      |
| ----------- | ---------- | ------------------------------------------------------------ |
| `path`      | required   | Absolute, or relative to the workspace                       |
| `format`    | `markdown` | `markdown` or `plain`                                        |
| `ocr`       | `default`  | `default`, `on` for scanned documents, `force` to always OCR |
| `offset`    | `0`        | Character offset to read from                                |
| `max_chars` | `20000`    | Most characters to return in one call, at most 200,000       |

Longer documents are read a page at a time, and the result gives the next
`offset`. Some agents cap how much a tool can return: Claude Code allows about
25,000 tokens, so keep `max_chars` near the default there.

## Limits and safety

- **Paths:** the real file, after following symlinks, must be inside the thread's
  workspace, its own thread storage, or the storage of the thread it was forked or
  spawned from. Prompt attachments live in thread storage. URLs are refused, and
  so are files with other hard links. If the file is replaced while Xberg reads
  it, the text isn't returned. This narrows what the tool reads, but it isn't a
  security boundary: a process that can change the files can still race it.
- **No workspace:** a thread without a workspace environment can't use the tool,
  even for its own attachments.
- **Config:** Xberg runs with `--no-config-discovery` in its own working
  directory, so an `xberg.toml` in a workspace has no effect.
- **Environment:** Xberg gets only `PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL` and
  the `HTTP(S)_PROXY` and `NO_PROXY` variables, not the daemon's environment.
- **Proxies:** Xberg can use a proxy to fetch OCR language packs, but the plugin's
  own download of Xberg doesn't. On a network that needs a proxy, install Xberg
  from a machine that doesn't, or copy the release into place by hand.
- **Resources:** two extractions at a time per machine and 256 MiB per file. Xberg
  is stopped after 10 minutes, when its call is cancelled, and when the plugin
  reloads or its worker stops. The first download and unpacking are stopped after
  5 minutes. Calls waiting for a free slot count against the server's 15-minute
  limit.
- **Pages:** each page runs the extraction again. Xberg's cache usually answers
  repeat calls, but a cache miss, such as after `bb xberg cache clear`, repeats
  the full extraction, and a file changed between calls can shift offsets.
- **Output:** the document text is wrapped in begin and end markers, so the agent
  can tell it from the plugin's own lines.
- **Not a sandbox:** Xberg parses untrusted files as your user, and can make
  network requests, for example to fetch OCR models.
- **Cache:** Xberg keeps extracted text readable in the plugin's data directory on
  each machine, so repeat reads are quick. Xberg limits the extraction cache to
  30 days and 2 GB. Its OCR cache has no limit, so check the size with
  `bb xberg status` and clear both with `bb xberg cache clear`.

## Development

```sh
npm ci
npm run typecheck
npm test
bb plugin build .
```

Tests use a fake `xberg`, so they don't check the real CLI's behaviour. To change
the Xberg version, update `XBERG_RELEASE` in `lib/release.ts` with the digests
from the GitHub release, then try it on a real document.
