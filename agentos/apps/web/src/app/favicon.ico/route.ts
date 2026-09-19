export function GET(): Response {
  return new Response(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#d2673b"/><path d="M32 14c10.7 0 18 7.5 18 18s-7.3 18-18 18-18-7.5-18-18 7.3-18 18-18Z" fill="none" stroke="white" stroke-width="5" stroke-linecap="round"/><circle cx="32" cy="14" r="7" fill="white"/><circle cx="47" cy="42" r="7" fill="white"/><circle cx="17" cy="42" r="7" fill="white"/></svg>',
    { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' } },
  );
}
