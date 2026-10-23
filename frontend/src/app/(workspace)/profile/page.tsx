"use client";

import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
    User, Mail, Shield, Save, Lock, CheckCircle, AlertTriangle,
    Loader2, AtSign, KeyRound, Camera, Pencil, X, UserCircle,
} from "lucide-react";
import { PageHeader } from "@/components/ui";
import { usePermissions } from "@/context/PermissionsContext";
import { getStoredUser, setAuthValue } from "@/lib/authSession";
import { apiRequest } from "@/lib/apiClient";

type StoredUser = { fullName?: string; email?: string; username?: string; role?: string; userId?: string };

function ProfileContent() {
    const { role } = usePermissions();
    const user = getStoredUser<StoredUser>();
    const displayRole = role || user?.role || "team";

    const [activeTab, setActiveTab] = useState<"profile" | "security">("profile");
    const [fullName, setFullName] = useState(user?.fullName || "");
    const [saving, setSaving] = useState(false);
    const [saveMsg, setSaveMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

    const [currentPassword, setCurrentPassword] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [changingPassword, setChangingPassword] = useState(false);
    const [pwMsg, setPwMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

    const handleSaveName = async (e: React.FormEvent) => {
        e.preventDefault(); setSaving(true); setSaveMsg(null);
        try {
            const res = await apiRequest("/auth/profile", { method: "PATCH", body: JSON.stringify({ fullName }) });
            const updatedUser = res?.data?.user;
            if (updatedUser) setAuthValue("user", JSON.stringify({ ...user, ...updatedUser }));
            setSaveMsg({ type: "success", text: "Profile updated successfully" });
        } catch (e: any) { setSaveMsg({ type: "error", text: e.message || "Failed to update profile" }); }
        finally { setSaving(false); }
    };

    const handleChangePassword = async (e: React.FormEvent) => {
        e.preventDefault();
        if (newPassword !== confirmPassword) { setPwMsg({ type: "error", text: "New passwords do not match" }); return; }
        if (newPassword.length < 6) { setPwMsg({ type: "error", text: "Password must be at least 6 characters" }); return; }
        setChangingPassword(true); setPwMsg(null);
        try {
            await apiRequest("/auth/change-password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) });
            setPwMsg({ type: "success", text: "Password changed successfully" });
            setCurrentPassword(""); setNewPassword(""); setConfirmPassword("");
        } catch (e: any) { setPwMsg({ type: "error", text: e.message || "Failed to change password" }); }
        finally { setChangingPassword(false); }
    };

    const initials = (user?.fullName || user?.username || "U").split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();

    const roleColors: Record<string, { bg: string; text: string; border: string }> = {
        superAdmin: { bg: "bg-violet-50", text: "text-violet-700", border: "border-violet-200" },
        admin: { bg: "bg-[rgba(56,182,255,0.1)]", text: "text-(--vb-blue-dark)", border: "border-[rgba(56,182,255,0.28)]" },
        team: { bg: "bg-slate-50", text: "text-slate-600", border: "border-slate-200" },
    };
    const rc = roleColors[displayRole] || roleColors.team;

    return (
        <div className="p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto space-y-4">
            <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
                <PageHeader title="Profile" subtitle="Manage your account settings and security." />
            </motion.div>

            {/* Hero Banner */}
            <motion.div
                initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.05, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                className="relative overflow-hidden rounded-2xl bg-linear-to-br from-[var(--vb-blue-dark)] via-[var(--vb-blue)] to-[var(--vb-blue-deep)] px-5 py-4 sm:px-6 sm:py-5 text-white"
            >
                <div className="absolute inset-0 opacity-10">
                    <div className="absolute -top-16 -right-16 w-48 h-48 rounded-full bg-white/20 blur-3xl" />
                    <div className="absolute -bottom-12 -left-12 w-36 h-36 rounded-full bg-white/10 blur-2xl" />
                </div>
                <div className="relative flex items-center gap-4">
                    <div className="relative group shrink-0">
                        <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-2xl bg-white/15 backdrop-blur-sm border-2 border-white/30 flex items-center justify-center text-xl sm:text-2xl font-bold tracking-tight shadow-xl">
                            {initials}
                        </div>
                        <div className="absolute inset-0 rounded-2xl bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center">
                            <Camera size={16} className="text-white opacity-0 group-hover:opacity-80 transition-opacity" />
                        </div>
                    </div>
                    <div className="flex-1 min-w-0">
                        <h2 className="text-lg sm:text-xl font-bold tracking-tight truncate">{user?.fullName || user?.username || "User"}</h2>
                        <p className="text-(--vb-blue-bright) text-xs sm:text-sm truncate">{user?.email || "No email"}</p>
                        <div className="flex flex-wrap items-center gap-1.5 mt-2">
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-white/15 backdrop-blur-sm border border-white/20">
                                <Shield size={10} /> {displayRole}
                            </span>
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-white/15 backdrop-blur-sm border border-white/20">
                                <AtSign size={10} /> @{user?.username || "user"}
                            </span>
                        </div>
                    </div>
                </div>
            </motion.div>

            {/* Tabs */}
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}
                className="flex gap-0.5 p-0.5 bg-slate-100 rounded-xl w-fit mx-auto">
                {[
                    { id: "profile" as const, label: "Personal Info", icon: UserCircle },
                    { id: "security" as const, label: "Security", icon: Lock },
                ].map((tab) => (
                    <button
                        key={tab.id}
                        type="button"
                        onClick={() => setActiveTab(tab.id)}
                        className={`relative px-4 py-2 text-xs font-semibold rounded-lg inline-flex items-center gap-1.5 transition-all ${
                            activeTab === tab.id
                                ? "text-(--vb-blue-dark)"
                                : "text-slate-500 hover:text-slate-700"
                        }`}
                    >
                        {activeTab === tab.id && (
                            <motion.div layoutId="tab-bg"
                                className="absolute inset-0 bg-white rounded-lg shadow-sm border border-slate-200/60"
                                transition={{ type: "spring", bounce: 0.15, duration: 0.4 }} />
                        )}
                        <span className="relative z-10 flex items-center gap-1.5">
                            <tab.icon size={13} /> {tab.label}
                        </span>
                    </button>
                ))}
            </motion.div>

            <AnimatePresence mode="wait">
                {activeTab === "profile" ? (
                    <motion.div key="profile"
                        initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -15 }} transition={{ duration: 0.25 }}
                        className="space-y-5"
                    >
                        {/* Info Cards */}
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                            {[
                                { icon: AtSign, label: "Username", value: user?.username || "--", accent: "cyan" },
                                { icon: Mail, label: "Email", value: user?.email || "--", accent: "violet" },
                                { icon: User, label: "Role", value: displayRole, accent: "blue" },
                            ].map((item, i) => (
                                <motion.div
                                    key={item.label}
                                    initial={{ opacity: 0, y: 10 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ delay: 0.05 + i * 0.05 }}
                                    className={`stat-card ${item.accent} p-3`}
                                >
                                    <div className="flex items-center gap-2.5">
                                        <div className={`icon-box ${item.accent}`} style={{ width: '2rem', height: '2rem' }}>
                                            <item.icon size={14} />
                                        </div>
                                        <div className="min-w-0">
                                            <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider">{item.label}</p>
                                            <p className="text-sm font-bold text-slate-800 truncate mt-0.5">{item.value}</p>
                                        </div>
                                    </div>
                                </motion.div>
                            ))}
                        </div>

                        {/* Edit Name Form */}
                        <motion.div
                            initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}
                            className="surface-card overflow-hidden"
                        >
                            <div className="px-5 py-3 border-b border-slate-100 bg-linear-to-r from-[rgba(56,182,255,0.04)] to-[rgba(63,116,255,0.03)]">
                                <div className="flex items-center gap-2.5">
                                    <div className="w-8 h-8 rounded-lg bg-(--vb-blue) text-(--vb-color-primary-btn-fg) flex items-center justify-center shadow-(--vb-glow)">
                                        <Pencil size={14} />
                                    </div>
                                    <div>
                                        <h3 className="text-sm font-bold text-slate-800">Edit Profile</h3>
                                        <p className="text-[11px] text-slate-400">Update your display name across the platform</p>
                                    </div>
                                </div>
                            </div>
                            <form onSubmit={handleSaveName} className="p-5 space-y-3">
                                <div className="space-y-1.5">
                                    <label htmlFor="fullName" className="block text-xs font-semibold text-slate-600 uppercase tracking-wider">Full Name</label>
                                    <input
                                        id="fullName"
                                        value={fullName}
                                        onChange={(e) => setFullName(e.target.value)}
                                        className="premium-input w-full h-12 px-4 text-sm rounded-xl"
                                        placeholder="Enter your full name"
                                    />
                                    <p className="text-[11px] text-slate-400">This is how your name appears across the platform.</p>
                                </div>

                                <AnimatePresence>
                                    {saveMsg && (
                                        <motion.div
                                            initial={{ opacity: 0, y: -5, height: 0 }}
                                            animate={{ opacity: 1, y: 0, height: "auto" }}
                                            exit={{ opacity: 0, y: -5, height: 0 }}
                                            className={`flex items-center gap-2.5 text-sm px-4 py-3 rounded-xl ${
                                                saveMsg.type === "success"
                                                    ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                                                    : "bg-rose-50 text-rose-700 border border-rose-200"
                                            }`}
                                        >
                                            {saveMsg.type === "success" ? <CheckCircle size={15} /> : <AlertTriangle size={15} />}
                                            {saveMsg.text}
                                        </motion.div>
                                    )}
                                </AnimatePresence>

                                <div className="flex justify-end pt-1">
                                    <button
                                        type="submit"
                                        disabled={saving || fullName === (user?.fullName || "")}
                                        className="btn-gradient rounded-xl px-6 py-2.5 text-sm font-medium inline-flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                                        {saving ? "Saving..." : "Save Changes"}
                                    </button>
                                </div>
                            </form>
                        </motion.div>
                    </motion.div>
                ) : (
                    <motion.div key="security"
                        initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -15 }} transition={{ duration: 0.25 }}
                    >
                        <div className="surface-card overflow-hidden">
                            <div className="px-5 py-3 border-b border-slate-100 bg-linear-to-r from-amber-50/50 to-orange-50/50">
                                <div className="flex items-center gap-2.5">
                                    <div className="w-8 h-8 rounded-lg bg-linear-to-br from-amber-500 to-orange-500 flex items-center justify-center shadow-md shadow-amber-500/20">
                                        <KeyRound size={14} />
                                    </div>
                                    <div>
                                        <h3 className="text-sm font-bold text-slate-800">Change Password</h3>
                                        <p className="text-[11px] text-slate-400">Keep your account secure</p>
                                    </div>
                                </div>
                            </div>
                            <div className="p-5">
                                <form onSubmit={handleChangePassword} className="space-y-3.5">
                                    <div className="space-y-1.5">
                                        <label htmlFor="currentPassword" className="block text-xs font-semibold text-slate-600 uppercase tracking-wider">Current Password</label>
                                        <input
                                            id="currentPassword"
                                            type="password"
                                            value={currentPassword}
                                            onChange={(e) => setCurrentPassword(e.target.value)}
                                            className="premium-input w-full h-12 px-4 text-sm rounded-xl"
                                            placeholder="Enter your current password"
                                            required
                                            autoFocus
                                        />
                                    </div>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                        <div className="space-y-1.5">
                                            <label htmlFor="newPassword" className="block text-xs font-semibold text-slate-600 uppercase tracking-wider">New Password</label>
                                            <input
                                                id="newPassword"
                                                type="password"
                                                value={newPassword}
                                                onChange={(e) => setNewPassword(e.target.value)}
                                                className="premium-input w-full h-12 px-4 text-sm rounded-xl"
                                                placeholder="Min 6 characters"
                                                required
                                                minLength={6}
                                            />
                                        </div>
                                        <div className="space-y-1.5">
                                            <label htmlFor="confirmPassword" className="block text-xs font-semibold text-slate-600 uppercase tracking-wider">Confirm New Password</label>
                                            <input
                                                id="confirmPassword"
                                                type="password"
                                                value={confirmPassword}
                                                onChange={(e) => setConfirmPassword(e.target.value)}
                                                className="premium-input w-full h-12 px-4 text-sm rounded-xl"
                                                placeholder="Re-enter new password"
                                                required
                                                minLength={6}
                                            />
                                        </div>
                                    </div>

                                    <AnimatePresence>
                                        {pwMsg && (
                                            <motion.div
                                                initial={{ opacity: 0, y: -5, height: 0 }}
                                                animate={{ opacity: 1, y: 0, height: "auto" }}
                                                exit={{ opacity: 0, y: -5, height: 0 }}
                                                className={`flex items-center gap-2.5 text-sm px-4 py-3 rounded-xl ${
                                                    pwMsg.type === "success"
                                                        ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                                                        : "bg-rose-50 text-rose-700 border border-rose-200"
                                                }`}
                                            >
                                                {pwMsg.type === "success" ? <CheckCircle size={15} /> : <AlertTriangle size={15} />}
                                                {pwMsg.text}
                                            </motion.div>
                                        )}
                                    </AnimatePresence>

                                    <div className="flex justify-end pt-1">
                                        <button
                                            type="submit"
                                            disabled={changingPassword || !currentPassword || !newPassword || !confirmPassword}
                                            className="btn-gradient rounded-xl px-6 py-2.5 text-sm font-medium inline-flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                                        >
                                            {changingPassword ? <Loader2 size={14} className="animate-spin" /> : <Lock size={14} />}
                                            {changingPassword ? "Updating..." : "Update Password"}
                                        </button>
                                    </div>
                                </form>
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}

export default function ProfilePage() {
    return (
        <ProfileContent />
    );
}
