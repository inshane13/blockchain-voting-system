/** @type {import('next').NextConfig} */

// connect-src stays narrow (least privilege): pinned providers plus whatever RPC
// origin is configured via NEXT_PUBLIC_RPC_URL. If you change RPC providers,
// add the new host here — do NOT widen to 'https:' (that would gut XSS
// exfiltration protection).
const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL || '';
let rpcOrigin = '';
try {
  rpcOrigin = rpcUrl ? new URL(rpcUrl).origin : '';
} catch {
  rpcOrigin = '';
}
const connectSrc = [
  "'self'",
  'https://*.alchemy.com',
  'https://*.infura.io',
  'wss://*.alchemy.com',
  'wss://*.infura.io',
  rpcOrigin,
]
  .filter(Boolean)
  .join(' ');

const nextConfig = {
  reactStrictMode: true,
  // Never advertise the framework version to clients.
  poweredByHeader: false,
  // Defense-in-depth HTTP headers. TLS/HSTS preload is enforced at the
  // hosting edge; these headers harden the app layer itself.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data:",
              "font-src 'self' data:",
              `connect-src ${connectSrc}`,
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join('; '),
          },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
