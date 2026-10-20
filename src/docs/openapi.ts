import { env } from '../config/env';
import { brand } from '../config/brand';
import { PERMISSIONS } from '../types/permissions';

type Obj = Record<string, unknown>;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const PARAMS = {
  id: {
    name: 'id',
    in: 'path',
    required: true,
    schema: { type: 'string', format: 'uuid' },
    description: 'UUID of the resource',
  },
  page: {
    name: 'page',
    in: 'query',
    schema: { type: 'integer', minimum: 1, default: 1 },
    description: 'Page number (1-based)',
  },
  limit: {
    name: 'limit',
    in: 'query',
    schema: { type: 'integer', minimum: 1, maximum: env.MAX_PAGE_SIZE, default: env.DEFAULT_PAGE_SIZE },
    description: `Page size. Hard maximum ${env.MAX_PAGE_SIZE}; unbounded reads are not possible.`,
  },
  search: {
    name: 'search',
    in: 'query',
    schema: { type: 'string', maxLength: 120 },
    description: 'Case-insensitive substring match across the resource’s searchable columns',
  },
  sortBy: { name: 'sortBy', in: 'query', schema: { type: 'string' }, description: 'Whitelisted sort column' },
  sortOrder: {
    name: 'sortOrder',
    in: 'query',
    schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
  },
  from: {
    name: 'from',
    in: 'query',
    schema: { type: 'string', format: 'date' },
    description: 'Inclusive start of the date filter (YYYY-MM-DD)',
  },
  to: {
    name: 'to',
    in: 'query',
    schema: { type: 'string', format: 'date' },
    description: 'Inclusive end of the date filter (YYYY-MM-DD)',
  },
  idempotencyKey: {
    name: 'Idempotency-Key',
    in: 'header',
    schema: { type: 'string', minLength: 8, maxLength: 120 },
    description:
      'Retry-safety token. A repeated request with the same key replays the original response instead of creating a second record.',
  },
} as const;

const LIST_PARAMS = [
  PARAMS.page,
  PARAMS.limit,
  PARAMS.search,
  PARAMS.sortBy,
  PARAMS.sortOrder,
  PARAMS.from,
  PARAMS.to,
];

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: ref('ErrorEnvelope') } },
});

const COMMON_ERRORS = {
  400: errorResponse('Validation failed'),
  401: errorResponse('Missing or invalid credentials'),
  403: errorResponse('Authenticated but lacking the required permission'),
  404: errorResponse('Resource not found'),
  409: errorResponse('Conflict — duplicate, or a state transition that is not allowed'),
  422: errorResponse('A business rule was violated'),
  429: errorResponse('Rate limit exceeded'),
  500: errorResponse('Unexpected server error'),
};

const okResponse = (description: string, dataSchema: Obj = { type: 'object' }) => ({
  description,
  content: {
    'application/json': {
      schema: {
        allOf: [ref('SuccessEnvelope'), { type: 'object', properties: { data: dataSchema } }],
      },
    },
  },
});

const listResponse = (description: string) => ({
  description,
  content: {
    'application/json': {
      schema: {
        allOf: [
          ref('SuccessEnvelope'),
          {
            type: 'object',
            properties: {
              data: { type: 'array', items: { type: 'object' } },
              meta: {
                type: 'object',
                properties: { pagination: ref('Pagination') },
              },
            },
          },
        ],
      },
    },
  },
});

interface ResourceSpec {
  path: string;
  tag: string;
  singular: string;
  permissions: { view: string; create?: string; update?: string; remove?: string };
  extraListParams?: Obj[];
  createBody?: string;
  updateBody?: string;
  idempotentCreate?: boolean;
  readOnly?: boolean;
}

/** Emits the standard list/create/read/update/delete block for a resource. */
function crudPaths(spec: ResourceSpec): Obj {
  const paths: Obj = {};

  const listGet: Obj = {
    tags: [spec.tag],
    summary: `List ${spec.singular}s`,
    description: `Paginated, filterable list. Requires \`${spec.permissions.view}\`.`,
    parameters: [...LIST_PARAMS, ...(spec.extraListParams ?? [])],
    responses: { 200: listResponse(`A page of ${spec.singular}s`), ...COMMON_ERRORS },
  };

  const collection: Obj = { get: listGet };

  if (!spec.readOnly && spec.permissions.create) {
    collection.post = {
      tags: [spec.tag],
      summary: `Create a ${spec.singular}`,
      description: `Requires \`${spec.permissions.create}\`.`,
      ...(spec.idempotentCreate ? { parameters: [PARAMS.idempotencyKey] } : {}),
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: spec.createBody ? ref(spec.createBody) : { type: 'object' },
          },
        },
      },
      responses: { 201: okResponse(`The created ${spec.singular}`), ...COMMON_ERRORS },
    };
  }

  paths[spec.path] = collection;

  const item: Obj = {
    get: {
      tags: [spec.tag],
      summary: `Fetch one ${spec.singular}`,
      description: `Requires \`${spec.permissions.view}\`.`,
      parameters: [PARAMS.id],
      responses: { 200: okResponse(`The requested ${spec.singular}`), ...COMMON_ERRORS },
    },
  };

  if (!spec.readOnly && spec.permissions.update) {
    item.patch = {
      tags: [spec.tag],
      summary: `Update a ${spec.singular}`,
      description: `Requires \`${spec.permissions.update}\`.`,
      parameters: [PARAMS.id],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: spec.updateBody ? ref(spec.updateBody) : { type: 'object' },
          },
        },
      },
      responses: { 200: okResponse(`The updated ${spec.singular}`), ...COMMON_ERRORS },
    };
  }

  if (!spec.readOnly && spec.permissions.remove) {
    item.delete = {
      tags: [spec.tag],
      summary: `Archive a ${spec.singular}`,
      description: `Soft delete — the row is retained with \`deletedAt\` set. Requires \`${spec.permissions.remove}\`.`,
      parameters: [PARAMS.id],
      responses: { 204: { description: 'Archived' }, ...COMMON_ERRORS },
    };
  }

  paths[`${spec.path}/{id}`] = item;
  return paths;
}

const enumParam = (name: string, values: string[]) => ({
  name,
  in: 'query',
  schema: { type: 'string', enum: values },
});

const uuidParam = (name: string) => ({
  name,
  in: 'query',
  schema: { type: 'string', format: 'uuid' },
});

const statusAction = (tag: string, path: string, summary: string, permission: string): Obj => ({
  [path]: {
    patch: {
      tags: [tag],
      summary,
      description: `Writes a status-history row and an audit entry in the same transaction. Requires \`${permission}\`.`,
      parameters: [PARAMS.id],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['status'],
              properties: {
                status: { type: 'string' },
                reason: { type: 'string', maxLength: 500 },
              },
            },
          },
        },
      },
      responses: { 200: okResponse('Updated resource'), ...COMMON_ERRORS },
    },
  },
});

const base = env.API_BASE_PATH;

export const openApiDocument = {
  openapi: '3.0.3',
  info: {
    title: `${brand.name} API`,
    version: '1.0.0',
    description: [
      `Production backend for ${brand.name}.`,
      '',
      '**Database:** PostgreSQL is the single source of truth. No other engine is supported.',
      '',
      '**Money:** every monetary value is a PostgreSQL `numeric(14,2)` and is serialised as an',
      'exact decimal *string* (for example `"12500.5"`) so no precision is lost passing through',
      'JSON. Trailing zeros are not padded. Never parse these into a float before doing',
      'arithmetic — use a decimal library, and format for display on the client.',
      '',
      '**Authorization:** authentication yields identity; every endpoint separately requires a',
      'named permission, checked server-side on each request. Frontend permission state is a',
      'display convenience and is never trusted.',
      '',
      '**Pagination:** every list endpoint is bounded. `limit` is clamped to',
      `\`${env.MAX_PAGE_SIZE}\`; there is no way to request an unbounded result set.`,
      '',
      '**Idempotency:** financial writes accept an `Idempotency-Key` header (required on',
      'payments, refunds and payouts). A retry replays the original response rather than',
      'creating a second record.',
    ].join('\n'),
    license: { name: 'Proprietary' },
  },
  servers: [
    { url: `http://localhost:${env.PORT}`, description: 'Local development' },
    { url: 'https://api.example.com', description: 'Production (replace with your host)' },
  ],
  tags: [
    { name: 'Auth', description: 'Login, refresh, sessions and password management' },
    { name: 'Organizations', description: 'Studio profile and branches' },
    { name: 'Users', description: 'Employee accounts' },
    { name: 'Roles', description: 'Roles and the permission catalogue' },
    { name: 'Leads', description: 'Sales pipeline' },
    { name: 'Clients', description: 'Booked couples and families' },
    { name: 'Projects', description: 'Weddings — the central entity' },
    { name: 'Events', description: 'Functions within a wedding' },
    { name: 'Shoots', description: 'Shoot days and crew assignment' },
    { name: 'Freelancers', description: 'External crew and payouts' },
    { name: 'Tasks', description: 'Editing and studio work' },
    { name: 'Personal Todos', description: 'Private employee to-do list, visible only to the signed-in user' },
    { name: 'Deliveries', description: 'Client deliverables' },
    { name: 'Attendance', description: 'Attendance and leave' },
    { name: 'Quotations', description: 'Proposals' },
    { name: 'Invoices', description: 'Receivables' },
    { name: 'Payments', description: 'Cash received and its allocation' },
    { name: 'Expenses', description: 'Cost ledger and approvals' },
    { name: 'Files', description: 'Storage metadata and signed URLs' },
    { name: 'Notifications', description: 'In-app notifications' },
    { name: 'Reports', description: 'Aggregated analytics' },
    { name: 'Audit', description: 'Immutable activity trail' },
    { name: 'Settings', description: 'Per-organization configuration' },
    { name: 'Data Management', description: 'Dashboard aggregates' },
    { name: 'System', description: 'Health probes' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      cookieAuth: { type: 'apiKey', in: 'cookie', name: brand.cookie.access },
    },
    schemas: {
      SuccessEnvelope: {
        type: 'object',
        required: ['success', 'data'],
        properties: {
          success: { type: 'boolean', enum: [true] },
          data: {},
          meta: { type: 'object', additionalProperties: true },
        },
      },
      ErrorEnvelope: {
        type: 'object',
        required: ['success', 'error'],
        properties: {
          success: { type: 'boolean', enum: [false] },
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: {
                type: 'string',
                enum: [
                  'VALIDATION_ERROR',
                  'UNAUTHENTICATED',
                  'FORBIDDEN',
                  'NOT_FOUND',
                  'CONFLICT',
                  'UNPROCESSABLE',
                  'RATE_LIMITED',
                  'IDEMPOTENCY_CONFLICT',
                  'IDEMPOTENCY_IN_PROGRESS',
                  'PAYLOAD_TOO_LARGE',
                  'INTERNAL_ERROR',
                ],
              },
              message: { type: 'string' },
              details: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { field: { type: 'string' }, message: { type: 'string' } },
                },
              },
              requestId: { type: 'string' },
            },
          },
        },
      },
      Pagination: {
        type: 'object',
        properties: {
          page: { type: 'integer' },
          limit: { type: 'integer' },
          total: { type: 'integer' },
          totalPages: { type: 'integer' },
          hasNext: { type: 'boolean' },
          hasPrev: { type: 'boolean' },
        },
      },
      Money: {
        type: 'string',
        pattern: '^-?\\d+(\\.\\d{1,2})?$',
        example: '12500.5',
        description:
          'PostgreSQL numeric(14,2) rendered as an exact decimal string. Trailing zeros are not padded — 12500.50 is sent as "12500.5" and 12500.00 as "12500". Format for display client-side; never parse into a float before doing arithmetic.',
      },
      LoginRequest: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string' },
          organizationSlug: {
            type: 'string',
            description: 'Required only when the same email exists in more than one organization.',
          },
        },
      },
      LineItem: {
        type: 'object',
        required: ['service', 'quantity', 'unitPrice'],
        properties: {
          service: { type: 'string', maxLength: 200 },
          description: { type: 'string' },
          quantity: ref('Money'),
          unitPrice: ref('Money'),
          discountAmount: ref('Money'),
          taxRate: { type: 'number', minimum: 0, maximum: 100 },
        },
      },
      CreateInvoiceRequest: {
        type: 'object',
        required: ['clientId', 'issueDate', 'items'],
        properties: {
          clientId: { type: 'string', format: 'uuid' },
          projectId: { type: 'string', format: 'uuid' },
          issueDate: { type: 'string', format: 'date' },
          dueDate: { type: 'string', format: 'date' },
          discountAmount: ref('Money'),
          notes: { type: 'string' },
          items: { type: 'array', minItems: 1, items: ref('LineItem') },
        },
      },
      CreateQuotationRequest: {
        type: 'object',
        required: ['clientId', 'issueDate', 'items'],
        properties: {
          clientId: { type: 'string', format: 'uuid' },
          projectId: { type: 'string', format: 'uuid' },
          issueDate: { type: 'string', format: 'date' },
          validUntil: { type: 'string', format: 'date' },
          discountAmount: ref('Money'),
          notes: { type: 'string' },
          termsAndConditions: { type: 'string' },
          items: { type: 'array', minItems: 1, items: ref('LineItem') },
        },
      },
      PaymentAllocation: {
        type: 'object',
        required: ['invoiceId', 'amount'],
        properties: {
          invoiceId: { type: 'string', format: 'uuid' },
          amount: ref('Money'),
        },
      },
      CreatePaymentRequest: {
        type: 'object',
        required: ['clientId', 'amount', 'paymentDate'],
        properties: {
          clientId: { type: 'string', format: 'uuid' },
          projectId: { type: 'string', format: 'uuid' },
          amount: ref('Money'),
          paymentDate: { type: 'string', format: 'date' },
          paymentMethod: {
            type: 'string',
            enum: ['CASH', 'UPI', 'BANK_TRANSFER', 'CREDIT_CARD', 'DEBIT_CARD', 'CHEQUE', 'OTHER'],
          },
          transactionReference: {
            type: 'string',
            description: 'Unique per organization — a repeat is rejected as a duplicate.',
          },
          notes: { type: 'string' },
          allocations: {
            type: 'array',
            items: ref('PaymentAllocation'),
            description:
              'Optional. Total allocated may not exceed the payment, and no invoice may be over-settled.',
          },
        },
      },
      AssignCrewRequest: {
        type: 'object',
        required: ['role'],
        properties: {
          userId: { type: 'string', format: 'uuid', description: 'Studio employee' },
          freelancerId: { type: 'string', format: 'uuid', description: 'External crew' },
          role: { type: 'string' },
          agreedAmount: ref('Money'),
          travelAmount: ref('Money'),
          extraAmount: ref('Money'),
          callTime: { type: 'string', format: 'date-time' },
          notes: { type: 'string' },
        },
        description:
          'Exactly one of userId or freelancerId must be present — enforced by a database CHECK constraint.',
      },
    },
  },
  security: [{ bearerAuth: [] }, { cookieAuth: [] }],
  paths: {
    '/health': {
      get: {
        tags: ['System'],
        summary: 'Liveness probe',
        security: [],
        responses: { 200: okResponse('Process is alive') },
      },
    },
    '/health/ready': {
      get: {
        tags: ['System'],
        summary: 'Readiness probe',
        description: 'Executes `SELECT 1` against PostgreSQL. Returns 503 when unreachable.',
        security: [],
        responses: {
          200: okResponse('PostgreSQL reachable'),
          503: errorResponse('PostgreSQL unreachable'),
        },
      },
    },

    [`${base}/auth/login`]: {
      post: {
        tags: ['Auth'],
        summary: 'Sign in',
        description:
          'Returns an access token (15m) and a rotating refresh token (7d), also set as HTTP-only cookies. Repeated failures lock the account for 15 minutes.',
        security: [],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: ref('LoginRequest') } },
        },
        responses: {
          200: okResponse('Authenticated'),
          401: errorResponse('Invalid email or password'),
          403: errorResponse('Account inactive or locked'),
          429: errorResponse('Too many attempts'),
        },
      },
    },
    [`${base}/auth/refresh`]: {
      post: {
        tags: ['Auth'],
        summary: 'Rotate the refresh token',
        description:
          'The presented refresh token is retired as the new pair is issued, making it single-use.',
        security: [],
        responses: { 200: okResponse('New token pair'), 401: errorResponse('Invalid token') },
      },
    },
    [`${base}/auth/logout`]: {
      post: { tags: ['Auth'], summary: 'Sign out of the current session', responses: { 200: okResponse('Signed out') } },
    },
    [`${base}/auth/me`]: {
      get: {
        tags: ['Auth'],
        summary: 'Current user, roles and effective permissions',
        responses: { 200: okResponse('Session user'), 401: COMMON_ERRORS[401] },
      },
    },
    [`${base}/auth/sessions`]: {
      get: { tags: ['Auth'], summary: 'List active sessions', responses: { 200: okResponse('Active sessions') } },
    },
    [`${base}/auth/sessions/revoke-all`]: {
      post: { tags: ['Auth'], summary: 'Revoke every active session', responses: { 200: okResponse('Revoked') } },
    },
    [`${base}/auth/change-password`]: {
      post: {
        tags: ['Auth'],
        summary: 'Change own password',
        description: 'All other sessions are revoked on success.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['currentPassword', 'newPassword'],
                properties: {
                  currentPassword: { type: 'string' },
                  newPassword: { type: 'string', minLength: 10 },
                },
              },
            },
          },
        },
        responses: { 200: okResponse('Password changed'), ...COMMON_ERRORS },
      },
    },

    ...crudPaths({
      path: `${base}/clients`,
      tag: 'Clients',
      singular: 'client',
      permissions: {
        view: 'CLIENT_VIEW',
        create: 'CLIENT_CREATE',
        update: 'CLIENT_UPDATE',
        remove: 'CLIENT_DELETE',
      },
    }),
    ...crudPaths({
      path: `${base}/leads`,
      tag: 'Leads',
      singular: 'lead',
      permissions: {
        view: 'LEAD_VIEW',
        create: 'LEAD_CREATE',
        update: 'LEAD_UPDATE',
        remove: 'LEAD_DELETE',
      },
      extraListParams: [
        enumParam('status', ['NEW', 'CONTACTED', 'QUALIFIED', 'PROPOSAL_SENT', 'NEGOTIATION', 'WON', 'LOST']),
        uuidParam('ownerId'),
        uuidParam('sourceId'),
      ],
    }),
    [`${base}/leads/{id}/convert`]: {
      post: {
        tags: ['Leads'],
        summary: 'Convert a lead into a client',
        description:
          'Creates a client, or links an existing one via `clientId` so contact details are not duplicated. Requires `LEAD_CONVERT`.',
        parameters: [PARAMS.id],
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { clientId: { type: 'string', format: 'uuid' } } },
            },
          },
        },
        responses: { 200: okResponse('Converted lead'), ...COMMON_ERRORS },
      },
    },

    ...crudPaths({
      path: `${base}/projects`,
      tag: 'Projects',
      singular: 'project',
      permissions: {
        view: 'PROJECT_VIEW',
        create: 'PROJECT_CREATE',
        update: 'PROJECT_UPDATE',
        remove: 'PROJECT_DELETE',
      },
      extraListParams: [
        enumParam('status', [
          'LEAD',
          'CONFIRMED',
          'PLANNING',
          'SHOOTING',
          'EDITING',
          'DELIVERY',
          'COMPLETED',
          'CANCELLED',
        ]),
        uuidParam('clientId'),
        uuidParam('managerId'),
        uuidParam('branchId'),
      ],
    }),
    ...statusAction(
      'Projects',
      `${base}/projects/{id}/status`,
      'Change project status',
      'PROJECT_STATUS_CHANGE',
    ),
    [`${base}/projects/{id}/status-history`]: {
      get: {
        tags: ['Projects'],
        summary: 'Full status transition history',
        parameters: [PARAMS.id],
        responses: { 200: okResponse('Status history'), ...COMMON_ERRORS },
      },
    },

    ...crudPaths({
      path: `${base}/events`,
      tag: 'Events',
      singular: 'event',
      permissions: {
        view: 'EVENT_VIEW',
        create: 'EVENT_CREATE',
        update: 'EVENT_UPDATE',
        remove: 'EVENT_DELETE',
      },
      extraListParams: [uuidParam('projectId'), uuidParam('eventTypeId')],
    }),

    ...crudPaths({
      path: `${base}/shoots`,
      tag: 'Shoots',
      singular: 'shoot',
      permissions: {
        view: 'SHOOT_VIEW',
        create: 'SHOOT_CREATE',
        update: 'SHOOT_UPDATE',
        remove: 'SHOOT_DELETE',
      },
      extraListParams: [
        uuidParam('projectId'),
        uuidParam('eventId'),
        enumParam('status', ['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'POSTPONED']),
        uuidParam('userId'),
        uuidParam('freelancerId'),
      ],
    }),
    [`${base}/shoots/{id}/assignments`]: {
      post: {
        tags: ['Shoots'],
        summary: 'Assign a crew member',
        description:
          'Exactly one of userId/freelancerId. The same person may hold multiple roles on one shoot. The same role twice, or another project on the same date, is rejected. Requires `SHOOT_ASSIGN`.',
        parameters: [PARAMS.id],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: ref('AssignCrewRequest') } },
        },
        responses: { 201: okResponse('Assignment created'), ...COMMON_ERRORS },
      },
    },
    [`${base}/shoots/{id}/assignments/{assignmentId}`]: {
      patch: {
        tags: ['Shoots'],
        summary: 'Update a crew assignment',
        parameters: [
          PARAMS.id,
          { name: 'assignmentId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: { 200: okResponse('Updated assignment'), ...COMMON_ERRORS },
      },
      delete: {
        tags: ['Shoots'],
        summary: 'Remove a crew assignment',
        description: 'Rejected when payouts already exist against the assignment.',
        parameters: [
          PARAMS.id,
          { name: 'assignmentId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: { 204: { description: 'Removed' }, ...COMMON_ERRORS },
      },
    },

    ...crudPaths({
      path: `${base}/tasks`,
      tag: 'Tasks',
      singular: 'task',
      permissions: {
        view: 'TASK_VIEW',
        create: 'TASK_CREATE',
        update: 'TASK_UPDATE',
        remove: 'TASK_DELETE',
      },
      extraListParams: [
        enumParam('status', ['TODO', 'ASSIGNED', 'IN_PROGRESS', 'PAUSED', 'IN_REVIEW', 'COMPLETED', 'CANCELLED']),
        enumParam('priority', ['LOW', 'MEDIUM', 'HIGH', 'URGENT']),
        uuidParam('assigneeId'),
        uuidParam('projectId'),
        { name: 'overdue', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } },
      ],
    }),
    ...statusAction('Tasks', `${base}/tasks/{id}/status`, 'Change task status', 'TASK_UPDATE'),
    [`${base}/me/todos`]: {
      get: {
        tags: ['Personal Todos'],
        summary: 'List my personal to-dos',
        description: 'Returns only the signed-in user’s private to-dos. Requires `PERSONAL_TODO`.',
        parameters: [
          PARAMS.page,
          PARAMS.limit,
          PARAMS.search,
          { name: 'completed', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } },
        ],
        responses: { 200: listResponse('A page of personal to-dos'), ...COMMON_ERRORS },
      },
      post: {
        tags: ['Personal Todos'],
        summary: 'Create a personal to-do',
        description: 'Always assigned to the signed-in user. Requires `PERSONAL_TODO`.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['title'],
                properties: {
                  title: { type: 'string', maxLength: 200 },
                  priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
                  dueDate: { type: 'string', format: 'date' },
                },
              },
            },
          },
        },
        responses: { 201: okResponse('The created personal to-do'), ...COMMON_ERRORS },
      },
    },
    [`${base}/me/todos/completed`]: {
      delete: {
        tags: ['Personal Todos'],
        summary: 'Clear my completed personal to-dos',
        description: 'Soft-deletes completed items owned by the signed-in user. Requires `PERSONAL_TODO`.',
        responses: { 200: okResponse('Cleared count'), ...COMMON_ERRORS },
      },
    },
    [`${base}/me/todos/{id}`]: {
      patch: {
        tags: ['Personal Todos'],
        summary: 'Update my personal to-do',
        description: 'Rejected with 404 if the item is not owned by the signed-in user. Requires `PERSONAL_TODO`.',
        parameters: [PARAMS.id],
        responses: { 200: okResponse('Updated personal to-do'), ...COMMON_ERRORS },
      },
      delete: {
        tags: ['Personal Todos'],
        summary: 'Delete my personal to-do',
        parameters: [PARAMS.id],
        responses: { 204: { description: 'Removed' }, ...COMMON_ERRORS },
      },
    },
    [`${base}/tasks/{id}/reassign`]: {
      post: {
        tags: ['Tasks'],
        summary: 'Reassign a task',
        description:
          'Writes a TaskAssignment row capturing from/to/by/reason, so ownership history is never overwritten. Requires `TASK_ASSIGN`.',
        parameters: [PARAMS.id],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['toUserId'],
                properties: {
                  toUserId: { type: 'string', format: 'uuid' },
                  reason: { type: 'string', maxLength: 500 },
                },
              },
            },
          },
        },
        responses: { 200: okResponse('Reassigned task'), ...COMMON_ERRORS },
      },
    },

    ...crudPaths({
      path: `${base}/deliveries`,
      tag: 'Deliveries',
      singular: 'delivery',
      permissions: {
        view: 'DELIVERY_VIEW',
        create: 'DELIVERY_CREATE',
        update: 'DELIVERY_UPDATE',
        remove: 'DELIVERY_DELETE',
      },
      extraListParams: [
        enumParam('status', ['PENDING', 'IN_PROGRESS', 'READY', 'DELIVERED', 'REWORK', 'CANCELLED']),
        uuidParam('projectId'),
        { name: 'overdue', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } },
      ],
    }),
    ...statusAction(
      'Deliveries',
      `${base}/deliveries/{id}/status`,
      'Change delivery status',
      'DELIVERY_UPDATE',
    ),

    ...crudPaths({
      path: `${base}/freelancers`,
      tag: 'Freelancers',
      singular: 'freelancer',
      permissions: {
        view: 'FREELANCER_VIEW',
        create: 'FREELANCER_CREATE',
        update: 'FREELANCER_UPDATE',
        remove: 'FREELANCER_DELETE',
      },
      extraListParams: [enumParam('status', ['ACTIVE', 'INACTIVE', 'UNAVAILABLE', 'SUSPENDED'])],
    }),
    [`${base}/freelancers/{id}/ledger`]: {
      get: {
        tags: ['Freelancers'],
        summary: 'Committed vs. paid, per assignment',
        parameters: [PARAMS.id],
        responses: { 200: okResponse('Ledger rows'), ...COMMON_ERRORS },
      },
    },
    [`${base}/freelancers/{id}/payouts`]: {
      post: {
        tags: ['Freelancers'],
        summary: 'Record a payout',
        description:
          'Writes the payout and its backing expense in one transaction, so crew cost is counted exactly once. Requires `FREELANCER_PAY` and an Idempotency-Key.',
        parameters: [PARAMS.id, { ...PARAMS.idempotencyKey, required: true }],
        responses: { 201: okResponse('Payout and expense'), ...COMMON_ERRORS },
      },
    },

    ...crudPaths({
      path: `${base}/quotations`,
      tag: 'Quotations',
      singular: 'quotation',
      permissions: {
        view: 'QUOTATION_VIEW',
        create: 'QUOTATION_CREATE',
        update: 'QUOTATION_UPDATE',
        remove: 'QUOTATION_DELETE',
      },
      createBody: 'CreateQuotationRequest',
    }),

    ...crudPaths({
      path: `${base}/invoices`,
      tag: 'Invoices',
      singular: 'invoice',
      permissions: { view: 'INVOICE_VIEW', create: 'INVOICE_CREATE', update: 'INVOICE_UPDATE' },
      createBody: 'CreateInvoiceRequest',
      idempotentCreate: true,
      extraListParams: [
        enumParam('status', ['DRAFT', 'SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED']),
        { name: 'outstanding', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } },
      ],
    }),

    ...crudPaths({
      path: `${base}/payments`,
      tag: 'Payments',
      singular: 'payment',
      permissions: { view: 'PAYMENT_VIEW', create: 'PAYMENT_CREATE' },
      createBody: 'CreatePaymentRequest',
      idempotentCreate: true,
      extraListParams: [uuidParam('projectId'), uuidParam('clientId'), uuidParam('invoiceId')],
    }),
    [`${base}/payments/{id}/allocations`]: {
      post: {
        tags: ['Payments'],
        summary: 'Allocate a payment across invoices',
        description:
          'Runs at SERIALIZABLE isolation. Total allocated may not exceed the payment, and no invoice may be settled beyond its outstanding balance. Requires `PAYMENT_ALLOCATE`.',
        parameters: [PARAMS.id, PARAMS.idempotencyKey],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['allocations'],
                properties: { allocations: { type: 'array', items: ref('PaymentAllocation') } },
              },
            },
          },
        },
        responses: { 200: okResponse('Payment with allocations'), ...COMMON_ERRORS },
      },
    },
    [`${base}/payments/{id}/refund`]: {
      post: {
        tags: ['Payments'],
        summary: 'Reverse a payment',
        description:
          'Financial rows are never deleted. The original is marked REFUNDED, its allocations released, and a linked counter-entry is written.',
        parameters: [PARAMS.id, { ...PARAMS.idempotencyKey, required: true }],
        responses: { 201: okResponse('Reversal payment'), ...COMMON_ERRORS },
      },
    },

    ...crudPaths({
      path: `${base}/expenses`,
      tag: 'Expenses',
      singular: 'expense',
      permissions: {
        view: 'EXPENSE_VIEW',
        create: 'EXPENSE_CREATE',
        update: 'EXPENSE_UPDATE',
        remove: 'EXPENSE_DELETE',
      },
      extraListParams: [
        enumParam('approvalStatus', ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED']),
        enumParam('scope', ['PROJECT', 'GENERAL']),
        uuidParam('projectId'),
        uuidParam('categoryId'),
      ],
    }),
    [`${base}/expenses/{id}/review`]: {
      post: {
        tags: ['Expenses'],
        summary: 'Approve or reject an expense',
        description:
          'A submitter may not approve their own expense. Requires `EXPENSE_APPROVE`.',
        parameters: [PARAMS.id],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['decision'],
                properties: {
                  decision: { type: 'string', enum: ['APPROVE', 'REJECT'] },
                  reason: { type: 'string', description: 'Required when rejecting' },
                },
              },
            },
          },
        },
        responses: { 200: okResponse('Reviewed expense'), ...COMMON_ERRORS },
      },
    },

    ...crudPaths({
      path: `${base}/users`,
      tag: 'Users',
      singular: 'user',
      permissions: {
        view: 'USER_VIEW',
        create: 'USER_CREATE',
        update: 'USER_UPDATE',
        remove: 'USER_DELETE',
      },
      extraListParams: [
        enumParam('status', ['ACTIVE', 'INACTIVE', 'SUSPENDED', 'DISABLED']),
        uuidParam('branchId'),
        uuidParam('roleId'),
      ],
    }),
    [`${base}/users/{id}/roles`]: {
      put: {
        tags: ['Users'],
        summary: 'Replace a user’s roles',
        description:
          'Requires `USER_MANAGE`. The role must belong to the same organization, be ACTIVE, and grant nothing the caller lacks — otherwise 403/409. The before/after set is captured in the audit log.',
        parameters: [PARAMS.id],
        responses: { 200: okResponse('Updated user'), ...COMMON_ERRORS },
      },
    },
    [`${base}/users/{id}/reset-password`]: {
      post: {
        tags: ['Users'],
        summary: 'Reset a user’s password',
        description: 'Revokes every session for that user. Requires `USER_MANAGE`.',
        parameters: [PARAMS.id],
        responses: { 200: okResponse('Password reset'), ...COMMON_ERRORS },
      },
    },

    [`${base}/roles`]: {
      get: {
        tags: ['Roles'],
        summary: 'List roles with their permissions',
        description:
          'Scoped to the caller’s organization. Each row carries `type` (SYSTEM/CUSTOM), `status` (ACTIVE/INACTIVE), a user count, and `assignable` — true only when the caller holds every permission the role grants. Requires `ROLE_VIEW`.',
        responses: { 200: okResponse('Roles') },
      },
      post: {
        tags: ['Roles'],
        summary: 'Create a custom role',
        description:
          'Always created as CUSTOM. A permission the caller does not hold cannot be granted (403). A duplicate name within the organization returns 409. Requires `ROLE_CREATE`.',
        responses: { 201: okResponse('Created role'), ...COMMON_ERRORS },
      },
    },
    [`${base}/roles/{id}/users`]: {
      get: {
        tags: ['Roles'],
        summary: 'List the employees holding a role',
        description:
          'Organization-scoped; a role from another studio reads as 404. Each row includes the employee’s full role set so a split into separate roles is easy to plan. Requires `ROLE_VIEW` or `TEAM_VIEW`.',
        parameters: [PARAMS.id],
        responses: { 200: okResponse('Role members'), ...COMMON_ERRORS },
      },
    },
    [`${base}/roles/{id}/permissions`]: {
      put: {
        tags: ['Roles'],
        summary: 'Replace a role’s permission set',
        description:
          'The added/removed diff is written to the audit log. ADMIN can only change dashboard widget permissions; every other Admin permission stays granted. Requires `PERMISSION_ASSIGN`.',
        parameters: [PARAMS.id],
        responses: { 200: okResponse('Updated role'), ...COMMON_ERRORS },
      },
    },
    [`${base}/permissions`]: {
      get: {
        tags: ['Roles'],
        summary: 'The permission catalogue',
        description: `${PERMISSIONS.length} permissions across ${
          new Set(PERMISSIONS.map((p) => p.module)).size
        } modules.`,
        responses: { 200: okResponse('Permissions') },
      },
    },

    [`${base}/attendance`]: {
      get: {
        tags: ['Attendance'],
        summary: 'List attendance records',
        parameters: [...LIST_PARAMS, uuidParam('userId')],
        responses: { 200: listResponse('Attendance page'), ...COMMON_ERRORS },
      },
      post: {
        tags: ['Attendance'],
        summary: 'Mark attendance',
        description:
          'One row per user per day. Marking for another user requires `ATTENDANCE_MANAGE`. Working minutes are derived from the timestamps, never taken from the client.',
        responses: { 201: okResponse('Attendance record'), ...COMMON_ERRORS },
      },
    },
    [`${base}/attendance/leave`]: {
      get: { tags: ['Attendance'], summary: 'List leave requests', responses: { 200: listResponse('Leave page') } },
      post: { tags: ['Attendance'], summary: 'Raise a leave request', responses: { 201: okResponse('Leave request') } },
    },
    [`${base}/attendance/leave/{id}/review`]: {
      post: {
        tags: ['Attendance'],
        summary: 'Approve or reject leave',
        parameters: [PARAMS.id],
        responses: { 200: okResponse('Reviewed leave'), ...COMMON_ERRORS },
      },
    },

    [`${base}/files/upload-intent`]: {
      post: {
        tags: ['Files'],
        summary: 'Request a signed upload URL',
        description:
          'The client uploads straight to the storage provider; the API never proxies file bytes and PostgreSQL stores only metadata.',
        responses: { 201: okResponse('Upload intent'), ...COMMON_ERRORS },
      },
    },
    [`${base}/files/{id}/download-url`]: {
      get: {
        tags: ['Files'],
        summary: 'Short-lived signed download URL',
        parameters: [PARAMS.id],
        responses: { 200: okResponse('Signed URL'), ...COMMON_ERRORS },
      },
    },

    [`${base}/notifications`]: {
      get: {
        tags: ['Notifications'],
        summary: 'List own notifications',
        parameters: [...LIST_PARAMS, { name: 'isRead', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } }],
        responses: { 200: listResponse('Notification page') },
      },
    },

    [`${base}/audit`]: {
      get: {
        tags: ['Audit'],
        summary: 'Query the audit trail',
        description:
          'Append-only. Passwords, tokens and secrets are stripped from snapshots before they are written. Requires `AUDIT_VIEW`.',
        parameters: [
          ...LIST_PARAMS,
          { name: 'entityType', in: 'query', schema: { type: 'string' } },
          uuidParam('entityId'),
          uuidParam('actorId'),
        ],
        responses: { 200: listResponse('Audit page'), ...COMMON_ERRORS },
      },
    },

    [`${base}/reports/monthly-financials`]: {
      get: {
        tags: ['Reports'],
        summary: 'Revenue vs. expenses by month',
        parameters: [PARAMS.from, PARAMS.to],
        responses: { 200: okResponse('Monthly series'), ...COMMON_ERRORS },
      },
    },
    [`${base}/reports/lead-funnel`]: {
      get: { tags: ['Reports'], summary: 'Pipeline conversion', parameters: [PARAMS.from, PARAMS.to], responses: { 200: okResponse('Funnel') } },
    },
    [`${base}/reports/team-workload`]: {
      get: { tags: ['Reports'], summary: 'Tasks and shoots per team member', responses: { 200: okResponse('Workload') } },
    },
    [`${base}/reports/receivables-aging`]: {
      get: { tags: ['Reports'], summary: 'Outstanding receivables by age bucket', responses: { 200: okResponse('Aging buckets') } },
    },
    [`${base}/reports/profitability`]: {
      get: { tags: ['Reports'], summary: 'Per-project profit', responses: { 200: okResponse('Profitability rows') } },
    },

    [`${base}/data-management/overview`]: {
      get: {
        tags: ['Data Management'],
        summary: 'Aggregated studio overview',
        description:
          'Projects, shoots, deliveries, tasks, finance, crew assignments, storage posture and per-project profitability — every figure produced by a PostgreSQL aggregate. An empty studio returns accurate zeroes, never placeholder data.',
        parameters: [PARAMS.from, PARAMS.to, { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 50 } }],
        responses: { 200: okResponse('Overview'), ...COMMON_ERRORS },
      },
    },
    [`${base}/data-management/projects`]: {
      get: {
        tags: ['Data Management'],
        summary: 'Per-project data-backup posture',
        parameters: LIST_PARAMS,
        responses: { 200: listResponse('Project data status'), ...COMMON_ERRORS },
      },
    },

    [`${base}/organizations/current`]: {
      get: { tags: ['Organizations'], summary: 'Current organization', responses: { 200: okResponse('Organization') } },
      patch: { tags: ['Organizations'], summary: 'Update the organization', responses: { 200: okResponse('Organization') } },
    },
    [`${base}/branches`]: {
      get: { tags: ['Organizations'], summary: 'List branches', responses: { 200: okResponse('Branches') } },
      post: { tags: ['Organizations'], summary: 'Create a branch', responses: { 201: okResponse('Branch') } },
    },
    [`${base}/settings`]: {
      get: { tags: ['Settings'], summary: 'List settings', responses: { 200: okResponse('Settings') } },
      put: { tags: ['Settings'], summary: 'Create or update a setting', responses: { 200: okResponse('Setting') } },
    },
  },
};
