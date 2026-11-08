Agents get an `xberg_extract` tool, so you can point them at a document and ask about it. Attach a file to your message or name one in the workspace. The text comes back into the thread, ready to summarize, compare or quote.

## What you get

- **Office files and PDFs.** PDF, Word, Excel and PowerPoint come back as Markdown or plain text. Spreadsheets arrive as Markdown tables, with each sheet under its own heading.
- **Text in images.** OCR reads text from images, and can be turned on for scanned documents. Check OCR output against the source when the numbers matter, because misreads come with no warning.
- **Other formats.** Xberg lists about 100 document formats, including email, HTML and EPUB. Only the formats above have been tested with this plugin.
- **Long documents.** Each call returns up to 20,000 characters by default, and tells the agent which offset to read next, so it can stop once it has what it needs.

## How it works

Extraction runs on the machine that holds the thread's workspace, and agents pass file paths rather than file contents. The plugin doesn't upload your files anywhere, but the extracted text goes into the thread, so it reaches whichever model provider runs the agent. No account or API key is involved.

The tool adds one line to every thread's instructions, telling agents to use it for binary documents instead of shell tools, and ships a short skill describing its options.

The first extraction on a machine downloads a pinned release of [Xberg](https://github.com/xberg-io/xberg), an MIT-licensed document extraction tool, from GitHub. The plugin checks the download against a SHA-256 digest before unpacking it. To check a machine or install ahead of time, run `bb xberg status` or `bb xberg install`.

## Limits on what it reads

The tool only reads files inside the thread's workspace, its own thread storage, or the storage of the thread it was forked or spawned from. It follows symlinks before checking, so a link can't point it elsewhere. It takes local files only, not URLs.

Each machine runs two extractions at a time, with a limit of 256 MiB per file and 10 minutes per extraction.

## Requirements and costs

- Apple Silicon macOS, or Linux on x86-64 or arm64. Intel Macs and Windows aren't supported.
- Disk on each machine that runs extractions: about 120 MB for Xberg on macOS and 230 MB on Linux, plus its caches. Xberg keeps extracted text for up to 30 days and 2 GB, and its OCR cache has no size limit. `bb xberg status` shows the size, and `bb xberg cache clear` empties both.
- `tar` on the machine, to unpack the download.
- Network access for the first download, and for the OCR language pack the first time OCR runs.

## Security

Xberg runs as your user and parses whatever documents you give it. The plugin passes it only `PATH`, `HOME`, `TMPDIR` and locale variables, and ignores Xberg config files in the workspace. It doesn't sandbox the process, so Xberg can still reach the network and read any file your user can.

The cached text sits in readable form in the plugin's data directory on each machine.
