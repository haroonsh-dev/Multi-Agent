export default function WorkspaceLoading() {
    return (
        <div className="min-h-[50vh] flex items-center justify-center text-(--foreground-muted) relative">
            <div className="flex flex-col items-center gap-3 relative z-1">
                <div className="spinner" />
                <p className="text-sm">Loading…</p>
            </div>
        </div>
    );
}
