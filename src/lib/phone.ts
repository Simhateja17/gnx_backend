const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

export function normalizePhoneForCalling(value: string, timezone?: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const compact = trimmed.replace(/[\s().-]/g, '');
  const international = compact.startsWith('00') ? `+${compact.slice(2)}` : compact;
  if (E164_PATTERN.test(international)) return international;

  const digits = international.replace(/\D/g, '');
  if (timezone === 'Asia/Kolkata') {
    if (/^[6-9]\d{9}$/.test(digits)) return `+91${digits}`;
    if (/^0[6-9]\d{9}$/.test(digits)) return `+91${digits.slice(1)}`;
    if (/^91[6-9]\d{9}$/.test(digits)) return `+${digits}`;
  }

  return null;
}

export function isE164Phone(value: string) {
  return E164_PATTERN.test(value);
}
