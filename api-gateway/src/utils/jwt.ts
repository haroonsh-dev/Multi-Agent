import jwt from 'jsonwebtoken';
import { Response } from 'express';

export interface TokenPayload {
    userId: string;
    role: string;
    username?: string;
    organizationId?: string | null;
    realm?: string | null;
    openRemoteUserId?: string | null;
}

export const generateToken = (payload: TokenPayload): string => {
    const iat = Math.floor(Date.now() / 1000) - 300;
    return jwt.sign({ ...payload, iat } as object, process.env.JWT_SECRET as string, {
        expiresIn: process.env.JWT_EXPIRE || '30d',
    } as jwt.SignOptions);
};

export const generateRefreshToken = (payload: TokenPayload): string => {
    return jwt.sign(payload as object, process.env.JWT_REFRESH_SECRET || (process.env.JWT_SECRET as string), {
        expiresIn: process.env.JWT_REFRESH_EXPIRE || '7d',
    } as jwt.SignOptions);
};

export const verifyAccessToken = (token: string): any => {
    return jwt.verify(token, process.env.JWT_SECRET as string);
};

export const verifyRefreshToken = (token: string): any => {
    const secret = process.env.JWT_REFRESH_SECRET || (process.env.JWT_SECRET as string);
    return jwt.verify(token, secret);
};

export const sendTokenResponse = (user: any, statusCode: number, res: Response) => {
    const token = generateToken({
        userId: user.userId,
        role: user.role,
        username: user.username,
        organizationId: user.organizationId ?? null,
        realm: user.openRemoteRealm ?? null,
        openRemoteUserId: user.openRemoteUserId ?? null,
    });

    const options = {
        expires: new Date(Date.now() + parseInt(process.env.JWT_COOKIE_EXPIRE || '30') * 24 * 60 * 60 * 1000),
        httpOnly: true,
    };

    res.status(statusCode).cookie('token', token, options).json({
        success: true,
        token,
        user: {
            userId: user.userId,
            username: user.username,
            email: user.email,
            role: user.role,
            organizationId: user.organizationId,
        },
    });
};
