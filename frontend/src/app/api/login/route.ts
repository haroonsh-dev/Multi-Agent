import { NextRequest, NextResponse } from "next/server";
import { getServerApiBase } from "@/lib/serverApiBase";
import { getRequestErrorMessage, API_UNAVAILABLE_MESSAGE } from "@/lib/apiErrors";

const GATEWAY_FETCH_MS = 20_000;

async function fetchGateway(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GATEWAY_FETCH_MS);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
            throw new Error(API_UNAVAILABLE_MESSAGE);
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const apiBase = getServerApiBase();
        const res = await fetchGateway(`${apiBase}/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                identifier: body.email || body.identifier || body.username,
                password: body.password,
            }),
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const gatewayDown = res.status === 502 || res.status === 503 || res.status === 504;
            return NextResponse.json(
                {
                    error: gatewayDown
                        ? "Cannot reach the API. Start the api-gateway on port 5100 (see api-gateway/.env)."
                        : data.message || data.error || "Login failed",
                },
                { status: res.status }
            );
        }

        return NextResponse.json(data);
    } catch (error: unknown) {
        return NextResponse.json(
            { error: getRequestErrorMessage(error, "Login failed") },
            { status: 500 }
        );
    }
}
