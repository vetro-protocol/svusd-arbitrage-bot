/**
 * Log-safe rendering of thrown errors.
 *
 * RPC client errors quote the request that failed, which embeds the endpoint URL. For a
 * hosted provider that URL carries the project key, so an error logged verbatim publishes
 * a credential to wherever the logs go. Everything reaching a console goes through here.
 */

/**
 * Characters kept from one error. RPC errors quote whole request bodies and run to tens of KB,
 * but the reason is printed last, so the cap has to clear a full client error or it truncates
 * exactly the line worth reading.
 */
const MAX_LENGTH = 1_200;
/** A line past this is a payload dump (raw calldata, a signed tx), never useful in a log. */
const MAX_LINE_LENGTH = 200;
/**
 * A bare hex run of credential length, not part of an 0x-prefixed value. 32 is a hosted-RPC
 * project id, 64 a private key; addresses and tx hashes keep their 0x and are left readable.
 */
const BARE_HEX_SECRET = /(?<![0-9a-zA-Z_])(?:[0-9a-f]{32}|[0-9a-f]{64})(?![0-9a-zA-Z_])/gi;
/** Scheme plus everything up to the next whitespace; the authority is split out below. */
const URL_PATTERN = /\bhttps?:\/\/\S+/gi;

/** Strip the credential-bearing parts of any URL, keeping the host so the failure stays diagnosable. */
export function redactSecrets(text: string): string {
  return text
    .replace(URL_PATTERN, (url) => {
      const scheme = url.slice(0, url.indexOf("//") + 2);
      const rest = url.slice(scheme.length);
      const pathStart = rest.search(/[/?#]/);
      const authority = pathStart === -1 ? rest : rest.slice(0, pathStart);
      // Strip any user:password@ prefix along with the path, query and fragment.
      const host = authority.slice(authority.indexOf("@") + 1);
      return pathStart === -1 ? `${scheme}${host}` : `${scheme}${host}/<redacted>`;
    })
    .replace(BARE_HEX_SECRET, "<redacted>");
}

/** One-line, secret-free, length-capped rendering of anything thrown. */
export function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const text = redactSecrets(raw)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && line.length <= MAX_LINE_LENGTH)
    .join(" | ");
  return text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH)}…` : text;
}

/**
 * Redacted first line only. The executor surfaces `detail` on /status and in job logs, where a
 * client's full trace is noise: the revert reason is what the operator acts on.
 */
export function errorSummary(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const first = redactSecrets(raw).split("\n")[0].trim();
  return first.length > MAX_LINE_LENGTH ? `${first.slice(0, MAX_LINE_LENGTH)}\u2026` : first;
}
