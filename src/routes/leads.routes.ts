import { Router, Response, NextFunction } from 'express';
import multer from 'multer';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { apolloEnrichSchema, apolloSearchSchema, csvUploadSchema, leadCreateSchema } from '../schemas/leads.schema';
import { createLead, deleteLead, enrichLead, getCsvImportProgress, listLeads, listLeadsFiltered, searchApollo, uploadCsvLeads } from '../services/leads.service';
import { parseCsv, mapHeaders } from '../lib/csv-parser';
import { enqueueCsvImport } from '../jobs/csv-import.job';
import { AppError } from '../types';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new AppError(400, 'Only CSV files are allowed') as any);
    }
  },
});

const router = Router();

router.use(authenticate);

function getOrgId(req: AuthenticatedRequest) {
  const orgId = req.organization?.id;
  if (!orgId) throw new AppError(401, 'Organization not found');
  return orgId;
}

router.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { search, status, source, page, perPage } = req.query as Record<string, string | undefined>;
    if (search || status || source || page || perPage) {
      res.json(await listLeadsFiltered(getOrgId(req), {
        search,
        status,
        source,
        page: page ? parseInt(page, 10) : undefined,
        perPage: perPage ? parseInt(perPage, 10) : undefined,
      }));
    } else {
      res.json(await listLeads(getOrgId(req)));
    }
  } catch (err) {
    next(err);
  }
});

router.post('/', validate(leadCreateSchema), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.status(201).json(await createLead(getOrgId(req), req.body));
  } catch (err) {
    next(err);
  }
});

router.post('/apollo-search', validate(apolloSearchSchema), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await searchApollo(req.body));
  } catch (err) {
    next(err);
  }
});

router.post('/apollo-enrich', validate(apolloEnrichSchema), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await enrichLead(getOrgId(req), req.body));
  } catch (err) {
    next(err);
  }
});

router.post('/csv-upload', validate(csvUploadSchema), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.status(201).json(await uploadCsvLeads(getOrgId(req), req.body));
  } catch (err) {
    next(err);
  }
});

router.post('/csv-import', upload.single('file'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    if (!req.file) throw new AppError(400, 'No CSV file uploaded');

    const content = req.file.buffer.toString('utf-8');
    const { headers, rows } = parseCsv(content);

    if (headers.length === 0) throw new AppError(400, 'CSV file is empty or has no headers');
    if (rows.length === 0) throw new AppError(400, 'CSV file has headers but no data rows');
    if (rows.length > 5000) throw new AppError(400, 'CSV file exceeds the 5,000 row limit');

    const columnMapping = req.body.columnMapping
      ? JSON.parse(req.body.columnMapping)
      : mapHeaders(headers);

    const mappedFields = Object.values(columnMapping);
    if (!mappedFields.includes('email') && !mappedFields.includes('name') &&
        !mappedFields.includes('firstName') && !mappedFields.includes('lastName')) {
      throw new AppError(400, 'CSV must have at least one identifiable column mapped (email, name, first name, or last name)');
    }

    const campaignId = req.body.campaignId || undefined;

    const job = await enqueueCsvImport({
      organizationId: getOrgId(req),
      campaignId,
      fileName: req.file.originalname,
      columnMapping,
      rows,
      totalRows: rows.length,
    });

    res.status(202).json({
      jobId: job.id,
      fileName: req.file.originalname,
      totalRows: rows.length,
      headers,
      columnMapping,
      status: 'queued',
    });
  } catch (err) {
    next(err);
  }
});

router.get('/csv-import/:jobId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const progress = await getCsvImportProgress(req.params.jobId);
    if (!progress) {
      res.json({ status: 'queued', total: 0, processed: 0, inserted: 0, skipped: 0, errors: [], fileName: '' });
      return;
    }
    res.json(progress);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await deleteLead(getOrgId(req), req.params.id));
  } catch (err) {
    next(err);
  }
});

export default router;
