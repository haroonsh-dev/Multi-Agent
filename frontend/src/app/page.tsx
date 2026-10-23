"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getAuthValue, hasValidAccessToken } from "@/lib/authSession";

export default function HomePage() {
    const router = useRouter();

    useEffect(() => {
        if (hasValidAccessToken() || getAuthValue("accessToken")) {
            router.replace("/dashboard");
        } else {
            router.replace("/login");
        }
    }, [router]);

    return (
        <div className="min-h-screen flex items-center justify-center text-slate-400 bg-[#f4f7fb]">
            Redirecting...
        </div>
    );
}
