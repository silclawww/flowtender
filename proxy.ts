import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isOperatorAuthorized } from '@/lib/auth';

export function proxy(request: NextRequest) {
  if (!isOperatorAuthorized(request.headers)) {
    return new NextResponse(null, {
      status: 401,
      headers: {
        'Cache-Control': 'private, no-store',
        'WWW-Authenticate': 'Basic realm="Flowtender Inspector", charset="UTF-8"',
      },
    });
  }

  const response = NextResponse.next();
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('Vary', 'Authorization');
  return response;
}

export const config = {
  matcher: ['/', '/execution/:path*', '/workflows/:path*'],
};
