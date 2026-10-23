import nodemailer from 'nodemailer';
import logger from '../utils/logger';

export function isEmailConfigured(): boolean {
    return Boolean(
        String(process.env.EMAIL_USERNAME || '').trim() &&
            String(process.env.EMAIL_PASSWORD || '').trim()
    );
}

export async function sendHtmlEmail(params: {
    to: string | string[];
    subject: string;
    html: string;
}): Promise<void> {
    const host = process.env.EMAIL_HOST || 'smtp.gmail.com';
    const port = Number(process.env.EMAIL_PORT || 587);
    const username = String(process.env.EMAIL_USERNAME || '').trim();
    const password = String(process.env.EMAIL_PASSWORD || '').trim();
    const from = String(process.env.EMAIL_FROM || username || '').trim();

    if (!username || !password) {
        throw Object.assign(
            new Error(
                'Email is not configured. Set EMAIL_USERNAME and EMAIL_PASSWORD (and optionally EMAIL_HOST, EMAIL_PORT, EMAIL_FROM) on the api-gateway.'
            ),
            { statusCode: 400 }
        );
    }

    const recipients = (Array.isArray(params.to) ? params.to : [params.to])
        .map((e) => String(e || '').trim())
        .filter(Boolean);
    if (!recipients.length) {
        throw Object.assign(new Error('No recipients specified'), { statusCode: 400 });
    }

    const transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user: username, pass: password },
    });

    await transporter.sendMail({
        from: from || username,
        to: recipients.join(', '),
        subject: params.subject,
        html: params.html,
    });

    logger.info(`[email] Sent "${params.subject}" to ${recipients.join(', ')}`);
}
