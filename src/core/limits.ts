/**
 * Server caps, mirrored from `spec/limits.json` and asserted against it by a test.
 *
 * Enforced locally so a value that would be REJECTED is trimmed or dropped before it costs a
 * request. The server does not truncate an oversize string: it refuses the whole event, so
 * "send it and see" loses data.
 */

/** Events + identify entries, combined, per /v1/batch request. */
export const MAX_BATCH_ITEMS = 1000;

/** Errors per /v1/errors request. */
export const MAX_ERROR_ITEMS = 50;

export const MAX_PROPERTIES_PER_EVENT = 255;
export const MAX_STRING_BYTES = 255;
export const MAX_DEPTH = 3;

export const MAX_EXCEPTIONS = 5;
export const MAX_FRAMES = 50;
export const MAX_TYPE_BYTES = 256;
export const MAX_MESSAGE_BYTES = 8192;
export const MAX_STACK_RAW_BYTES = 16384;
export const MAX_FRAME_STRING_BYTES = 512;
export const MAX_EXCEPTIONS_BYTES = 262_144;
export const MAX_TAGS = 32;
export const MAX_TAG_KEY_BYTES = 32;
export const MAX_TAG_VALUE_BYTES = 200;
export const MAX_FINGERPRINT_PARTS = 8;
export const MAX_FINGERPRINT_PART_BYTES = 128;

/** The server keeps only the last 50, so anything above this is bytes on the wire for nothing. */
export const MAX_BREADCRUMBS = 50;
export const MAX_BREADCRUMBS_BYTES = 32_768;

export const MAX_TRAIT_VALUE_BYTES = 255;
export const MAX_TRAIT_KEY_BYTES = 128;
export const MAX_TRAITS_PER_REQUEST = 100;
export const MAX_TRAIT_REQUEST_BYTES = 8192;

/** Compressed request ceiling. */
export const MAX_REQUEST_BYTES = 5_242_880;

/** Timestamps outside this window are rejected, so a spooled event older than it is dead weight. */
export const TIMESTAMP_PAST_MS = 7 * 24 * 3_600_000;
export const TIMESTAMP_FUTURE_MS = 3_600_000;

/** The only levels the server stores. Anything else silently becomes `error`. */
export const LEVELS = ['fatal', 'error', 'warning', 'info'] as const;
export type Level = (typeof LEVELS)[number];

export const MECHANISMS = ['onerror', 'onunhandledrejection', 'uncaughtException', 'unhandledRejection', 'manual'] as const;
export type Mechanism = (typeof MECHANISMS)[number];
