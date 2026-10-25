import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const connectDB = async () => {
    try {
        const mongoURI = process.env.MONGODB_URL;
        if (!mongoURI) {
            console.error('MONGODB_URL is not defined in the .env file');
            process.exit(1);
        }
        const configuredPoolSize = Number(process.env.MONGODB_MAX_POOL_SIZE);
        const maxPoolSize =
            Number.isFinite(configuredPoolSize) && configuredPoolSize > 0
                ? Math.floor(configuredPoolSize)
                : 10;
        const configuredMinPoolSize = Number(process.env.MONGODB_MIN_POOL_SIZE);
        const minPoolSize =
            Number.isFinite(configuredMinPoolSize) && configuredMinPoolSize >= 0
                ? Math.min(Math.floor(configuredMinPoolSize), maxPoolSize)
                : 1;
        await mongoose.connect(mongoURI, {
            maxPoolSize,
            minPoolSize,
            serverSelectionTimeoutMS: 10_000,
        });
        console.log('MongoDB connected successfully');
    } catch (error) {
        console.error('Error connecting to MongoDB:', error);
        process.exit(1);
    }
};

export default connectDB;
