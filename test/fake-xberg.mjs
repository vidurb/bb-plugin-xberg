#!/usr/bin/env node
// Stands in for the real CLI. Behaviour depends on the document's name.
import { basename } from "node:path";

const args = process.argv.slice(2);
const file = args[1];
const name = basename(file);

if (name === "fails.pdf") {
  process.stderr.write("cannot parse document\n");
  process.exit(3);
}
if (name === "hangs.pdf") setInterval(() => {}, 1000);
else if (name === "garbage.pdf") process.stdout.write("not json");
else {
  process.stdout.write(
    JSON.stringify({
      result: {
        content: `text of ${name}`,
        mime_type: "application/pdf",
        processing_warnings: [{ source: "ocr", message: "low confidence" }],
      },
      extraction_time_ms: 1,
      peak_memory_bytes: 1,
      // Lets tests assert how the process was launched.
      echo: { args, cwd: process.cwd(), env: process.env },
    }),
  );
}
