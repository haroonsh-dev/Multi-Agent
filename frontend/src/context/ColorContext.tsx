"use client";

import React, { createContext, useContext, ReactNode } from "react";

type ThemeColors = {
  textMuted: string;
  textPrimary: string;
  textSecondary: string;
  borderPrimary: string;
  [key: string]: string;
};

type Theme = {
  name: "dark" | "light";
  colors: ThemeColors;
};

type ColorContextValue = {
  theme: Theme;
};

/** Light theme mapped to Visibility Bots --vb-* tokens. Primary CTAs stay solid (no blue gradients). */
const lightTheme: Theme = {
  name: "light",
  colors: {
    bgPrimary: "bg-canvas",
    bgSecondary: "bg-surface-2",
    bgAppBar: "bg-surface",
    bgSidebar: "bg-surface",
    bgCard: "bg-surface",
    bgHover: "hover:bg-accent-muted",
    bgActive: "bg-accent",
    bgButton: "bg-surface-2",
    bgButtonHover: "hover:bg-surface-3",
    bgNotification: "bg-surface",
    bgProfile: "bg-surface",
    bgDialog: "bg-surface",

    textPrimary: "text-foreground",
    textSecondary: "text-foreground-secondary",
    textMuted: "text-foreground-muted",
    textInactive: "text-foreground-muted",
    textActive: "text-white",

    borderPrimary: "border-border",
    borderSecondary: "border-border",
    borderLight: "border-border",
    borderHover: "hover:border-border-strong",
    borderActive: "border-accent",
    borderActive1: "border-border-strong",

    /* Decorative only — never use on primary buttons */
    gradientPrimary: "from-[var(--vb-blue-bright)] via-[var(--vb-blue)] to-[var(--vb-blue-deep)]",
    gradientSecondary: "from-white via-[var(--vb-mist)] to-white",
    gradientButton: "bg-(--vb-color-primary-btn-bg) text-(--vb-color-primary-btn-fg)",

    iconPrimary: "text-foreground",
    iconSecondary: "text-foreground-muted",
    iconActive: "text-white",

    sidebarItemActive:
      "bg-[rgba(56,182,255,0.08)] text-accent border border-[rgba(56,182,255,0.28)] shadow-sm",
    sidebarItemInactive: "text-foreground-secondary hover:bg-slate-100 border border-transparent",
    sidebarIconBgActive: "bg-(--vb-blue) text-(--vb-color-primary-btn-fg) shadow-sm",
    sidebarIconBgInactive:
      "bg-[rgba(56,182,255,0.1)] text-(--vb-blue-dark) border border-[rgba(56,182,255,0.2)]",

    bgDarkPanel: "bg-surface",
    bgDarkPanelHover: "hover:bg-surface-2",
    bgGlassDark: "from-white via-slate-50 to-white",
    bgGlassHeader: "from-white via-slate-50 to-white",
    borderTransparent: "border-border",
    textGradientBlue: "from-[var(--vb-blue)] to-[var(--vb-blue-deep)]",
    textGradientPurple: "from-[var(--vb-blue-dark)] to-[var(--vb-blue)]",
    statusIndicator: "text-foreground-secondary",
    chartGridColor: "stroke-slate-300",
    chartAxisColor: "stroke-slate-400",

    bgDarkPanel1: "bg-surface-2",
    bgDarkPanel2: "bg-surface-3",
    bgDarkPanel3: "bg-canvas",
    bgDarkPanel4: "bg-surface",
    groupHoverPrimary: "group-hover:text-accent",

    bgGlassPanel: "bg-white/80",
    backdropBlur: "backdrop-blur-md",
    bgGradientCircle: "bg-[rgba(56,182,255,0.1)]",

    bgButtonDisabled: "bg-[rgba(56,182,255,0.14)]",
    bgButtonDisabledRed: "bg-rose-100",
    bgButtonEnabled: "bg-[rgba(56,182,255,0.1)]",
    bgButtonEnabledRed: "bg-rose-50",
    bgButtonHoverBlue: "hover:bg-[rgba(56,182,255,0.14)]",
    bgButtonHoverRed: "hover:bg-rose-100",
    textButtonDisabled: "text-(--vb-blue)",
    textButtonDisabledRed: "text-rose-500",
    textButtonEnabled: "text-(--vb-blue-dark)",
    textButtonEnabledRed: "text-rose-800",
    borderBlue: "border-[rgba(56,182,255,0.4)]",
    borderRed: "border-rose-300",
    borderBlueInner: "border-[var(--vb-blue)]",
    borderRedInner: "border-rose-400",
    bgIconBlue: "bg-[rgba(56,182,255,0.14)]",
    bgIconRed: "bg-rose-100",
    bgIconGreen: "bg-emerald-100",
    textStatusGreen: "text-emerald-600",
    textStatusRed: "text-rose-600",
    textBlue: "text-(--vb-blue-dark)",
    textRed: "text-rose-600",
    bgGradientBlue: "bg-[rgba(56,182,255,0.12)]",
    bgGradientRed: "bg-rose-100/40",
    bgCardDark: "bg-surface",
    textError: "text-rose-600",
    textSuccess: "text-emerald-600",
    bgButtonSuccess: "bg-emerald-100",
    bgButtonError: "bg-rose-100",
    textButtonSuccess: "text-emerald-700",
    textButtonError: "text-rose-700",
    accent: "text-accent",
    accentBg: "bg-accent",
    accentMuted: "bg-accent-muted",
  },
};

const ColorContext = createContext<ColorContextValue | null>(null);

export const useTheme = (): ColorContextValue => {
  const context = useContext(ColorContext);
  if (!context) {
    throw new Error("useTheme must be used within a ColorProvider");
  }
  return context;
};

export const ColorProvider = ({ children }: { children: ReactNode }) => {
  return (
    <ColorContext.Provider value={{ theme: lightTheme }}>
      {children}
    </ColorContext.Provider>
  );
};

export default ColorContext;
