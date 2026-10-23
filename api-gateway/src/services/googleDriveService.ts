import fs from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';

export type DriveRemoteFile = {
    id: string;
    name: string;
    mimeType: string;
    size?: number;
    md5Checksum?: string;
    modifiedTime?: string;
    isGoogleDoc: boolean;
};

type Creds = {
    clientEmail: string;
    privateKey: string;
};

type GoogleApis = typeof import('googleapis').google;

let googleApi: GoogleApis | null = null;

async function getGoogle(): Promise<GoogleApis> {
    if (!googleApi) {
        const mod = await import('googleapis');
        googleApi = mod.google;
    }
    return googleApi;
}

const GOOGLE_EXPORT: Record<string, { mimeType: string; ext: string }> = {
    'application/vnd.google-apps.document': {
        mimeType: 'application/pdf',
        ext: '.pdf',
    },
    'application/vnd.google-apps.spreadsheet': {
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ext: '.xlsx',
    },
    'application/vnd.google-apps.presentation': {
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        ext: '.pptx',
    },
};

function friendlyKeyError(err: unknown, hintEmail?: string): Error {
    const msg = String((err as any)?.message || err || '');
    const gMsg = String((err as any)?.response?.data?.error?.message || '');
    const reason = String(
        (err as any)?.response?.data?.error?.errors?.[0]?.reason ||
            (err as any)?.errors?.[0]?.reason ||
            ''
    );
    const combined = `${msg} ${gMsg} ${reason}`;
    const email = String(hintEmail || '').trim();

    if (/DECODER|unsupported|ERR_OSSL|PEM|private key|asn1|decrypt/i.test(combined)) {
        return new Error(
            'Google private key could not be read. Open Edit, paste the FULL service-account JSON file (or the private_key PEM block) again, Save, then Run test. Do not leave the key blank when first connecting.'
        );
    }
    if (/storageQuota/i.test(combined)) {
        return new Error(
            `Drive upload blocked for service account${email ? ` (${email})` : ''}. ` +
                `"Anyone with the link" does NOT work for service accounts. ` +
                `In Share, click Add people, paste the service-account email, set role to Editor, then Send/Share. Wait a few seconds and retry.`
        );
    }
    if (/insufficient|permission|forbidden|403|cannotAddParents/i.test(combined)) {
        return new Error(
            `Drive write denied${email ? ` for ${email}` : ''}. ` +
                `"Anyone with the link" is not enough. Add the service-account email under People with access as Editor (not Viewer), then retry.`
        );
    }
    if (/File not found|notFound|404/i.test(combined)) {
        return new Error(
            `Folder not found or not shared with the service account${email ? ` (${email})` : ''}. ` +
                `Add that email as Editor on the folder (link-only sharing does not work for service accounts).`
        );
    }
    if (gMsg && gMsg !== msg) {
        return new Error(gMsg);
    }
    return err instanceof Error ? err : new Error(msg || 'Google Drive request failed');
}

/**
 * Accept raw folder ID or a full Drive sharing URL and return the ID only.
 * e.g. https://drive.google.com/drive/folders/1AbC...?usp=sharing → 1AbC...
 */
export function normalizeFolderId(raw: string): string {
    const value = String(raw || '').trim();
    if (!value) return '';

    // /folders/ID or /folders/ID?...
    const foldersMatch = value.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    if (foldersMatch?.[1]) return foldersMatch[1];

    // open?id=ID or ?id=ID
    const idParam = value.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (idParam?.[1]) return idParam[1];

    // /file/d/ID/ or /d/ID/
    const fileMatch = value.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (fileMatch?.[1]) return fileMatch[1];

    // Already an ID (strip query leftovers if someone pasted oddly)
    return value.split(/[?#/\s]/)[0].trim();
}

/** Normalize pasted Google service-account private key / JSON into usable PEM + email. */
export function parseCredentials(serviceAccountEmail: string, privateKeyRaw: string): Creds {
    let raw = (privateKeyRaw || '').trim();
    if (!raw) {
        throw new Error(
            'Private key is missing. Edit the connection and paste the full Google service-account JSON (or PEM private_key), then Save.'
        );
    }

    // Strip accidental wrapping quotes
    if (
        (raw.startsWith('"') && raw.endsWith('"')) ||
        (raw.startsWith("'") && raw.endsWith("'"))
    ) {
        raw = raw.slice(1, -1).trim();
    }

    // Some users paste JSON with a BOM
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

    let email = (serviceAccountEmail || '').trim();
    let key = raw;

    // Full service-account JSON
    if (raw.startsWith('{')) {
        let json: any;
        try {
            json = JSON.parse(raw);
        } catch {
            throw new Error(
                'Service account JSON is invalid. Paste the entire downloaded .json file contents into the private key field.'
            );
        }
        email = String(json.client_email || email || '').trim();
        key = String(json.private_key || '');
        if (!email) {
            throw new Error('JSON is missing client_email. Paste the full service-account JSON file.');
        }
        if (!key) {
            throw new Error('JSON is missing private_key. Paste the full service-account JSON file.');
        }
    }

    // Turn escaped newlines into real newlines (common when copying JSON values)
    key = key.replace(/\\n/g, '\n').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();

    // If someone pasted only the base64 body without headers, reject clearly
    if (!/BEGIN [A-Z0-9 ]*PRIVATE KEY/.test(key)) {
        throw new Error(
            'Private key must be a PEM block (-----BEGIN PRIVATE KEY-----) or full service-account JSON. Re-paste from Google Cloud and Save.'
        );
    }

    // Ensure trailing newline (OpenSSL is picky)
    if (!key.endsWith('\n')) key += '\n';

    if (!email) {
        throw new Error('Service account email is required (or include client_email in the JSON).');
    }

    return { clientEmail: email, privateKey: key };
}

async function driveClient(creds: Creds, write = false) {
    const google = await getGoogle();
    const scopes = write
        ? ['https://www.googleapis.com/auth/drive']
        : ['https://www.googleapis.com/auth/drive.readonly'];
    const auth = new google.auth.JWT({
        email: creds.clientEmail,
        key: creds.privateKey,
        scopes,
    });
    return google.drive({ version: 'v3', auth });
}

export async function findChildFolderByName(params: {
    serviceAccountEmail: string;
    privateKey: string;
    parentFolderId: string;
    name: string;
}): Promise<string | null> {
    try {
        const creds = parseCredentials(params.serviceAccountEmail, params.privateKey);
        const drive = await driveClient(creds, true);
        const parentId = normalizeFolderId(params.parentFolderId);
        const safeName = String(params.name || '').replace(/'/g, "\\'");
        const res = await drive.files.list({
            q: `'${parentId}' in parents and trashed=false and mimeType='application/vnd.google-apps.folder' and name='${safeName}'`,
            pageSize: 5,
            fields: 'files(id,name)',
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
        });
        const hit = res.data.files?.[0];
        return hit?.id || null;
    } catch (e) {
        throw friendlyKeyError(e);
    }
}

export async function createFolder(params: {
    serviceAccountEmail: string;
    privateKey: string;
    parentFolderId: string;
    name: string;
}): Promise<string> {
    try {
        const creds = parseCredentials(params.serviceAccountEmail, params.privateKey);
        const drive = await driveClient(creds, true);
        const parentId = normalizeFolderId(params.parentFolderId);
        const res = await drive.files.create({
            requestBody: {
                name: params.name,
                mimeType: 'application/vnd.google-apps.folder',
                parents: [parentId],
            },
            fields: 'id,name',
            supportsAllDrives: true,
        });
        if (!res.data.id) throw new Error('Failed to create Drive folder');
        return res.data.id;
    } catch (e) {
        throw friendlyKeyError(e);
    }
}

/** True if the service account can see this folder/file id. */
export async function driveFolderExists(params: {
    serviceAccountEmail: string;
    privateKey: string;
    folderId: string;
}): Promise<boolean> {
    try {
        const creds = parseCredentials(params.serviceAccountEmail, params.privateKey);
        const drive = await driveClient(creds, true);
        const folderId = normalizeFolderId(params.folderId);
        if (!folderId) return false;
        await drive.files.get({
            fileId: folderId,
            fields: 'id,mimeType',
            supportsAllDrives: true,
        });
        return true;
    } catch {
        return false;
    }
}

/** Find or create a child folder under parent; returns folder id. */
export async function ensureChildFolder(params: {
    serviceAccountEmail: string;
    privateKey: string;
    parentFolderId: string;
    name: string;
}): Promise<string> {
    const existing = await findChildFolderByName(params);
    if (existing) return existing;
    return createFolder(params);
}

export async function uploadFileToDrive(params: {
    serviceAccountEmail: string;
    privateKey: string;
    parentFolderId: string;
    filename: string;
    mimeType: string;
    buffer: Buffer;
}): Promise<{ id: string; name: string; webViewLink?: string }> {
    let clientEmail = String(params.serviceAccountEmail || '').trim();
    try {
        const creds = parseCredentials(params.serviceAccountEmail, params.privateKey);
        clientEmail = creds.clientEmail;
        const drive = await driveClient(creds, true);
        const parentId = normalizeFolderId(params.parentFolderId);
        if (!parentId) {
            throw new Error('Drive folder ID is missing. Edit the connection and paste the folder ID or URL again.');
        }
        const { Readable } = await import('stream');
        const stream = Readable.from(params.buffer);

        const res = await drive.files.create({
            requestBody: {
                name: params.filename,
                parents: [parentId],
            },
            media: {
                mimeType: params.mimeType || 'application/octet-stream',
                body: stream,
            },
            fields: 'id,name,webViewLink',
            supportsAllDrives: true,
        });
        if (!res.data.id) throw new Error('Drive upload failed — no file id returned');
        return {
            id: res.data.id,
            name: res.data.name || params.filename,
            webViewLink: res.data.webViewLink || undefined,
        };
    } catch (e) {
        throw friendlyKeyError(e, clientEmail);
    }
}


export async function testGoogleDriveAccess(params: {
    serviceAccountEmail: string;
    privateKey: string;
    folderId: string;
}): Promise<{ ok: true; fileCount: number; folderId: string; canWrite: boolean }> {
    let clientEmail = String(params.serviceAccountEmail || '').trim();
    try {
        const creds = parseCredentials(params.serviceAccountEmail, params.privateKey);
        clientEmail = creds.clientEmail;
        const driveRead = await driveClient(creds, false);
        const driveWrite = await driveClient(creds, true);
        const folderId = normalizeFolderId(params.folderId);
        if (!folderId) throw new Error('Folder ID is required');

        await driveRead.files.get({
            fileId: folderId,
            fields: 'id,name,mimeType',
            supportsAllDrives: true,
        });

        const listed = await driveRead.files.list({
            q: `'${folderId}' in parents and trashed=false`,
            pageSize: 10,
            fields: 'files(id)',
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
        });

        // Probe write: create + delete a tiny file (Send needs Editor, not Viewer)
        let canWrite = false;
        try {
            const { Readable } = await import('stream');
            const probe = await driveWrite.files.create({
                requestBody: {
                    name: `.visibilitydocs_write_probe_${Date.now()}.txt`,
                    parents: [folderId],
                },
                media: {
                    mimeType: 'text/plain',
                    body: Readable.from(Buffer.from('ok', 'utf8')),
                },
                fields: 'id',
                supportsAllDrives: true,
            });
            if (probe.data.id) {
                try {
                    await driveWrite.files.delete({
                        fileId: probe.data.id,
                        supportsAllDrives: true,
                    });
                } catch {
                    /* ignore cleanup failure */
                }
            }
            canWrite = true;
        } catch (writeErr) {
            throw friendlyKeyError(writeErr, clientEmail);
        }

        return {
            ok: true,
            fileCount: listed.data.files?.length || 0,
            folderId,
            canWrite,
        };
    } catch (e) {
        throw friendlyKeyError(e, clientEmail);
    }
}

export async function listGoogleDriveFiles(params: {
    serviceAccountEmail: string;
    privateKey: string;
    folderId: string;
}): Promise<DriveRemoteFile[]> {
    try {
        const creds = parseCredentials(params.serviceAccountEmail, params.privateKey);
        const drive = await driveClient(creds);
        const folderId = normalizeFolderId(params.folderId);
        if (!folderId) throw new Error('Folder ID is required');

        const out: DriveRemoteFile[] = [];
        let pageToken: string | undefined;

        do {
            const res = await drive.files.list({
                q: `'${folderId}' in parents and trashed=false and mimeType != 'application/vnd.google-apps.folder'`,
                pageSize: 100,
                pageToken,
                fields: 'nextPageToken, files(id,name,mimeType,size,md5Checksum,modifiedTime)',
                orderBy: 'modifiedTime desc',
                supportsAllDrives: true,
                includeItemsFromAllDrives: true,
            });
            for (const f of res.data.files || []) {
                if (!f.id || !f.name) continue;
                const mime = f.mimeType || 'application/octet-stream';
                out.push({
                    id: f.id,
                    name: f.name,
                    mimeType: mime,
                    size: f.size ? Number(f.size) : undefined,
                    md5Checksum: f.md5Checksum ? String(f.md5Checksum).toLowerCase() : undefined,
                    modifiedTime: f.modifiedTime || undefined,
                    isGoogleDoc: mime.startsWith('application/vnd.google-apps.'),
                });
            }
            pageToken = res.data.nextPageToken || undefined;
        } while (pageToken);

        return out;
    } catch (e) {
        throw friendlyKeyError(e);
    }
}

export async function downloadGoogleDriveFile(params: {
    serviceAccountEmail: string;
    privateKey: string;
    file: DriveRemoteFile;
}): Promise<{ tmpPath: string; originalname: string; mimetype: string; size: number }> {
    try {
        const creds = parseCredentials(params.serviceAccountEmail, params.privateKey);
        const drive = await driveClient(creds);
        const tmpPath = path.join(os.tmpdir(), `gdrive_${uuidv4()}`);

        const exportInfo = GOOGLE_EXPORT[params.file.mimeType];
        let originalname = params.file.name;
        let mimetype = params.file.mimeType;

        if (exportInfo) {
            if (!originalname.toLowerCase().endsWith(exportInfo.ext)) {
                originalname = `${originalname}${exportInfo.ext}`;
            }
            mimetype = exportInfo.mimeType;
            const res = await drive.files.export(
                { fileId: params.file.id, mimeType: exportInfo.mimeType },
                { responseType: 'arraybuffer' }
            );
            const buf = Buffer.from(res.data as ArrayBuffer);
            fs.writeFileSync(tmpPath, buf);
            return { tmpPath, originalname, mimetype, size: buf.length };
        }

        if (params.file.mimeType.startsWith('application/vnd.google-apps.')) {
            throw new Error(`Unsupported Google Workspace type: ${params.file.mimeType}`);
        }

        const res = await drive.files.get(
            { fileId: params.file.id, alt: 'media', supportsAllDrives: true },
            { responseType: 'arraybuffer' }
        );
        const buf = Buffer.from(res.data as ArrayBuffer);
        fs.writeFileSync(tmpPath, buf);
        return { tmpPath, originalname, mimetype, size: buf.length };
    } catch (e) {
        throw friendlyKeyError(e);
    }
}
