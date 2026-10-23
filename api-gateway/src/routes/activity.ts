import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { listActivity, listActivityActors } from '../controllers/activityController';

const router = Router();

router.get('/', authenticate, listActivity);
router.get('/actors', authenticate, listActivityActors);

export default router;
