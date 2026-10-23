import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { groqStatusHandler, setGroqKeyHandler } from '../controllers/groqController';

const router = Router();

router.get('/status', authenticate, groqStatusHandler);
router.post('/api-key', authenticate, setGroqKeyHandler);

export default router;
