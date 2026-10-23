/**
 * Seed default Leader / Employee / Manager org-roles for every organization.
 * Usage: npx ts-node src/scripts/seedOrgRoles.ts
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Organization from '../models/Organization';
import { ensureDefaultOrgRoles } from '../services/orgRoleSeed';

dotenv.config();

async function main() {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!uri) {
        console.error('MONGODB_URI not set');
        process.exit(1);
    }
    await mongoose.connect(uri);
    const orgs = await Organization.find({}).select('organizationId organizationName').lean();
    console.log(`Seeding roles for ${orgs.length} organization(s)…`);
    for (const org of orgs) {
        await ensureDefaultOrgRoles(org.organizationId);
        console.log(`  ✓ ${org.organizationName || org.organizationId}`);
    }
    await mongoose.disconnect();
    console.log('Done.');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
