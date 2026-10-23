import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const MONGODB_URI = process.env.MONGO_URI;

if (!MONGODB_URI) {
    throw new Error('Please define the MONGO_URI environment variable inside .env');
}

const dbConnect = async (): Promise<void> => {
    try {
        const conn = await mongoose.connect(MONGODB_URI, {
            bufferCommands: false,
            serverSelectionTimeoutMS: 5000,
            // Larger pool so the 4-5 parallel requests on a page load don't queue.
            maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE || 20),
            minPoolSize: 0,
        });
        console.log(`MongoDB Connected: ${conn.connection.host}/${conn.connection.name}`);
    } catch (error) {
        const message = (error as Error).message;
        console.error(`MongoDB Error: ${message}`);
        console.error('Start MongoDB locally or set MONGO_URI in backend/.env');
        process.exit(1);
    }
};

export default dbConnect;
