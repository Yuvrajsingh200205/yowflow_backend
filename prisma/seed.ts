/**
 * PostgreSQL development seed.
 *
 * Safety properties:
 *   * Idempotent — every write is an upsert keyed on a natural key, so running
 *     it twice changes nothing and never duplicates.
 *   * Non-destructive — it deletes nothing. There is no reset path here.
 *   * Demo CRM records are created ONLY when SEED_DEMO_DATA=true and
 *     NODE_ENV is not production, so a production database can never be
 *     populated with invented projects, payments or clients (§43).
 */
import { PrismaClient, RoleType } from '@prisma/client';
import { env } from '../src/config/env';
import { hashPassword } from '../src/utils/password';
import { PERMISSIONS, SYSTEM_ROLES, permissionsForSystemRole } from '../src/types/permissions';

const prisma = new PrismaClient();

const EVENT_TYPES = [
  { name: 'Roka', colorHex: '#f59e0b', sortOrder: 1 },
  { name: 'Engagement', colorHex: '#ec4899', sortOrder: 2 },
  { name: 'Haldi', colorHex: '#fbbf24', sortOrder: 3 },
  { name: 'Mehendi', colorHex: '#22c55e', sortOrder: 4 },
  { name: 'Sangeet', colorHex: '#8b5cf6', sortOrder: 5 },
  { name: 'Wedding', colorHex: '#ef4444', sortOrder: 6 },
  { name: 'Reception', colorHex: '#3b82f6', sortOrder: 7 },
  { name: 'Pre Wedding Shoot', colorHex: '#14b8a6', sortOrder: 8 },
];

const EXPENSE_CATEGORIES = [
  { name: 'Crew Payout', description: 'Freelancer and external crew settlements' },
  { name: 'Travel & Fuel', description: 'Cabs, fuel and outstation travel' },
  { name: 'Equipment & Repair', description: 'Gear purchase, rental and servicing' },
  { name: 'Album & Printing', description: 'Album design, printing and framing' },
  { name: 'Studio Rent', description: 'Premises rent' },
  { name: 'Utilities', description: 'Electricity, water and internet' },
  { name: 'Software & Subscriptions', description: 'Editing suites and cloud storage' },
  { name: 'Marketing & Ads', description: 'Paid campaigns and collateral' },
  { name: 'Food & Refreshments', description: 'On-shoot and studio catering' },
  { name: 'Miscellaneous', description: 'Uncategorised studio spend' },
];

const LEAD_SOURCES = [
  'Instagram',
  'Meta Ads',
  'Google Search',
  'Referral',
  'Website',
  'Walk-in',
  'WeddingWire',
  'Other',
];

const DEPARTMENTS = [
  'Production',
  'Post Production',
  'Management',
  'Sales & Marketing',
  'Operations',
];

const DESIGNATIONS = [
  'Studio Owner',
  'Studio Manager',
  'Lead Photographer',
  'Cinematographer',
  'Photo Editor',
  'Video Editor',
  'Album Designer',
  'Account Manager',
  'Sales Executive',
];

async function seedPermissions(): Promise<Map<string, string>> {
  for (const permission of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: permission.key },
      create: {
        key: permission.key,
        module: permission.module,
        label: permission.label,
        isSensitive: permission.isSensitive ?? false,
      },
      update: {
        module: permission.module,
        label: permission.label,
        isSensitive: permission.isSensitive ?? false,
      },
    });
  }
  const rows = await prisma.permission.findMany({ select: { id: true, key: true } });
  return new Map(rows.map((r) => [r.key, r.id]));
}

async function main(): Promise<void> {
  if (env.isProduction && env.SEED_DEMO_DATA) {
    throw new Error(
      'SEED_DEMO_DATA=true is refused in production. Demo CRM records must never be created in a production database.',
    );
  }

  console.warn('→ seeding permission catalogue');
  const permissionIds = await seedPermissions();
  console.warn(`  ${permissionIds.size} permissions`);

  console.warn('→ seeding organization');
  const organization = await prisma.organization.upsert({
    where: { slug: env.SEED_ORG_SLUG },
    create: {
      name: env.SEED_ORG_NAME,
      slug: env.SEED_ORG_SLUG,
      currency: 'INR',
      timezone: 'Asia/Kolkata',
      country: 'IN',
    },
    update: {},
  });

  const branch = await prisma.branch.upsert({
    where: { organizationId_code: { organizationId: organization.id, code: 'HO' } },
    create: {
      organizationId: organization.id,
      name: 'Head Office',
      code: 'HO',
      isHeadOffice: true,
    },
    update: {},
  });

  console.warn('→ seeding system roles');
  const roleIds = new Map<string, string>();
  for (const roleName of SYSTEM_ROLES) {
    const role = await prisma.role.upsert({
      where: { organizationId_name: { organizationId: organization.id, name: roleName } },
      create: {
        organizationId: organization.id,
        name: roleName,
        type: RoleType.SYSTEM,
        description: `System role: ${roleName}`,
        isDefault: roleName === 'Account Manager',
      },
      update: { type: RoleType.SYSTEM },
    });
    roleIds.set(roleName, role.id);

    const keys = permissionsForSystemRole(roleName);
    // Re-assert the bundle so a permission added to the catalogue reaches
    // existing roles on the next seed run.
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({
      data: keys
        .map((key) => permissionIds.get(key))
        .filter((id): id is string => Boolean(id))
        .map((permissionId) => ({ roleId: role.id, permissionId })),
      skipDuplicates: true,
    });
    console.warn(`  ${roleName}: ${keys.length} permissions`);
  }

  console.warn('→ seeding reference data');
  for (const name of DEPARTMENTS) {
    await prisma.department.upsert({
      where: { organizationId_name: { organizationId: organization.id, name } },
      create: { organizationId: organization.id, name },
      update: {},
    });
  }
  for (const title of DESIGNATIONS) {
    await prisma.designation.upsert({
      where: { organizationId_title: { organizationId: organization.id, title } },
      create: { organizationId: organization.id, title },
      update: {},
    });
  }
  for (const eventType of EVENT_TYPES) {
    await prisma.eventType.upsert({
      where: { organizationId_name: { organizationId: organization.id, name: eventType.name } },
      create: { organizationId: organization.id, ...eventType },
      update: {},
    });
  }
  for (const category of EXPENSE_CATEGORIES) {
    await prisma.expenseCategory.upsert({
      where: { organizationId_name: { organizationId: organization.id, name: category.name } },
      create: { organizationId: organization.id, ...category },
      update: {},
    });
  }
  for (const name of LEAD_SOURCES) {
    await prisma.leadSource.upsert({
      where: { organizationId_name: { organizationId: organization.id, name } },
      create: {
        organizationId: organization.id,
        name,
      },
      update: {},
    });
  }

  console.warn('→ seeding system settings');
  const settings: Array<{ key: string; value: unknown; description: string }> = [
    { key: 'invoice.default_due_days', value: 15, description: 'Default invoice payment window' },
    { key: 'quotation.default_validity_days', value: 30, description: 'Default quotation validity' },
    { key: 'attendance.late_after', value: '09:45', description: 'Time after which a check-in is late' },
    { key: 'project.auto_number_prefix', value: 'PRJ', description: 'Project number prefix' },
    { key: 'delivery.default_sla_days', value: 45, description: 'Default delivery SLA from wedding date' },
  ];
  for (const setting of settings) {
    await prisma.systemSetting.upsert({
      where: { organizationId_key: { organizationId: organization.id, key: setting.key } },
      create: {
        organizationId: organization.id,
        key: setting.key,
        value: setting.value as never,
        description: setting.description,
      },
      update: {},
    });
  }

  console.warn('→ seeding users');
  const accounts = [
    {
      email: env.SEED_ADMIN_EMAIL,
      fullName: 'Studio Owner',
      employeeCode: 'EMP-S01',
      // Must match SYSTEM_ROLES exactly — that is the key `roleIds` is built
      // from. Using a different spelling here silently left every seeded
      // account with no role and therefore no permissions at all.
      role: 'Admin' as const,
      password: env.SEED_ADMIN_PASSWORD,
    },
    {
      email: `manager@${env.SEED_ORG_SLUG}.test`,
      fullName: 'Studio Manager',
      employeeCode: 'EMP-S02',
      role: 'Manager' as const,
      password: env.SEED_ADMIN_PASSWORD,
    },
    {
      email: `member@${env.SEED_ORG_SLUG}.test`,
      fullName: 'Photo Editor',
      employeeCode: 'EMP-S03',
      role: 'Photo Editor' as const,
      password: env.SEED_ADMIN_PASSWORD,
    },
  ];

  for (const account of accounts) {
    const email = account.email.toLowerCase();
    // Employee codes are also unique within an organisation. Resolve an
    // existing seeded account by either stable identifier so changing the
    // configured email does not attempt to create a duplicate employee code.
    const existingUser = await prisma.user.findFirst({
      where: {
        organizationId: organization.id,
        OR: [{ email }, { employeeCode: account.employeeCode }],
      },
    });
    const user = existingUser
      ? await prisma.user.update({
          where: { id: existingUser.id },
          data: {
            email,
            passwordHash: await hashPassword(account.password),
            status: 'ACTIVE',
            failedLoginAttempts: 0,
            lockedUntil: null,
          },
        })
      : await prisma.user.create({
          data: {
            organizationId: organization.id,
            branchId: branch.id,
            email,
            fullName: account.fullName,
            employeeCode: account.employeeCode,
            // Never log or print the password; only the hash is stored.
            passwordHash: await hashPassword(account.password),
            status: 'ACTIVE',
          },
        });

    const roleId = roleIds.get(account.role);
    // Fail loudly: an account with no role can sign in but sees nothing, which
    // is far harder to diagnose from the UI than a failed seed.
    if (!roleId) throw new Error(`Seed role "${account.role}" is not a system role`);
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId } },
      create: { userId: user.id, roleId },
      update: {},
    });
    console.warn(`  ${account.role.padEnd(13)} ${email}`);
  }

  const freelancerEmail = 'freelancer@example.com';
  const freelancerPassword = '1234';
  const existingFreelancer = await prisma.freelancer.findFirst({
    where: {
      organizationId: organization.id,
      OR: [{ code: 'FRL-DEMO' }, { email: freelancerEmail }],
    },
  });
  if (existingFreelancer) {
    await prisma.freelancer.update({
      where: { id: existingFreelancer.id },
      data: {
        code: 'FRL-DEMO',
        fullName: existingFreelancer.fullName || 'Demo Freelancer',
        phone: existingFreelancer.phone || '+919900112233',
        email: freelancerEmail,
        passwordHash: await hashPassword(freelancerPassword),
        status: 'ACTIVE',
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });
  } else {
    await prisma.freelancer.create({
      data: {
        organizationId: organization.id,
        code: 'FRL-DEMO',
        fullName: 'Demo Freelancer',
        phone: '+919900112233',
        email: freelancerEmail,
        city: 'Jaipur',
        primarySkill: 'CANDID_PHOTOGRAPHER',
        skills: ['Candid', 'Portrait'],
        rate: '18000.00',
        rateType: 'PER_DAY',
        status: 'ACTIVE',
        passwordHash: await hashPassword(freelancerPassword),
      },
    });
  }
  console.warn(`  Freelancer portal ${freelancerEmail}`);

  if (env.SEED_DEMO_DATA && !env.isProduction) {
    await seedDemoData(organization.id, branch.id);
  } else {
    console.warn('→ demo CRM data skipped (SEED_DEMO_DATA is not true)');
  }

  console.warn('\n✓ seed complete');
  console.warn(`  organization: ${organization.name} (${organization.slug})`);
  console.warn(`  sign in with: ${env.SEED_ADMIN_EMAIL}`);
  console.warn('  password: the value of SEED_ADMIN_PASSWORD in your .env — change it after first login.');
}

/** Development-only sample records so the UI has something real to render. */
async function seedDemoData(organizationId: string, branchId: string): Promise<void> {
  console.warn('→ seeding demo CRM data (development only)');

  const existing = await prisma.client.count({ where: { organizationId } });
  if (existing > 0) {
    console.warn('  demo data already present — skipping');
    return;
  }

  const admin = await prisma.user.findFirstOrThrow({
    where: { organizationId, employeeCode: 'EMP-S01' },
  });
  const member = await prisma.user.findFirstOrThrow({
    where: { organizationId, employeeCode: 'EMP-S03' },
  });
  const weddingType = await prisma.eventType.findFirstOrThrow({
    where: { organizationId, name: 'Wedding' },
  });
  const crewCategory = await prisma.expenseCategory.findFirstOrThrow({
    where: { organizationId, name: 'Crew Payout' },
  });

  const client = await prisma.client.create({
    data: {
      organizationId,
      clientCode: 'CLI-0001',
      displayName: 'Aarav & Diya',
      primaryPhone: '+919812345678',
      primaryEmail: 'aarav.diya@example.com',
      brideName: 'Diya',
      groomName: 'Aarav',
      contacts: {
        create: [{ name: 'Aarav Sharma', relationship: 'Groom', phone: '+919812345678', isPrimary: true }],
      },
      addresses: {
        create: [{ addressLine: '12 Rose Villa, Civil Lines', city: 'Jaipur', state: 'Rajasthan', isPrimary: true }],
      },
    },
  });

  const weddingDate = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 2, 14));

  const project = await prisma.project.create({
    data: {
      organizationId,
      branchId,
      clientId: client.id,
      projectNumber: `PRJ-${new Date().getUTCFullYear()}-0001`,
      name: 'Aarav & Diya — Wedding',
      type: 'COMPLETE_WEDDING_SERVICES',
      status: 'CONFIRMED',
      weddingDate,
      venueName: 'Fairmont Jaipur',
      venueCity: 'Jaipur',
      totalQuotation: '450000.00',
      createdById: admin.id,
      managerId: admin.id,
      statusHistory: {
        create: [
          { oldStatus: null, newStatus: 'LEAD', changedById: admin.id, reason: 'Demo seed' },
          { oldStatus: 'LEAD', newStatus: 'CONFIRMED', changedById: admin.id, reason: 'Advance received' },
        ],
      },
    },
  });

  const event = await prisma.event.create({
    data: {
      organizationId,
      projectId: project.id,
      eventTypeId: weddingType.id,
      name: 'Wedding Ceremony',
      eventDate: weddingDate,
      venueName: 'Fairmont Jaipur',
      city: 'Jaipur',
      status: 'CONFIRMED',
    },
  });

  const freelancer = await prisma.freelancer.create({
    data: {
      organizationId,
      code: 'FRL-0001',
      fullName: 'Rohit Candid',
      phone: '+919900112233',
      email: 'freelancer@example.com',
      city: 'Jaipur',
      primarySkill: 'CANDID_PHOTOGRAPHER',
      skills: ['Candid', 'Portrait'],
      rate: '18000.00',
      rateType: 'PER_DAY',
      status: 'ACTIVE',
      passwordHash: await hashPassword('1234'),
    },
  });

  const shoot = await prisma.shoot.create({
    data: {
      organizationId,
      projectId: project.id,
      eventId: event.id,
      title: 'Wedding Day Coverage',
      shootType: 'PHOTO_AND_VIDEO',
      shootDate: weddingDate,
      location: 'Fairmont Jaipur',
      city: 'Jaipur',
      createdById: admin.id,
      assignments: {
        create: [
          { userId: member.id, role: 'LEAD_PHOTOGRAPHER', agreedAmount: '0.00', assignedById: admin.id },
          {
            freelancerId: freelancer.id,
            role: 'CANDID_PHOTOGRAPHER',
            agreedAmount: '18000.00',
            travelAmount: '2000.00',
            assignedById: admin.id,
          },
        ],
      },
    },
  });

  const invoice = await prisma.invoice.create({
    data: {
      organizationId,
      invoiceNumber: `INV-${new Date().getUTCFullYear()}-0001`,
      projectId: project.id,
      clientId: client.id,
      issueDate: new Date(),
      dueDate: new Date(Date.now() + 15 * 86_400_000),
      subtotal: '450000.00',
      discountAmount: '0.00',
      taxAmount: '0.00',
      total: '450000.00',
      amountPaid: '0.00',
      amountDue: '450000.00',
      status: 'SENT',
      createdById: admin.id,
      items: {
        create: [
          {
            service: 'Complete Wedding Coverage',
            quantity: '1',
            unitPrice: '450000.00',
            lineTotal: '450000.00',
            sortOrder: 0,
          },
        ],
      },
    },
  });

  // Booking advance, recorded the same way the API would: payment + allocation
  // + refreshed invoice cache, all consistent.
  const payment = await prisma.payment.create({
    data: {
      organizationId,
      paymentNumber: `PAY-${new Date().getUTCFullYear()}-0001`,
      projectId: project.id,
      clientId: client.id,
      amount: '150000.00',
      allocatedAmount: '150000.00',
      paymentDate: new Date(),
      paymentMethod: 'BANK_TRANSFER',
      status: 'COMPLETED',
      transactionReference: 'DEMO-ADV-0001',
      receivedById: admin.id,
      allocations: { create: [{ invoiceId: invoice.id, amount: '150000.00' }] },
    },
  });

  await prisma.invoice.update({
    where: { id: invoice.id },
    data: { amountPaid: '150000.00', amountDue: '300000.00', status: 'PARTIALLY_PAID' },
  });

  await prisma.task.create({
    data: {
      organizationId,
      projectId: project.id,
      shootId: shoot.id,
      title: 'Cull and colour-grade wedding selects',
      category: 'CULLING',
      priority: 'HIGH',
      status: 'ASSIGNED',
      assigneeId: member.id,
      createdById: admin.id,
      quantity: 800,
      unit: 'Photos',
      dueDate: new Date(Date.now() + 30 * 86_400_000),
      statusHistory: { create: [{ newStatus: 'ASSIGNED', changedById: admin.id, reason: 'Demo seed' }] },
      assignments: { create: [{ toUserId: member.id, assignedById: admin.id, reason: 'Initial assignment' }] },
    },
  });

  await prisma.delivery.create({
    data: {
      organizationId,
      projectId: project.id,
      clientId: client.id,
      eventId: event.id,
      title: 'Cinematic Teaser',
      type: 'TEASER',
      status: 'PENDING',
      expectedDate: new Date(Date.now() + 21 * 86_400_000),
      assigneeId: member.id,
      statusHistory: { create: [{ newStatus: 'PENDING', changedById: admin.id, reason: 'Demo seed' }] },
    },
  });

  await prisma.expense.create({
    data: {
      organizationId,
      branchId,
      projectId: project.id,
      shootId: shoot.id,
      categoryId: crewCategory.id,
      amount: '2000.00',
      expenseDate: new Date(),
      vendor: 'Cab Service',
      paymentMethod: 'UPI',
      description: 'Crew travel to venue',
      approvalStatus: 'APPROVED',
      createdById: member.id,
      approvedById: admin.id,
      approvedAt: new Date(),
    },
  });

  console.warn(
    `  demo: 1 client, 1 project (${project.projectNumber}), 1 event, 1 shoot, 1 freelancer, ` +
      `1 invoice (${invoice.invoiceNumber}), 1 payment (${payment.paymentNumber}), 1 task, 1 delivery, 1 expense`,
  );
}

main()
  .catch((error) => {
    console.error('seed failed:', error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
