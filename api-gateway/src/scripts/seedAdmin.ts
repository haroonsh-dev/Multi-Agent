/**
 * Seed superAdmin, admin (+ org), and team users for local testing.
 */
import dotenv from 'dotenv';
import bcrypt from 'bcrypt';
import dbConnect from '../config/db';
import User, { defaultPermissionsForRole } from '../models/User';
import Organization from '../models/Organization';
import openRemoteService from '../services/openRemoteService';

dotenv.config();

function generateUserId() {
    return `usr_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
}

async function createOrUser(email: string, username: string, fullName: string, realm: string) {
    if (process.env.OPENREMOTE_ENABLED === 'false') return { userId: undefined, secret: undefined, realm };
    try {
        const or = await openRemoteService.createUser({ username, email, fullName, role: 'admin', realm });
        return { userId: or.userId || undefined, secret: or.openRemoteSecret || undefined, realm: or.realm || realm };
    } catch (e: any) {
        if (process.env.ALLOW_LOCAL_SEED === 'true') {
            console.warn(`OpenRemote skipped for ${email}: ${e.message}`);
            return { userId: undefined, secret: undefined, realm };
        }
        throw e;
    }
}

async function upsertUser(opts: {
    email: string;
    password: string;
    fullName: string;
    role: 'superAdmin' | 'admin' | 'team';
    organizationId?: string | null;
    createdBy?: string | null;
    openRemoteRealm?: string;
}) {
    const normalizedEmail = opts.email.toLowerCase();
    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) {
        console.log(`Exists: ${normalizedEmail} (${existing.role})`);
        return existing;
    }

    const username = normalizedEmail.split('@')[0];
    const passwordHash = await bcrypt.hash(opts.password, 12);
    const userId = generateUserId();
    const or = await createOrUser(normalizedEmail, username, opts.fullName, opts.openRemoteRealm || 'personal');

    const user = await User.create({
        userId,
        username,
        fullName: opts.fullName,
        email: normalizedEmail,
        passwordHash,
        role: opts.role,
        accountType: opts.role === 'superAdmin' ? 'personal' : 'enterprise',
        organizationId: opts.organizationId ?? null,
        createdBy: opts.createdBy ?? null,
        permissions: defaultPermissionsForRole(opts.role),
        status: 'active',
        openRemoteRealm: or.realm,
        openRemoteSynced: !!or.userId,
        openRemoteSyncedAt: or.userId ? new Date() : undefined,
        openRemoteUserId: or.userId,
        openRemoteSecret: or.secret,
    });
    console.log(`Created ${opts.role}: ${normalizedEmail} / ${opts.password}`);
    return user;
}

async function main() {
    await dbConnect();

    const superPwd = process.env.SEED_SUPER_PASSWORD;
    const adminPwd = process.env.SEED_ADMIN_PASSWORD;
    const teamPwd = process.env.SEED_TEAM_PASSWORD;
    if (!superPwd || !adminPwd || !teamPwd) {
        console.error(
            'Seed passwords must be provided via environment (no defaults are allowed):\n' +
            '  SEED_SUPER_PASSWORD, SEED_ADMIN_PASSWORD, SEED_TEAM_PASSWORD'
        );
        process.exit(1);
    }

    await upsertUser({
        email: process.env.SEED_SUPER_EMAIL || 'super@docs.visibilitybots.com',
        password: superPwd,
        fullName: 'Docs Super Admin',
        role: 'superAdmin',
    });

    let org = await Organization.findOne({ organizationName: 'Acme Exports' });
    if (!org) {
        org = await Organization.create({
            organizationId: `org_seed_${Date.now()}`,
            organizationName: 'Acme Exports',
            contactEmail: 'admin@acme.docs',
            status: 'active',
            subscriptionPlan: 'free',
            openRemoteRealm: 'acme_exports',
        });
    }

    let admin = await User.findOne({ email: (process.env.SEED_ADMIN_EMAIL || 'admin@docs.visibilitybots.com').toLowerCase() });
    if (!admin) {
        admin = await upsertUser({
            email: process.env.SEED_ADMIN_EMAIL || 'admin@docs.visibilitybots.com',
            password: adminPwd,
            fullName: 'Docs AI Admin',
            role: 'admin',
            organizationId: org.organizationId,
            openRemoteRealm: org.openRemoteRealm || 'acme_exports',
        });
    } else {
        admin.organizationId = org.organizationId;
        admin.role = 'admin';
        admin.permissions = defaultPermissionsForRole('admin') as any;
        await admin.save();
        console.log(`Updated existing admin org: ${admin.email}`);
    }

    await upsertUser({
        email: process.env.SEED_TEAM_EMAIL || 'team@docs.visibilitybots.com',
        password: teamPwd,
        fullName: 'Docs Team Member',
        role: 'team',
        organizationId: org.organizationId,
        createdBy: admin.userId,
        openRemoteRealm: org.openRemoteRealm || 'acme_exports',
    });

    await upsertUser({
        email: process.env.SEED_TEAM2_EMAIL || 'team2@docs.visibilitybots.com',
        password: teamPwd,
        fullName: 'Docs Team Member 2',
        role: 'team',
        organizationId: org.organizationId,
        createdBy: admin.userId,
        openRemoteRealm: org.openRemoteRealm || 'acme_exports',
    });

    console.log('\nSeed complete.');
    console.log(`superAdmin: ${process.env.SEED_SUPER_EMAIL || 'super@docs.visibilitybots.com'} / ${superPwd}`);
    console.log(`admin: ${process.env.SEED_ADMIN_EMAIL || 'admin@docs.visibilitybots.com'} / ${adminPwd}`);
    console.log(`team: ${process.env.SEED_TEAM_EMAIL || 'team@docs.visibilitybots.com'} / ${teamPwd}`);
    console.log(`team2: ${process.env.SEED_TEAM2_EMAIL || 'team2@docs.visibilitybots.com'} / ${teamPwd}`);
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
