import { NextResponse } from "next/server";

// Chrome/Cursor DevTools probe — not a debug target; avoids noisy 404 logs
export async function GET() {
  return NextResponse.json({
    Browser: "DocuGemma AI Frontend",
    "Protocol-Version": "1.0",
    webSocketDebuggerUrl: "",
  });
}
