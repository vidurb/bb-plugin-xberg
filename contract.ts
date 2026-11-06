// The typed RPC surface between the server entry and the host entry.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const MAX_CHARS_LIMIT = 200_000;

export const contentFormatSchema = z.enum(["markdown", "plain"]);
export const ocrModeSchema = z.enum(["default", "on", "force"]);

const statusSchema = z
  .object({
    version: z.string(),
    platform: z.string(),
    supported: z.boolean(),
    installed: z.boolean(),
    binaryPath: z.string().nullable(),
  })
  .strict();
export type XbergStatus = z.infer<typeof statusSchema>;

const extractInputSchema = z
  .object({
    /** Absolute directory that a relative `path` resolves against. */
    baseDir: z.string().min(1),
    /** Absolute directories the document must live under. */
    roots: z.array(z.string().min(1)).min(1),
    path: z.string().min(1),
    format: contentFormatSchema,
    ocr: ocrModeSchema,
    offset: z.number().int().min(0),
    maxChars: z.number().int().min(1).max(MAX_CHARS_LIMIT),
  })
  .strict();
export type ExtractInput = z.infer<typeof extractInputSchema>;

// Failures come back as data so their message reaches the agent intact.
const extractOutputSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      path: z.string(),
      mimeType: z.string().nullable(),
      content: z.string(),
      offset: z.number().int(),
      totalChars: z.number().int(),
      warnings: z.array(z.string()),
    })
    .strict(),
  z.object({ ok: z.literal(false), error: z.string() }).strict(),
]);
export type ExtractOutput = z.infer<typeof extractOutputSchema>;

export const hostContract = defineRpcContract({
  status: {
    input: z.object({}).strict(),
    output: statusSchema,
    experimental_retryable: true,
  },
  install: {
    input: z.object({}).strict(),
    output: statusSchema,
  },
  extract: {
    input: extractInputSchema,
    output: extractOutputSchema,
  },
});
