import { Router } from 'express';
import { getDpeData } from '../../handlers/energy/dpe';

const router = Router();

router.get('/:dpeNumber', getDpeData);

export default router;
