import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { searchDocuments } from '../controllers/searchController';

const router = Router();

router.use(authenticate);
router.post('/', searchDocuments);
router.get('/', searchDocuments);

export default router;
