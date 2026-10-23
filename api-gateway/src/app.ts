import express, { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';
import authRoutes from './routes/auth';
import documentsRoutes from './routes/documents';
import chatRoutes from './routes/chat';
import searchRoutes from './routes/search';
import healthRoutes from './routes/health';
import teamRoutes from './routes/team';
import superAdminRoutes from './routes/superAdmin';
import activityRoutes from './routes/activity';
import groqRoutes from './routes/groq';
import departmentRoutes from './routes/departments';
import settingsRoutes from './routes/settings';
import plansRoutes from './routes/plans';
import integrationsRoutes from './routes/integrations';
import emailReportsRoutes from './routes/emailReports';
import agentsToolsRoutes from './routes/agentsTools';
import { agentApiPublicRouter, agentApiAdminRouter } from './routes/agentApi';
import mcpSseRouter from './mcp/sse';
import { errorHandler, notFound } from './middleware/errorHandler';
import { authenticate } from './middleware/auth';
import { listAllDocumentIntelligence, reprocessDocument } from './controllers/documentsController';

dotenv.config();

const app: Express = express();
app.disable('etag');

// CORS: credentials require explicit origins — never fall back to '*' with
// credentials (browsers reject it and it silently disables auth cookies).
// Dev fallback covers the documented local ports; production must set FRONTEND_URL.
const corsOrigins = process.env.FRONTEND_URL
    ? process.env.FRONTEND_URL.split(',').map((url) => url.trim())
    : ['http://localhost:3124', 'http://127.0.0.1:3124'];
if (!process.env.FRONTEND_URL) {
    console.warn('[app] FRONTEND_URL is not set — CORS falling back to localhost dev origins.');
}

app.use(
    cors({
        origin: corsOrigins,
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Integration-Key'],
        exposedHeaders: ['set-cookie'],
    })
);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(morgan('dev'));
// Keep JSON small — large files use multipart/multer (disk), not JSON bodies
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '2mb' }));
app.use(express.urlencoded({ extended: true, limit: process.env.JSON_BODY_LIMIT || '2mb' }));
app.use(cookieParser());

app.get('/', (_req, res) => {
    res.json({
        name: 'DocuGemma AI API',
        version: '1.0.0',
        docs: '/api/health',
    });
});

// Chrome DevTools / V8 inspector discovery probe endpoint
app.get(['/json', '/json/version'], (_req, res) => {
    res.json({
        Browser: 'DocuGemma-API/1.0.0',
        'Protocol-Version': '1.3',
    });
});

app.use('/api/health', healthRoutes);
app.use('/api/auth', authRoutes);
app.get('/api/docs/documents/intelligence/all', authenticate, listAllDocumentIntelligence);
app.post('/api/docs/documents/:id/reprocess', authenticate, reprocessDocument);
app.post('/api/docs/documents/:id/process', authenticate, reprocessDocument);
// Namespaced for easy merge into Visibility Live app.ts as one mount
app.use('/api/docs/documents', documentsRoutes);
app.use('/api/docs/chat', chatRoutes);
app.use('/api/docs/search', searchRoutes);
app.use('/api/docs/team', teamRoutes);
app.use('/api/docs/activity', activityRoutes);
app.use('/api/docs/groq', groqRoutes);
app.use('/api/docs/departments', departmentRoutes);
app.use('/api/docs/settings', settingsRoutes);
app.use('/api/docs/plans', plansRoutes);
app.use('/api/docs/integrations', integrationsRoutes);
app.use('/api/docs/email-reports', emailReportsRoutes);
app.use('/api/docs/super-admin', superAdminRoutes);
app.use('/api/docs/agents', agentsToolsRoutes);
app.use('/api/docs/agent-api', agentApiAdminRouter);
/** Public Agent Ask API for external apps (Bearer / X-Agent-Key). */
app.use('/api/v1/agents', agentApiPublicRouter);
/**
 * MCP (Model Context Protocol) server — lets external AI clients (Claude
 * Desktop, other MCP hosts) connect over SSE and call the 7 domain tools /
 * resources / prompts. Was fully built (src/mcp/*) but never mounted, so no
 * request ever reached it. Auth: same AgentApiToken (vdag_...) bearer key as
 * /api/v1/agents above — GET /api/mcp/sse to open a session, POST
 * /api/mcp/messages?sessionId=... to send JSON-RPC.
 */
app.use('/api/mcp', mcpSseRouter);

app.use(notFound);
app.use(errorHandler);

export default app;
