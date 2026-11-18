/** "Chrome on macOS"-style label for emails and the sessions list; falls back to "an unknown device". */
export function describeUserAgent(ua: string | undefined): string {
  if (!ua) return 'an unknown device';
  const browser =
    /Edg\//.test(ua) ? 'Edge'
      : /OPR\//.test(ua) ? 'Opera'
        : /Firefox\//.test(ua) ? 'Firefox'
          : /Chrome\//.test(ua) ? 'Chrome'
            : /Safari\//.test(ua) ? 'Safari'
              : /Code\/|vscode/i.test(ua) ? 'VS Code'
                : /curl|node|axios|python|go-http/i.test(ua) ? 'a script'
                  : 'a browser';
  const os =
    /iPhone|iPad/.test(ua) ? 'iOS'
      : /Android/.test(ua) ? 'Android'
        : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
          : /Windows/.test(ua) ? 'Windows'
            : /Linux/.test(ua) ? 'Linux'
              : '';
  return os ? `${browser} on ${os}` : browser;
}
