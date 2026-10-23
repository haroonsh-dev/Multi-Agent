"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "@/lib/apiClient";

export type SystemMonitorAlert = {
    id: string;
    severity: "critical" | "warning" | "info";
    title: string;
    detail?: string;
    href?: string;
};

export type SystemMonitorData = {
    timestamp: string;
    services: {
        apiGateway: "ok";
        aiEngine: "ok" | "degraded" | "offline";
        groqLimited: boolean;
    };
    pipeline: {
        total: number;
        processed: number;
        processing: number;
        failed: number;
        successRate: number;
        uploadsLast24h: number;
        stuckProcessing: number;
    };
    agents: Array<{
        agentId: string;
        documentCount: number;
        readyCount: number;
    }>;
    integrations: {
        connected: number;
        active: number;
        items: Array<{
            connectionId: string;
            label: string;
            providerId: string;
            agentId: string | null;
            lastSyncAt: string | null;
            lastStatus: string | null;
            hasAlert: boolean;
            alertMessage?: string;
        }>;
    } | null;
    activity: Array<{
        logId: string;
        action: string;
        category: string;
        outcome: string;
        message?: string;
        actorName?: string;
        createdAt: string;
    }>;
    alerts: SystemMonitorAlert[];
};

const POLL_MS = 30_000;

export function useSystemMonitor(enabled = true) {
    const [data, setData] = useState<SystemMonitorData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [live, setLive] = useState(true);
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const load = useCallback(async (silent = false) => {
        if (!silent) setLoading(true);
        setError(null);
        try {
            const res = await apiRequest("/docs/system/monitor");
            setData(res?.data as SystemMonitorData);
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : "Failed to load system monitor");
        } finally {
            if (!silent) setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (!enabled) return;
        void load();
    }, [enabled, load]);

    useEffect(() => {
        if (!enabled || !live) {
            if (timerRef.current) clearInterval(timerRef.current);
            timerRef.current = null;
            return;
        }
        timerRef.current = setInterval(() => void load(true), POLL_MS);
        return () => {
            if (timerRef.current) clearInterval(timerRef.current);
        };
    }, [enabled, live, load]);

    return { data, loading, error, live, setLive, refresh: () => load() };
}
