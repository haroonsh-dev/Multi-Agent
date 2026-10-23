import { NextResponse } from "next/server";

// Chrome/Cursor DevTools probe — not a debug target; avoids noisy 404 logs
export async function GET() {
  return NextResponse.json([]);
}
