import { Router } from 'express';

const router = Router();

// TODO: implement lead CRUD, apollo search/enrich, csv upload
router.get('/', (req, res) => res.json({ todo: 'list leads' }));
router.post('/', (req, res) => res.json({ todo: 'create lead' }));
router.post('/apollo-search', (req, res) => res.json({ todo: 'apollo search' }));
router.post('/apollo-enrich', (req, res) => res.json({ todo: 'apollo enrich' }));
router.post('/csv-upload', (req, res) => res.json({ todo: 'csv upload' }));
router.delete('/:id', (req, res) => res.json({ todo: 'delete lead', id: req.params.id }));

export default router;
