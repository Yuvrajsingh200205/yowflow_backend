import { FileVisibility } from '@prisma/client';
import { Prisma, prisma } from '../config/prisma';
import { andWhere, paginate, searchFilter } from '../repositories/base.repository';
import { badRequest, forbidden, notFound } from '../utils/errors';
import { AuthContext } from '../types';
import { AuditRequestContext, recordAudit } from './audit.service';
import { buildObjectKey, createSignedUrl, createUploadUrl, getStorageProvider } from './storage.service';
import { env } from '../config/env';
import { canAccessAllLeads } from './lead.service';
import { scopedProjectWhere } from './project.service';

export function listFiles(
  auth: AuthContext,
  query: {
    page?: number;
    limit?: number;
    entityType?: string;
    entityId?: string;
    projectId?: string;
    search?: string;
  },
) {
  return paginate(prisma.fileObject, {
    where: andWhere(
      accessibleFileWhere(auth),
      query.entityType ? { entityType: query.entityType } : undefined,
      query.entityId ? { entityId: query.entityId } : undefined,
      query.projectId ? { projectId: query.projectId } : undefined,
      searchFilter(query.search, ['originalName']),
    ),
    orderBy: { createdAt: 'desc' },
    page: query.page,
    limit: query.limit,
    include: { uploadedBy: { select: { id: true, fullName: true } } },
  });
}

type FileResourceRef = {
  entityType: string;
  entityId?: string | null;
  projectId?: string | null;
};

const EMPLOYEE_DOCUMENT_TYPES = new Set(['USER', 'EMPLOYEE', 'EMPLOYEE_DOCUMENT', 'TEAM_DOCUMENT']);
const FREELANCER_DOCUMENT_TYPES = new Set(['FREELANCER', 'FREELANCER_DOCUMENT']);
const PROJECT_DOCUMENT_TYPES = new Set(['PROJECT', 'PROJECT_CLIENT_ASSET', 'PROJECT_FILE']);
const CLIENT_DOCUMENT_TYPES = new Set(['CLIENT', 'CLIENT_DOCUMENT']);
const LEAD_DOCUMENT_TYPES = new Set(['LEAD', 'LEAD_DOCUMENT', 'LEAD_QUOTATION']);
const ORG_DOCUMENT_TYPES = new Set(['ORGANIZATION', 'ORG', 'SYSTEM_SETTING', 'SETTING']);

function accessibleFileWhere(auth: AuthContext): Prisma.FileObjectWhereInput {
  return andWhere(
    { organizationId: auth.organizationId, deletedAt: null, isRegistered: true },
    {
      OR: [
        { uploadedById: auth.userId, projectId: null },
        { project: scopedProjectWhere(auth) },
        { projectId: null, entityType: { in: [...ORG_DOCUMENT_TYPES] } },
        auth.permissions.has('EMPLOYEE_DOCUMENTS_VIEW') || auth.permissions.has('EMPLOYEE_DOCUMENTS_MANAGE')
          ? { projectId: null, entityType: { in: [...EMPLOYEE_DOCUMENT_TYPES] } }
          : undefined,
        auth.permissions.has('FREELANCER_VIEW')
          ? { projectId: null, entityType: { in: [...FREELANCER_DOCUMENT_TYPES] } }
          : undefined,
        canAccessAllLeads(auth)
          ? { projectId: null, entityType: { in: [...LEAD_DOCUMENT_TYPES] } }
          : undefined,
        auth.permissions.has('PROJECT_VIEW_ALL') || auth.permissions.has('USER_VIEW')
          ? { projectId: null, entityType: { in: [...CLIENT_DOCUMENT_TYPES] } }
          : undefined,
      ].filter(Boolean) as Prisma.FileObjectWhereInput[],
    },
  ) as Prisma.FileObjectWhereInput;
}

async function assertLeadFileAccess(auth: AuthContext, leadId: string | null | undefined) {
  if (!leadId) throw forbidden('Lead-linked files must reference a lead');
  const lead = await prisma.lead.findFirst({
    where: {
      id: leadId,
      organizationId: auth.organizationId,
      deletedAt: null,
      ...(canAccessAllLeads(auth) ? {} : { ownerId: auth.userId }),
    },
    select: { id: true },
  });
  if (!lead) throw notFound('File');
}

async function assertClientFileAccess(auth: AuthContext, clientId: string | null | undefined) {
  if (!clientId) throw forbidden('Client-linked files must reference a client');
  const client = await prisma.client.findFirst({
    where: {
      id: clientId,
      organizationId: auth.organizationId,
      deletedAt: null,
      ...(auth.permissions.has('PROJECT_VIEW_ALL') || auth.permissions.has('USER_VIEW')
        ? {}
        : { projects: { some: scopedProjectWhere(auth) } }),
    },
    select: { id: true },
  });
  if (!client) throw notFound('File');
}

async function assertEmployeeDocumentAccess(auth: AuthContext, userId: string | null | undefined, manage = false) {
  if (!userId) throw forbidden('Employee documents must reference an employee');
  if (manage) {
    if (!auth.permissions.has('EMPLOYEE_DOCUMENTS_MANAGE')) throw forbidden('EMPLOYEE_DOCUMENTS_MANAGE permission is required');
  } else if (!auth.permissions.has('EMPLOYEE_DOCUMENTS_VIEW') && !auth.permissions.has('EMPLOYEE_DOCUMENTS_MANAGE')) {
    throw forbidden('EMPLOYEE_DOCUMENTS_VIEW permission is required');
  }
  const user = await prisma.user.findFirst({
    where: { id: userId, organizationId: auth.organizationId, deletedAt: null },
    select: { id: true },
  });
  if (!user) throw notFound('File');
}

async function assertFreelancerFileAccess(auth: AuthContext, freelancerId: string | null | undefined) {
  if (!freelancerId) throw forbidden('Freelancer documents must reference a freelancer');
  if (!auth.permissions.has('FREELANCER_VIEW')) throw forbidden('FREELANCER_VIEW permission is required');
  const freelancer = await prisma.freelancer.findFirst({
    where: { id: freelancerId, organizationId: auth.organizationId, deletedAt: null },
    select: { id: true },
  });
  if (!freelancer) throw notFound('File');
}

async function assertProjectFileAccess(auth: AuthContext, projectId: string | null | undefined) {
  if (!projectId) throw forbidden('Project files must reference a project');
  const project = await prisma.project.findFirst({
    where: scopedProjectWhere(auth, { id: projectId }),
    select: { id: true },
  });
  if (!project) throw notFound('File');
}

async function assertFileResourceAccess(auth: AuthContext, ref: FileResourceRef, mode: 'read' | 'write' | 'delete') {
  const normalized = ref.entityType.trim().toUpperCase();
  if (ref.projectId || PROJECT_DOCUMENT_TYPES.has(normalized)) {
    await assertProjectFileAccess(auth, ref.projectId ?? ref.entityId);
    return;
  }
  if (LEAD_DOCUMENT_TYPES.has(normalized)) {
    await assertLeadFileAccess(auth, ref.entityId);
    return;
  }
  if (CLIENT_DOCUMENT_TYPES.has(normalized)) {
    await assertClientFileAccess(auth, ref.entityId);
    return;
  }
  if (EMPLOYEE_DOCUMENT_TYPES.has(normalized)) {
    await assertEmployeeDocumentAccess(auth, ref.entityId, mode !== 'read');
    return;
  }
  if (FREELANCER_DOCUMENT_TYPES.has(normalized)) {
    await assertFreelancerFileAccess(auth, ref.entityId);
    return;
  }
  if (ORG_DOCUMENT_TYPES.has(normalized)) return;

  if (!ref.entityId && !ref.projectId) return;
  throw forbidden(`Files cannot be attached to unsupported resource type ${ref.entityType}`);
}

/**
 * Issues the object key and a short-lived upload URL. The client PUTs the
 * bytes straight to the storage provider, then calls `registerFile` — the API
 * process never proxies file content.
 */
export async function createUploadIntent(
  auth: AuthContext,
  input: { entityType: string; originalName: string; mimeType: string; projectId?: string },
) {
  await assertFileResourceAccess(auth, { entityType: input.entityType, projectId: input.projectId }, 'write');

  const objectKey = buildObjectKey(auth.organizationId, input.entityType, input.originalName);
  const bucket = env.STORAGE_BUCKET;
  // A presigned PUT, which is a different signature from the GET used for
  // downloads on the S3-compatible providers.
  const signed = createUploadUrl(objectKey, bucket);

  // The signed PUT has no authenticated request body. For DATABASE storage,
  // reserve the FileObject first so the PUT can write bytes to this exact,
  // unregistered row; the existing registration endpoint completes it.
  if (getStorageProvider() === 'DATABASE') {
    await prisma.fileObject.create({
      data: {
        organizationId: auth.organizationId,
        uploadedById: auth.userId,
        entityType: input.entityType,
        projectId: input.projectId,
        storageProvider: 'DATABASE',
        bucket,
        objectKey,
        originalName: input.originalName,
        mimeType: input.mimeType,
        sizeBytes: BigInt(0),
        isRegistered: false,
      },
    });
  }

  return {
    bucket,
    objectKey,
    provider: getStorageProvider(),
    uploadUrl: signed.url,
    expiresAt: signed.expiresAt,
    requiredHeaders: { 'content-type': input.mimeType },
  };
}

export interface RegisterFileInput {
  entityType: string;
  entityId?: string;
  projectId?: string;
  bucket: string;
  objectKey: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  checksum?: string;
  visibility?: FileVisibility;
  metadata?: Record<string, unknown>;
}

export async function registerFile(
  auth: AuthContext,
  input: RegisterFileInput,
  ctx: AuditRequestContext,
) {
  await assertFileResourceAccess(auth, input, 'write');

  if (getStorageProvider() === 'DATABASE') {
    const pending = await prisma.fileObject.findFirst({
      where: {
        organizationId: auth.organizationId,
        bucket: input.bucket,
        objectKey: input.objectKey,
        storageProvider: 'DATABASE',
        isRegistered: false,
        deletedAt: null,
      },
      select: { id: true, entityType: true, projectId: true, content: true },
    });
    if (!pending?.content) throw badRequest('The file upload has not completed.');
    if (pending.content.byteLength !== input.sizeBytes) {
      throw badRequest('The registered file size does not match the uploaded content.');
    }
    if (pending.entityType !== input.entityType || pending.projectId !== input.projectId) {
      throw badRequest('The upload intent does not match this file registration.');
    }
    const file = await prisma.fileObject.update({
      where: { id: pending.id },
      data: {
        originalName: input.originalName,
        mimeType: input.mimeType,
        sizeBytes: BigInt(input.sizeBytes),
        checksum: input.checksum,
        visibility: input.visibility ?? FileVisibility.PRIVATE,
        metadata: input.metadata as Prisma.InputJsonValue | undefined,
        isRegistered: true,
      },
    });
    await recordAudit(prisma, ctx, {
      action: 'CREATE', entityType: 'FileObject', entityId: file.id,
      summary: `File ${file.originalName} registered`,
      newData: { objectKey: file.objectKey, sizeBytes: input.sizeBytes },
    });
    return file;
  }

  const file = await prisma.fileObject.create({
    data: {
      organizationId: auth.organizationId,
      uploadedById: auth.userId,
      entityType: input.entityType,
      entityId: input.entityId,
      projectId: input.projectId,
      storageProvider: getStorageProvider(),
      bucket: input.bucket,
      objectKey: input.objectKey,
      originalName: input.originalName,
      mimeType: input.mimeType,
      sizeBytes: BigInt(input.sizeBytes),
      checksum: input.checksum,
      visibility: input.visibility ?? FileVisibility.PRIVATE,
      metadata: input.metadata as Prisma.InputJsonValue | undefined,
    },
  });

  await recordAudit(prisma, ctx, {
    action: 'CREATE',
    entityType: 'FileObject',
    entityId: file.id,
    summary: `File ${file.originalName} registered`,
    newData: { objectKey: file.objectKey, sizeBytes: input.sizeBytes },
  });

  return file;
}

async function getAccessibleFile(auth: AuthContext, id: string) {
  const file = await prisma.fileObject.findFirst({
    where: { id, organizationId: auth.organizationId, deletedAt: null },
  });
  if (!file) throw notFound('File');
  await assertFileResourceAccess(auth, file, 'read');
  return file;
}

export async function getDownloadUrl(auth: AuthContext, id: string) {
  const file = await getAccessibleFile(auth, id);
  const signed = createSignedUrl(file.objectKey, file.bucket);
  return {
    id: file.id,
    originalName: file.originalName,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes.toString(),
    downloadUrl: signed.url,
    expiresAt: signed.expiresAt,
  };
}

export async function deleteFile(auth: AuthContext, id: string, ctx: AuditRequestContext) {
  const file = await getAccessibleFile(auth, id);
  await assertFileResourceAccess(auth, file, 'delete');

  await prisma.fileObject.update({
    where: { id },
    data: { deletedAt: new Date(), deletedBy: auth.userId },
  });

  await recordAudit(prisma, ctx, {
    action: 'SOFT_DELETE',
    entityType: 'FileObject',
    entityId: id,
    summary: `File ${file.originalName} removed`,
    oldData: { objectKey: file.objectKey },
  });
}
