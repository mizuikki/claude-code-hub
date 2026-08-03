export const USER_API_KEY_MIN_LENGTH = 16;
export const USER_API_KEY_MAX_LENGTH = 2048;
export const USER_API_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isValidUserApiKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= USER_API_KEY_MIN_LENGTH &&
    value.length <= USER_API_KEY_MAX_LENGTH &&
    USER_API_KEY_PATTERN.test(value)
  );
}
