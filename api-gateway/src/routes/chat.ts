import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import {
    chatWithDocuments,
    deleteChatSessionHandler,
    getChatAnalyticsHandler,
    getChatSessionHandler,
    listChatModelsHandler,
    listChatSessionsHandler,
    renameChatSessionHandler,
    submitFeedback,
} from '../controllers/chatController';

const router = Router();

router.get('/sessions', authenticate, listChatSessionsHandler);
router.get('/analytics', authenticate, getChatAnalyticsHandler);
router.get('/models', authenticate, listChatModelsHandler);
router.get('/sessions/:id', authenticate, getChatSessionHandler);
router.patch('/sessions/:id', authenticate, renameChatSessionHandler);
router.delete('/sessions/:id', authenticate, deleteChatSessionHandler);
router.post('/', authenticate, chatWithDocuments);
router.post('/feedback', authenticate, submitFeedback);

export default router;
