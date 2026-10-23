import assert from 'node:assert/strict';
import crypto from 'crypto';
import dotenv from 'dotenv';
import fs from 'fs';
import mongoose from 'mongoose';
import os from 'os';
import path from 'path';
import Document from '../models/Document';
import { matchDriveFilesToLibrary } from '../services/integrationSyncService';

dotenv.config();

async function main() {
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGO_URI is required');

    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const organizationId = `integration_duplicate_test_org_${suffix}`;
    const documentId = `integration_duplicate_test_doc_${suffix}`;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-integration-duplicate-'));
    const storagePath = path.join(tmpDir, 'manual-original.pdf');
    const content = Buffer.from(`exact integration duplicate test ${suffix}`);
    fs.writeFileSync(storagePath, content);

    const md5Checksum = crypto.createHash('md5').update(content).digest('hex');
    const contentHash = crypto.createHash('sha256').update(content).digest('hex');

    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    try {
        await Document.create({
            documentId,
            organizationId,
            uploadedBy: `integration_duplicate_test_user_${suffix}`,
            originalFilename: 'manual-original.pdf',
            storedFilename: 'manual-original.pdf',
            mimeType: 'application/pdf',
            sizeBytes: content.length,
            storagePath,
            contentHash,
            status: 'ready',
            visibilityScope: 'personal',
            metadata: { source: 'web_upload' },
        });

        const rows = await matchDriveFilesToLibrary(organizationId, [
            {
                id: `drive-renamed-${suffix}`,
                name: 'renamed-in-drive.pdf',
                mimeType: 'application/pdf',
                size: content.length,
                md5Checksum,
                isGoogleDoc: false,
            },
            {
                id: `drive-different-${suffix}`,
                name: 'manual-original.pdf',
                mimeType: 'application/pdf',
                size: content.length,
                md5Checksum: '00000000000000000000000000000000',
                isGoogleDoc: false,
            },
            {
                id: `drive-fallback-${suffix}`,
                name: 'manual-original.pdf',
                mimeType: 'application/pdf',
                size: content.length,
                isGoogleDoc: false,
            },
        ]);

        assert.equal(rows[0].existsInLibrary, true);
        assert.equal(rows[0].duplicateMatch, 'checksum');
        assert.equal(rows[0].documentId, documentId);

        assert.equal(rows[1].existsInLibrary, false);
        assert.equal(rows[1].duplicateMatch, null);

        assert.equal(rows[2].existsInLibrary, true);
        assert.equal(rows[2].duplicateMatch, 'name_size');

        console.log('Integration duplicate matching passed.');
    } finally {
        await Document.deleteMany({ organizationId });
        await mongoose.disconnect();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
