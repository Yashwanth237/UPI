/**
 * Build-time cleartext exception for a gateway on the local network.
 *
 * The committed network_security_config.xml allows plain HTTP only to the emulator and loopback.
 * For local testing with a physical phone, YOUPI_ANDROID_LAN_HOSTS (comma separated) names the
 * laptop's LAN IP; the build adds exactly those hosts to a copy of the file for that APK only, so
 * the committed config never carries a developer's address and HTTPS stays the default.
 * Only RFC 1918 private IPv4 addresses are accepted: plain HTTP is never allowed to the internet.
 */

const PRIVATE_IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** @param {string} host */
export function isPrivateLanIPv4(host) {
  const m = PRIVATE_IPV4.exec(String(host || ''));
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some(n => n > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * @param {string | undefined} value  e.g. "192.168.1.128" or "192.168.1.128,10.0.0.4"
 * @returns {string[]}
 */
export function parseLanHosts(value) {
  const hosts = String(value || '').split(',').map(h => h.trim()).filter(Boolean);
  for (const host of hosts) {
    if (!isPrivateLanIPv4(host)) {
      throw new Error(`YOUPI_ANDROID_LAN_HOSTS: "${host}" is not a private LAN IPv4 address (10.x, 172.16-31.x, 192.168.x). Plain HTTP is only allowed on the local network.`);
    }
  }
  return [...new Set(hosts)];
}

/**
 * Adds each host as an exact-match cleartext domain to the existing development domain-config.
 * @param {string} xml  contents of network_security_config.xml
 * @param {string[]} hosts
 */
export function applyLanHosts(xml, hosts) {
  if (!hosts.length) return xml;
  const marker = '<domain-config cleartextTrafficPermitted="true">';
  if (!xml.includes(marker)) {
    throw new Error('network_security_config.xml has no cleartext development domain-config to extend.');
  }
  const entries = hosts.map(h => `\n        <domain includeSubdomains="false">${h}</domain>`).join('');
  return xml.replace(marker, `${marker}\n        <!-- Added at build time from YOUPI_ANDROID_LAN_HOSTS -->${entries}`);
}
