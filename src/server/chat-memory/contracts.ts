import { z } from "zod";

export const CONTRACT_VERSION = 1;
export const SUMMARY_CODE_POINT_LIMIT = 8_000;
export const RAW_WINDOW_MAX_MESSAGES = 50;
export const RAW_WINDOW_MAX_CODE_POINTS = 24_000;

const BIGINT_MIN = -9_223_372_036_854_775_808n;
const BIGINT_MAX = 9_223_372_036_854_775_807n;

export function codePointLength(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length;) {
    const code = value.codePointAt(index);
    if (code === undefined) break;
    count += 1;
    index += code > 0xffff ? 2 : 1;
  }
  return count;
}

export function codePointSlice(value: string, maxCodePoints: number): string {
  if (maxCodePoints <= 0) return "";
  let count = 0;
  let index = 0;
  while (index < value.length && count < maxCodePoints) {
    const code = value.codePointAt(index);
    if (code === undefined) break;
    index += code > 0xffff ? 2 : 1;
    count += 1;
  }
  return value.slice(0, index);
}

function withinBigInt(value: string, min: bigint, max: bigint): boolean {
  try {
    const numeric = BigInt(value);
    return numeric >= min && numeric <= max;
  } catch {
    return false;
  }
}

export const telegramChatIdSchema = z
  .string()
  .regex(/^-?[1-9]\d{0,18}$/)
  .refine((value) => withinBigInt(value, BIGINT_MIN, BIGINT_MAX), {
    message: "Telegram chat ID is outside bigint range",
  });

export const turnIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/);

export const timestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

const nonnegativeBigintSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,18})$/)
  .refine((value) => withinBigInt(value, 0n, BIGINT_MAX));

const positiveBigintSchema = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine((value) => withinBigInt(value, 1n, BIGINT_MAX));

const positiveSummaryVersionSchema = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine((value) => withinBigInt(value, 1n, BIGINT_MAX));

export const getChatMemoryInputSchema = z
  .object({
    telegram_chat_id: telegramChatIdSchema,
    exclude_turn_id: turnIdSchema.optional(),
  })
  .strict();

export const pendingMessageSchema = z
  .object({
    raw_message_id: positiveBigintSchema,
    event_key: z.string().min(1).max(300),
    turn_id: turnIdSchema,
    source_update_id: nonnegativeBigintSchema,
    role: z.enum(["user", "assistant"]),
    content: z
      .string()
      .min(1)
      .refine((value) => codePointLength(value) <= RAW_WINDOW_MAX_CODE_POINTS),
    occurred_at: timestampSchema,
    content_truncated: z.boolean(),
  })
  .strict();

export const summarySchema = z
  .object({
    text: z
      .string()
      .min(1)
      .refine((value) => codePointLength(value) <= SUMMARY_CODE_POINT_LIMIT),
    version: positiveSummaryVersionSchema,
    updated_at: timestampSchema,
  })
  .strict();

export const getChatMemoryOutputSchema = z
  .object({
    contract_version: z.literal(CONTRACT_VERSION),
    telegram_chat_id: telegramChatIdSchema,
    summary: z.union([summarySchema, z.null()]),
    pending_messages: z
      .array(pendingMessageSchema)
      .max(RAW_WINDOW_MAX_MESSAGES),
    window: z
      .object({
        returned_messages: z.number().int().nonnegative(),
        returned_characters: z.number().int().nonnegative(),
        has_more_pending: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.window.returned_messages !== value.pending_messages.length) {
      context.addIssue({
        code: "custom",
        message: "returned_messages does not match pending_messages",
      });
    }
    const characters = value.pending_messages.reduce(
      (total, message) => total + codePointLength(message.content),
      0,
    );
    if (value.window.returned_characters !== characters) {
      context.addIssue({
        code: "custom",
        message: "returned_characters does not match pending content",
      });
    }
    if (characters > RAW_WINDOW_MAX_CODE_POINTS) {
      context.addIssue({
        code: "custom",
        message: "pending content exceeds the code-point budget",
      });
    }
  });

export type GetChatMemoryInput = z.infer<typeof getChatMemoryInputSchema>;
export type GetChatMemoryOutput = z.infer<typeof getChatMemoryOutputSchema>;

export function emptyChatMemory(telegramChatId: string): GetChatMemoryOutput {
  return {
    contract_version: CONTRACT_VERSION,
    telegram_chat_id: telegramChatId,
    summary: null,
    pending_messages: [],
    window: {
      returned_messages: 0,
      returned_characters: 0,
      has_more_pending: false,
    },
  };
}
