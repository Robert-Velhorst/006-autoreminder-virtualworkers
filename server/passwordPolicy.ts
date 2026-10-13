export const PASSWORD_MIN_LENGTH = 12;

export function validatePassword(password: string) {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new Error(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }
}
