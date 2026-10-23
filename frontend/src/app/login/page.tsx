"use client";

import React, { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { ToastProvider, useToast } from "@/components/Toast";
import AuthLayout from "@/components/AuthLayout";
import { User, Lock, LogIn, Eye, EyeOff } from "lucide-react";
import { useRouter } from "next/navigation";
import { enrichUserFromToken, getRedirectPath, resolvePostLoginPath } from "@/lib/auth";
import { ColorProvider } from "@/context/ColorContext";
import {
    getAuthValue,
    setAuthValue,
    clearAuthState,
    isTokenExpired,
    canRefreshSession,
    hasValidAccessToken,
} from "@/lib/authSession";
import { getRequestErrorMessage } from "@/lib/apiErrors";
import { Button } from "@/components/ui";

function LoginForm() {
    const router = useRouter();
    const [identifier, setIdentifier] = useState("");
    const [password, setPassword] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [identifierFocused, setIdentifierFocused] = useState(false);
    const [passwordFocused, setPasswordFocused] = useState(false);
    const { showToast } = useToast();

    useEffect(() => {
        const token = getAuthValue("accessToken");
        const userRaw = getAuthValue("user");
        if (!token || !userRaw) return;

        if (isTokenExpired(token) && !canRefreshSession()) {
            clearAuthState();
            return;
        }

        if (!hasValidAccessToken() && !canRefreshSession()) {
            clearAuthState();
            return;
        }

        void resolvePostLoginPath(JSON.parse(userRaw)).then((path) => {
            router.replace(path);
        });
    }, [router]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsLoading(true);
        try {
            const res = await fetch("/api/login", {
                method: "POST",
                body: JSON.stringify({ email: identifier, password }),
                headers: { "Content-Type": "application/json" },
            });

            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(
                    (data as { error?: string }).error ||
                        (res.status >= 500
                            ? "Cannot reach the API. From the repo root run: npm install && npm run dev"
                            : "Login failed")
                );
            }

            if (data.data?.accessToken) setAuthValue("accessToken", data.data.accessToken);
            if (data.data?.refreshToken) setAuthValue("refreshToken", data.data.refreshToken);

            const accessToken = data.data?.accessToken || null;
            const normalizedUser = enrichUserFromToken(data.data?.user || null, accessToken);
            if (normalizedUser) setAuthValue("user", JSON.stringify(normalizedUser));
            if (data.data?.openRemoteToken) setAuthValue("openRemoteToken", data.data.openRemoteToken);
            if (normalizedUser?.permissions) setAuthValue("permissions", JSON.stringify(normalizedUser.permissions));

            showToast("Login successful! Welcome back.", "success");

            let redirectPath = getRedirectPath(normalizedUser?.accountType || "personal", normalizedUser?.role);
            if (normalizedUser?.role !== "superAdmin") {
                redirectPath = await resolvePostLoginPath(normalizedUser);
            }

            // Client-side navigation — avoids a full page reload flash after login.
            setTimeout(() => {
                router.replace(redirectPath);
            }, 600);
        } catch (error: unknown) {
            showToast(getRequestErrorMessage(error, "Invalid credentials"), "error");
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <AuthLayout>
            <div className="space-y-6">
                <div className="space-y-1.5">
                    <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground">
                        Welcome back
                    </h1>
                    <p className="text-sm text-foreground-muted leading-relaxed">
                        Sign in to your DocuGemma AI workspace.
                    </p>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="space-y-1.5">
                        <label className="text-[10px] font-semibold text-foreground-muted ml-0.5 uppercase tracking-wider">
                            Email or Username
                        </label>
                        <div className="relative">
                            <User
                                className={`absolute left-3.5 top-1/2 -translate-y-1/2 transition-colors ${
                                    identifierFocused ? "text-accent" : "text-foreground-muted"
                                }`}
                                size={16}
                            />
                            <input
                                type="text"
                                value={identifier}
                                onChange={(e) => setIdentifier(e.target.value)}
                                onFocus={() => setIdentifierFocused(true)}
                                onBlur={() => setIdentifierFocused(false)}
                                className="w-full premium-input rounded-xl py-3.5 pl-10 pr-4 text-sm"
                                placeholder="name@company.com or username"
                                required
                            />
                        </div>
                    </div>

                    <div className="space-y-1.5">
                        <label className="text-[10px] font-semibold text-foreground-muted ml-0.5 uppercase tracking-wider">
                            Password
                        </label>
                        <div className="relative">
                            <Lock
                                className={`absolute left-3.5 top-1/2 -translate-y-1/2 transition-colors ${
                                    passwordFocused ? "text-accent" : "text-foreground-muted"
                                }`}
                                size={16}
                            />
                            <input
                                type={showPassword ? "text" : "password"}
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                onFocus={() => setPasswordFocused(true)}
                                onBlur={() => setPasswordFocused(false)}
                                className="w-full premium-input rounded-xl py-3.5 pl-10 pr-12 text-sm"
                                placeholder="••••••••"
                                required
                            />
                            <button
                                type="button"
                                onClick={() => setShowPassword((v) => !v)}
                                className="absolute right-3.5 top-1/2 -translate-y-1/2 text-foreground-muted hover:text-accent transition-colors"
                            >
                                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                            </button>
                        </div>
                    </div>

                    <motion.div whileTap={{ scale: 0.98 }}>
                        <Button type="submit" disabled={isLoading} className="w-full h-12 rounded-xl text-sm" size="lg">
                            {isLoading ? (
                                "Signing in…"
                            ) : (
                                <>
                                    <LogIn size={16} />
                                    Sign in
                                </>
                            )}
                        </Button>
                    </motion.div>
                </form>
            </div>
        </AuthLayout>
    );
}

export default function LoginPage() {
    return (
        <ColorProvider>
            <ToastProvider>
                <LoginForm />
            </ToastProvider>
        </ColorProvider>
    );
}
