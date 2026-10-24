import { Router } from 'express';
import * as c from '../controllers/sales.controller';
import { validate } from '../middleware/validate';
import { requireAnyPermission, requirePermission } from '../middleware/rbac';
import {
  blockedDateSchema, catalogCreateSchema, catalogListQuery, catalogUpdateSchema, checkQuery, enquiryPageSchema, idParamOnly, rangeQuery, rangeQueryOptional, salesSettingsSchema, templateImportSchema,
} from '../validators/sales.validator';

export const catalogRouter = Router();
catalogRouter.get('/', requireAnyPermission('CATALOG_VIEW', 'CATALOG_MANAGE', 'QUOTATION_CREATE'), validate({ query: catalogListQuery }), c.listCatalog);
catalogRouter.post('/', requirePermission('CATALOG_MANAGE'), validate({ body: catalogCreateSchema }), c.createCatalogItem);
catalogRouter.get('/templates', requireAnyPermission('CATALOG_VIEW', 'CATALOG_MANAGE', 'QUOTATION_CREATE'), c.listTemplates);
catalogRouter.post('/templates/import', requirePermission('CATALOG_MANAGE'), validate({ body: templateImportSchema }), c.importTemplates);
catalogRouter.post('/templates/confirm-prices', requirePermission('CATALOG_MANAGE'), c.confirmPrices);
catalogRouter.post('/starter', requirePermission('CATALOG_MANAGE'), c.seedCatalog);
catalogRouter.patch('/:id', requirePermission('CATALOG_MANAGE'), validate({ params: idParamOnly, body: catalogUpdateSchema }), c.updateCatalogItem);
catalogRouter.delete('/:id', requirePermission('CATALOG_MANAGE'), validate({ params: idParamOnly }), c.deleteCatalogItem);

export const salesSetupRouter = Router();
salesSetupRouter.get('/readiness', requireAnyPermission('BOOKING_SETUP_MANAGE', 'CATALOG_VIEW', 'QUOTATION_CREATE', 'QUOTATION_VIEW'), c.readiness);
salesSetupRouter.get('/settings', requireAnyPermission('BOOKING_SETUP_MANAGE', 'CATALOG_VIEW', 'QUOTATION_CREATE', 'QUOTATION_VIEW'), c.getSettings);
salesSetupRouter.put('/settings', requirePermission('BOOKING_SETUP_MANAGE'), validate({ body: salesSettingsSchema }), c.updateSettings);
salesSetupRouter.get('/enquiry-page', requireAnyPermission('BOOKING_SETUP_MANAGE', 'CATALOG_VIEW', 'QUOTATION_VIEW'), c.getEnquiryPage);
salesSetupRouter.put('/enquiry-page', requirePermission('BOOKING_SETUP_MANAGE'), validate({ body: enquiryPageSchema }), c.updateEnquiryPage);
salesSetupRouter.get('/blocked-dates', requireAnyPermission('BOOKING_SETUP_MANAGE', 'PROJECT_VIEW', 'QUOTATION_VIEW'), validate({ query: rangeQueryOptional }), c.listBlocked);
salesSetupRouter.post('/blocked-dates', requirePermission('BOOKING_SETUP_MANAGE'), validate({ body: blockedDateSchema }), c.createBlocked);
salesSetupRouter.delete('/blocked-dates/:id', requirePermission('BOOKING_SETUP_MANAGE'), validate({ params: idParamOnly }), c.deleteBlocked);
salesSetupRouter.get('/availability', requireAnyPermission('BOOKING_SETUP_MANAGE', 'PROJECT_VIEW', 'QUOTATION_VIEW', 'QUOTATION_CREATE'), validate({ query: rangeQuery }), c.calendar);
salesSetupRouter.get('/availability/check', requireAnyPermission('BOOKING_SETUP_MANAGE', 'PROJECT_VIEW', 'PROJECT_CREATE', 'QUOTATION_VIEW', 'QUOTATION_CREATE'), validate({ query: checkQuery }), c.checkDate);
