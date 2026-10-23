/**
 * Seed default agent/storage pricing + starter named plans.
 * Usage: npx ts-node src/scripts/seedPlans.ts
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { ensureDefaultPlansAndPricing } from '../services/planSeed';

dotenv.config();

async function main() {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!uri) {
        console.error('MONGODB_URI not set');
        process.exit(1);
    }
    await mongoose.connect(uri);
    console.log('Seeding plans & pricing…');
    const result = await ensureDefaultPlansAndPricing();
    console.log(`  Pricing: ready`);
    console.log(`  Plans created: ${result.plansCreated}`);
    console.log(`  Plans already present (skipped): ${result.plansSkipped}`);
    await mongoose.disconnect();
    console.log('Done.');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
