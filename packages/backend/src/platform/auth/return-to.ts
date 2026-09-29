const fallbackReturnTo = "/projects";
const trustedReturnToOrigin = "https://return-to.invalid";

const containsControlCharacter = (value: string): boolean =>
  Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });

const hasSafePathShape = (value: string): boolean =>
  value.startsWith("/") &&
  !value.startsWith("//") &&
  !value.includes("\\") &&
  !containsControlCharacter(value);

export const resolveReturnTo = (value: string | undefined): string => {
  if (value === undefined || !hasSafePathShape(value)) {
    return fallbackReturnTo;
  }

  let normalized: URL;
  let effectivePathname: string;
  try {
    normalized = new URL(value, trustedReturnToOrigin);
    effectivePathname = decodeURI(normalized.pathname);
  } catch {
    return fallbackReturnTo;
  }

  if (
    normalized.origin !== trustedReturnToOrigin ||
    !hasSafePathShape(normalized.pathname) ||
    !hasSafePathShape(effectivePathname) ||
    effectivePathname === "/auth" ||
    effectivePathname.startsWith("/auth/")
  ) {
    return fallbackReturnTo;
  }

  return `${normalized.pathname}${normalized.search}${normalized.hash}`;
};
