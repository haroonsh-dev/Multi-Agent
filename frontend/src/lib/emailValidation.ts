const EMAIL_RE =
    /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

export function isValidEmail(value: string): boolean {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 254) return false;
    return EMAIL_RE.test(trimmed);
}

export function emailValidationMessage(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return "Email is required";
    if (!isValidEmail(trimmed)) return "Enter a valid email address";
    return null;
}
