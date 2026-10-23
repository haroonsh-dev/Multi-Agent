import Document from '../models/Document';
import User from '../models/User';
import IntegrationConnection, {
    IIntegrationConnection,
    IntegrationSyncMode,
} from '../models/IntegrationConnection';
import {
    downloadGoogleDriveFile,
    listGoogleDriveFiles,
    testGoogleDriveAccess,
    type DriveRemoteFile,
} from './googleDriveService';
import { assertStorageAvailable } from './planService';
import { ensureUploadDir, saveUploadedFile } from './documentStorage';
import type { AuthUser } from './accessScope';
import logger from '../utils/logger';
import fs from 'fs';
import crypto from 'crypto';

export type LibraryFileRow = DriveRemoteFile & {
    existsInLibrary: boolean;
    documentId?: string | null;
    documentStatus?: string | null;
    duplicateMatch?: 'drive_id' | 'checksum' | 'name_size' | 'name' | null;
};

function getDriveCreds(conn: IIntegrationConnection) {
    const cfg = conn.config || {};
    const sec = conn.secrets || {};
    return {
        serviceAccountEmail: String(cfg.serviceAccountEmail || ''),
        privateKey: String(sec.privateKey || ''),
        folderId: String(cfg.folderId || ''),
        phase3Agent: String(cfg.phase3Agent || '').trim() || undefined,
    };
}

export function computeNextSyncAt(
    syncMode: IntegrationSyncMode,
    intervalMinutes: number,
    dailyAt: string,
    from: Date = new Date()
): Date | null {
    if (syncMode === 'manual') return null;
    if (syncMode === 'interval') {
        const mins = Math.max(5, Math.min(1440, intervalMinutes || 15));
        return new Date(from.getTime() + mins * 60 * 1000);
    }
    // daily
    const match = /^(\d{1,2}):(\d{2})$/.exec((dailyAt || '09:00').trim());
    const hh = match ? Math.min(23, Number(match[1])) : 9;
    const mm = match ? Math.min(59, Number(match[2])) : 0;
    const next = new Date(from);
    next.setHours(hh, mm, 0, 0);
    if (next.getTime() <= from.getTime()) {
        next.setDate(next.getDate() + 1);
    }
    return next;
}

async function resolveOrgAdmin(conn: IIntegrationConnection): Promise<AuthUser> {
    const adminUser =
        (await User.findOne({
            organizationId: conn.organizationId,
            role: 'admin',
            status: 'active',
        }).lean()) ||
        (await User.findOne({ userId: conn.createdBy, status: 'active' }).lean());

    if (!adminUser) {
        throw Object.assign(new Error('No active admin user for organization'), { statusCode: 500 });
    }

    return {
        userId: adminUser.userId,
        role: adminUser.role,
        organizationId: conn.organizationId,
    };
}

function normalizedFilename(value: string): string {
    return String(value || '').trim().toLowerCase();
}

function md5File(filePath: string): string | null {
    try {
        if (!filePath || !fs.existsSync(filePath)) return null;
        return crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex');
    } catch {
        return null;
    }
}

/**
 * Match remote Drive files against every document in the organization.
 * Drive ID is preferred; otherwise use exact content checksum, then a
 * name+size fallback for providers/files without checksum support.
 */
export async function matchDriveFilesToLibrary(
    organizationId: string,
    files: DriveRemoteFile[]
): Promise<LibraryFileRow[]> {
    if (!files.length) return [];

    const ids = files.map((f) => f.id);
    const existing = await Document.find({
        organizationId,
        'metadata.googleDriveFileId': { $in: ids },
    })
        .select('documentId status metadata.googleDriveFileId originalFilename')
        .lean();

    const byDriveId = new Map<string, { documentId: string; status: string }>();
    for (const d of existing) {
        const gid = String((d.metadata as any)?.googleDriveFileId || '');
        if (gid) byDriveId.set(gid, { documentId: d.documentId, status: d.status });
    }

    // Manual and integration uploads are both candidates. Restrict by names
    // and remote sizes to avoid hashing the whole organization library.
    const names = files.map((f) => f.name);
    const sizes = [
        ...new Set(
            files
                .map((f) => f.size)
                .filter((size): size is number => typeof size === 'number')
        ),
    ];
    const byName = await Document.find({
        organizationId,
        $or: [
            { originalFilename: { $in: names } },
            ...(sizes.length ? [{ sizeBytes: { $in: sizes } }] : []),
        ],
    })
        .select(
            'documentId status originalFilename sizeBytes storagePath contentHash metadata.googleDriveFileId metadata.googleDriveMd5Checksum'
        )
        .lean();

    const nameMap = new Map<string, typeof byName>();
    const sizeMap = new Map<number, typeof byName>();
    for (const d of byName) {
        const key = normalizedFilename(d.originalFilename);
        const rows = nameMap.get(key) || [];
        rows.push(d);
        nameMap.set(key, rows);

        const sizeRows = sizeMap.get(Number(d.sizeBytes)) || [];
        sizeRows.push(d);
        sizeMap.set(Number(d.sizeBytes), sizeRows);
    }

    return files.map((f) => {
        const idHit = byDriveId.get(f.id);
        if (idHit) {
            return {
                ...f,
                existsInLibrary: true,
                documentId: idHit.documentId,
                documentStatus: idHit.status,
                duplicateMatch: 'drive_id' as const,
            };
        }

        const sameName = nameMap.get(normalizedFilename(f.name)) || [];
        const sameSize = typeof f.size === 'number' ? sizeMap.get(f.size) || [] : [];
        const candidates = f.md5Checksum
            ? [...new Map([...sameName, ...sameSize].map((d) => [d.documentId, d])).values()]
            : sameName;
        let matched: (typeof candidates)[number] | undefined;
        let duplicateMatch: LibraryFileRow['duplicateMatch'] = null;

        if (f.md5Checksum) {
            matched = candidates.find((d) => {
                const storedMd5 = String((d.metadata as any)?.googleDriveMd5Checksum || '').toLowerCase();
                if (storedMd5 && storedMd5 === f.md5Checksum) return true;
                const localMd5 = md5File(String(d.storagePath || ''));
                return !!localMd5 && localMd5 === f.md5Checksum;
            });
            if (matched) duplicateMatch = 'checksum';
        } else if (typeof f.size === 'number') {
            matched = candidates.find((d) => Number(d.sizeBytes) === f.size);
            if (matched) duplicateMatch = 'name_size';
        } else {
            matched = candidates[0];
            if (matched) duplicateMatch = 'name';
        }

        return {
            ...f,
            existsInLibrary: !!matched,
            documentId: matched?.documentId || null,
            documentStatus: matched?.status || null,
            duplicateMatch,
        };
    });
}

export async function listDriveFilesWithLibraryStatus(
    conn: IIntegrationConnection
): Promise<LibraryFileRow[]> {
    const creds = getDriveCreds(conn);
    const files = await listGoogleDriveFiles(creds);
    return matchDriveFilesToLibrary(conn.organizationId, files);
}

export async function importDriveFiles(
    conn: IIntegrationConnection,
    fileIds?: string[]
): Promise<{
    imported: Array<{ fileId: string; name: string; documentId: string }>;
    skipped: Array<{ fileId: string; name: string; reason: string }>;
    failed: Array<{ fileId: string; name: string; error: string }>;
}> {
    const creds = getDriveCreds(conn);
    const all = await listDriveFilesWithLibraryStatus(conn);
    const selected = fileIds?.length
        ? all.filter((f) => fileIds.includes(f.id))
        : all.filter((f) => !f.existsInLibrary);

    const imported: Array<{ fileId: string; name: string; documentId: string }> = [];
    const skipped: Array<{ fileId: string; name: string; reason: string }> = [];
    const failed: Array<{ fileId: string; name: string; error: string }> = [];

    const authUser = await resolveOrgAdmin(conn);
    ensureUploadDir();

    for (const file of selected) {
        if (file.existsInLibrary && fileIds?.includes(file.id)) {
            skipped.push({ fileId: file.id, name: file.name, reason: 'Already in library' });
            continue;
        }
        if (file.existsInLibrary && !fileIds?.length) {
            skipped.push({ fileId: file.id, name: file.name, reason: 'Already in library' });
            continue;
        }

        let tmpPath = '';
        try {
            const dl = await downloadGoogleDriveFile({
                serviceAccountEmail: creds.serviceAccountEmail,
                privateKey: creds.privateKey,
                file,
            });
            tmpPath = dl.tmpPath;

            const storageCheck = await assertStorageAvailable(conn.organizationId, dl.size || 0);
            if (!storageCheck.ok) {
                failed.push({ fileId: file.id, name: file.name, error: storageCheck.message });
                if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
                continue;
            }

            const { doc } = await saveUploadedFile(
                authUser,
                {
                    path: dl.tmpPath,
                    originalname: dl.originalname,
                    mimetype: dl.mimetype,
                    size: dl.size,
                },
                creds.phase3Agent
            );

            doc.metadata = {
                ...(doc.metadata || {}),
                source: 'google_drive',
                googleDriveFileId: file.id,
                googleDriveMimeType: file.mimeType,
                ...(file.md5Checksum ? { googleDriveMd5Checksum: file.md5Checksum } : {}),
                integrationConnectionId: conn.connectionId,
                integrationLabel: conn.label,
            };
            await doc.save();

            imported.push({ fileId: file.id, name: file.name, documentId: doc.documentId });
        } catch (e: any) {
            if (e?.statusCode === 409) {
                skipped.push({ fileId: file.id, name: file.name, reason: e.message || 'Duplicate file' });
            } else {
                failed.push({ fileId: file.id, name: file.name, error: e?.message || 'Import failed' });
            }
            if (tmpPath && fs.existsSync(tmpPath)) {
                try {
                    fs.unlinkSync(tmpPath);
                } catch {
                    /* ignore */
                }
            }
        }
    }

    return { imported, skipped, failed };
}

export async function testGoogleDriveConnection(conn: IIntegrationConnection) {
    const creds = getDriveCreds(conn);
    if (!creds.privateKey) throw new Error('Private key is missing — re-save the connection with the key');
    if (!creds.folderId) throw new Error('Folder ID is required');
    return testGoogleDriveAccess(creds);
}

function advanceNextSync(conn: IIntegrationConnection) {
    conn.nextSyncAt = computeNextSyncAt(
        conn.syncMode || 'interval',
        conn.intervalMinutes || 15,
        conn.dailyAt || '09:00',
        new Date()
    );
}

function setSyncAlert(conn: IIntegrationConnection, type: 'error' | 'info', message: string) {
    conn.unreadSyncAlert = { type, message, at: new Date() };
}

/**
 * Daily → always auto-upload in backend (user online/offline).
 * Interval + intervalAutoUpload → same silent upload.
 * Interval without auto → discover missing files and store a confirm prompt (no upload).
 */
export async function runDueGoogleDriveSyncs(): Promise<void> {
    const now = new Date();
    const due = await IntegrationConnection.find({
        providerId: 'google_drive',
        isActive: true,
        autoSyncEnabled: true,
        syncMode: { $in: ['interval', 'daily'] },
        $or: [{ nextSyncAt: { $lte: now } }, { nextSyncAt: null }],
    }).limit(10);

    for (const conn of due) {
        const mode = conn.syncMode || 'interval';
        const silentUpload = mode === 'daily' || (mode === 'interval' && conn.intervalAutoUpload === true);

        try {
            if (!silentUpload) {
                // Interval confirm mode: check only, ask user later
                const listed = await listDriveFilesWithLibraryStatus(conn);
                const missing = listed.filter((f) => !f.existsInLibrary);
                conn.lastSyncAt = new Date();
                if (missing.length === 0) {
                    conn.pendingSyncPrompt = null;
                    conn.lastStatus = 'sync_ok: no new files';
                    conn.lastSyncSummary = 'imported=0, skipped=0, failed=0';
                } else {
                    const files = missing.slice(0, 50).map((f) => ({
                        id: f.id,
                        name: f.name,
                        mimeType: f.mimeType,
                        size: f.size,
                    }));
                    conn.pendingSyncPrompt = {
                        discoveredAt: new Date(),
                        files,
                        count: missing.length,
                    };
                    conn.lastStatus = `sync_awaiting_confirm: ${missing.length} file(s)`;
                    conn.lastSyncSummary = `pending=${missing.length}`;
                    logger.info(
                        `[integrations] Google Drive pending confirm ${conn.connectionId}: ${missing.length} file(s)`
                    );
                }
                advanceNextSync(conn);
                await conn.save();
                continue;
            }

            const result = await importDriveFiles(conn);
            const summary = `imported=${result.imported.length}, skipped=${result.skipped.length}, failed=${result.failed.length}`;
            conn.lastSyncAt = new Date();
            conn.lastStatus = result.failed.length ? `sync_partial: ${summary}` : `sync_ok: ${summary}`;
            conn.lastSyncSummary = summary;
            if (result.failed.length) {
                setSyncAlert(
                    conn,
                    'error',
                    `${conn.label || 'Google Drive'}: auto sync had ${result.failed.length} failure(s) (${summary}).`
                );
            }
            advanceNextSync(conn);
            await conn.save();
            logger.info(`[integrations] Google Drive sync ${conn.connectionId}: ${summary}`);
        } catch (e: any) {
            const msg = e?.message || String(e);
            conn.lastStatus = `sync_failed: ${msg}`;
            setSyncAlert(conn, 'error', `${conn.label || 'Google Drive'}: auto sync failed — ${msg}`);
            advanceNextSync(conn);
            await conn.save();
            logger.warn(`[integrations] Google Drive sync failed ${conn.connectionId}: ${msg}`);
        }
    }
}
