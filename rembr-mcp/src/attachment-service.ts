/**
 * Attachment Service
 * Handles file uploads, downloads, and storage management for memories
 * Uses MinIO (S3-compatible) object storage
 */

import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { randomUUID } from 'crypto';
import type { MemoryDatabase } from './database.js';

export interface UploadAttachmentOptions {
  memoryId: string;
  tenantId: string;
  projectId?: string;
  userId?: string;
  filename: string;
  contentType: string;
  buffer: Buffer;
  isPrivate?: boolean;
  metadata?: Record<string, any>;
}

export interface Attachment {
  id: string;
  memory_id: string;
  tenant_id: string;
  user_id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  minio_bucket: string;
  minio_key: string;
  uploaded_at: Date;
  is_private: boolean;
  metadata: Record<string, any>;
}

export interface AttachmentAccessContext {
  tenantId: string;
  projectId?: string;
  userId?: string;
}

const MAX_PRESIGN_SECONDS = 60 * 60;
const MAX_METADATA_BYTES = 16 * 1024;
const MAX_METADATA_KEYS = 32;
const MAX_CUSTOM_QUOTA_BYTES = 10 * 1024 ** 4;
const MAX_ATTACHMENTS_PER_MEMORY = 100;
const ACTIVE_CONTENT_TYPES = new Set([
  'text/html', 'application/xhtml+xml', 'image/svg+xml',
  'application/xml', 'text/xml', 'application/javascript', 'text/javascript',
]);

export class AttachmentService {
  private s3Client: S3Client;
  private bucketName: string;
  private maxFileSize: number;

  constructor(
    private database: MemoryDatabase,
    endpoint: string,
    accessKey: string,
    secretKey: string,
    bucketName: string = 'rembr-attachments',
    maxFileSizeMB: number = 20
  ) {
    this.s3Client = new S3Client({
      endpoint,
      region: 'us-east-1', // MinIO doesn't care about region
      credentials: {
        accessKeyId: accessKey,
        secretAccessKey: secretKey
      },
      forcePathStyle: true, // Required for MinIO
      maxAttempts: 2,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 3_000,
        requestTimeout: 15_000,
      }),
    });

    this.bucketName = bucketName;
    this.maxFileSize = maxFileSizeMB * 1024 * 1024; // Convert MB to bytes
  }

  /**
   * Upload a file attachment to memory
   */
  async uploadAttachment(options: UploadAttachmentOptions): Promise<Attachment> {
    const { memoryId, tenantId, projectId, userId, filename, contentType, buffer, isPrivate, metadata } = options;

    const safeFilename = this.validateFilename(filename);
    const safeContentType = this.validateContentType(contentType);
    const safeMetadata = this.validateMetadata(metadata || {});
    const ownerPrincipal = this.ownerPrincipal(tenantId, userId);

    // Validate file size
    if (buffer.length === 0 || buffer.length > this.maxFileSize) {
      throw new Error(`File size exceeds maximum allowed size of ${this.maxFileSize / 1024 / 1024}MB`);
    }

    // Generate unique object key
    const objectKey = `${tenantId}/${randomUUID()}-${safeFilename.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    const attachmentId = randomUUID();

    // Reserve storage and persist a non-readable pending record before the
    // external object-store side effect. The usage row lock makes concurrent
    // uploads spend quota serially, and the parent memory is re-authorised in
    // the same transaction as the reservation.
    await this.database.withTenantTransaction(tenantId, async client => {
      const access = await client.query(
        `SELECT 1 FROM memories m
         LEFT JOIN projects p ON p.id = m.project_id AND p.tenant_id = m.tenant_id
         WHERE m.id = $1 AND m.tenant_id = $2
           AND ($3::uuid IS NULL OR m.project_id = $3::uuid)
           AND (
             (COALESCE(m.visibility, 'shared') = 'personal' AND m.user_id = $4::uuid)
             OR (COALESCE(m.visibility, 'shared') = 'shared' AND m.project_id IS NULL)
             OR (COALESCE(m.visibility, 'shared') IN ('shared', 'project')
                 AND p.id IS NOT NULL
                 AND (p.is_personal = false OR p.owner_id = $4::uuid
                      OR EXISTS (SELECT 1 FROM project_members pm
                                 WHERE pm.project_id = p.id AND pm.user_id = $4::uuid)))
           )
         FOR SHARE OF m`,
        [memoryId, tenantId, projectId || null, userId || null],
      );
      if (access.rows.length === 0) throw new Error('Memory not found or access denied');

      const planQuota = await client.query(
        `SELECT CASE LOWER(COALESCE(plan, 'free'))
           WHEN 'dev' THEN 104857600 WHEN 'free' THEN 104857600
           WHEN 'pro' THEN 5368709120 WHEN 'team' THEN 26843545600
           WHEN 'business' THEN 107374182400 WHEN 'enterprise' THEN 536870912000
           ELSE 104857600
         END AS quota_bytes
         FROM tenants WHERE id = $1`,
        [tenantId],
      );
      if (!planQuota.rows[0]) throw new Error('Tenant plan not found');
      await client.query(
        `INSERT INTO tenant_storage_usage (tenant_id, quota_bytes, metadata)
         VALUES ($1, $2, '{"quota_source":"plan"}'::jsonb)
         ON CONFLICT (tenant_id) DO UPDATE
         SET quota_bytes = EXCLUDED.quota_bytes,
             metadata = COALESCE(tenant_storage_usage.metadata, '{}'::jsonb) || '{"quota_source":"plan"}'::jsonb,
             updated_at = NOW()
         WHERE COALESCE(tenant_storage_usage.metadata->>'quota_source', 'plan') = 'plan'`,
        [tenantId, planQuota.rows[0].quota_bytes],
      );
      const usageResult = await client.query(
        `SELECT total_bytes, file_count, quota_bytes
         FROM tenant_storage_usage
         WHERE tenant_id = $1
         FOR UPDATE`,
        [tenantId],
      );
      const usage = usageResult.rows[0];
      if (Number(usage.total_bytes) + buffer.length > Number(usage.quota_bytes)) {
        throw new Error(
          `Storage quota exceeded. Used: ${this.formatBytes(Number(usage.total_bytes))}, ` +
          `Quota: ${this.formatBytes(Number(usage.quota_bytes))}`,
        );
      }

      await client.query(
        `INSERT INTO memory_attachments (
          id, memory_id, tenant_id, user_id, filename, content_type, size_bytes,
          minio_bucket, minio_key, is_private, metadata, upload_status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, 'pending')`,
        [
          attachmentId, memoryId, tenantId, ownerPrincipal, safeFilename,
          safeContentType, buffer.length, this.bucketName, objectKey,
          isPrivate || false, JSON.stringify(safeMetadata),
        ],
      );
    });

    // Upload to MinIO
    try {
      await this.s3Client.send(new PutObjectCommand({
        Bucket: this.bucketName,
        Key: objectKey,
        Body: buffer,
        ContentType: safeContentType,
        Metadata: {
          tenant_id: tenantId,
          user_id: ownerPrincipal,
          memory_id: memoryId,
          original_filename: safeFilename
        }
      }));
    } catch {
      await this.releaseReservation(attachmentId, tenantId);
      throw new Error('Failed to upload file to storage');
    }

    // Publish the reserved metadata only after the object is durable.
    let result;
    try {
      result = await this.database.query(
        `UPDATE memory_attachments
         SET upload_status = 'ready', updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2 AND upload_status = 'pending'
         RETURNING *`,
        [attachmentId, tenantId],
        tenantId,
      );
      if (result.rows.length !== 1) throw new Error('Attachment reservation was lost');
    } catch {
      // Do not leave an unreferenced object behind when the metadata write fails.
      try {
        await this.s3Client.send(new DeleteObjectCommand({
          Bucket: this.bucketName,
          Key: objectKey,
        }));
      } catch {
        // The original database failure is the actionable error. Object-store
        // lifecycle rules provide the final backstop for failed clean-up.
      }
      await this.releaseReservation(attachmentId, tenantId);
      throw new Error('Failed to save attachment metadata');
    }

    return result.rows[0] as Attachment;
  }

  /**
   * Get a presigned URL for downloading an attachment
   */
  async getDownloadUrl(
    attachmentId: string,
    context: AttachmentAccessContext,
    expiresInSeconds: number = 3600,
  ): Promise<string> {
    const { tenantId, userId } = context;
    // Fetch attachment metadata
    const result = await this.database.query(
      `SELECT * FROM memory_attachments
       WHERE id = $1 AND tenant_id = $2 AND upload_status = 'ready'`,
      [attachmentId, tenantId],
      tenantId,
    );

    if (result.rows.length === 0) {
      throw new Error('Attachment not found');
    }

    const attachment = result.rows[0] as Attachment;
    await this.requireMemoryAccess(attachment.memory_id, context);

    // Check privacy: if private, only owner can access
    if (attachment.is_private && attachment.user_id !== this.ownerPrincipal(tenantId, userId)) {
      throw new Error('Access denied: This attachment is private');
    }

    // Generate presigned URL
    const command = new GetObjectCommand({
      Bucket: attachment.minio_bucket,
      Key: attachment.minio_key,
      ResponseContentType: attachment.content_type || 'application/octet-stream',
      ResponseContentDisposition: this.contentDisposition(attachment.filename),
    });

    const safeExpiry = Math.min(MAX_PRESIGN_SECONDS, Math.max(60, Math.floor(expiresInSeconds)));
    const url = await getSignedUrl(this.s3Client, command, { expiresIn: safeExpiry });
    return url;
  }

  /**
   * List attachments for a memory
   */
  async listAttachments(memoryId: string, context: AttachmentAccessContext): Promise<Attachment[]> {
    const { tenantId, userId } = context;
    await this.requireMemoryAccess(memoryId, context);
    const result = await this.database.query(
      `SELECT * FROM memory_attachments
       WHERE memory_id = $1 AND tenant_id = $2
         AND upload_status = 'ready'
         AND (is_private = FALSE OR user_id = $3)
       ORDER BY uploaded_at DESC, id DESC
       LIMIT $4::integer`,
      [memoryId, tenantId, this.ownerPrincipal(tenantId, userId), MAX_ATTACHMENTS_PER_MEMORY],
      tenantId,
    );
    return result.rows.slice(0, MAX_ATTACHMENTS_PER_MEMORY) as Attachment[];
  }

  /**
   * Delete an attachment
   */
  async deleteAttachment(attachmentId: string, context: AttachmentAccessContext): Promise<void> {
    const { tenantId, userId } = context;
    // Fetch attachment metadata
    const result = await this.database.query(
      `SELECT * FROM memory_attachments
       WHERE id = $1 AND tenant_id = $2 AND upload_status = 'ready'`,
      [attachmentId, tenantId],
      tenantId,
    );

    if (result.rows.length === 0) {
      throw new Error('Attachment not found');
    }

    const attachment = result.rows[0] as Attachment;
    await this.requireMemoryAccess(attachment.memory_id, context);

    // Check ownership: only owner can delete
    if (attachment.user_id !== this.ownerPrincipal(tenantId, userId)) {
      throw new Error('Access denied: Only the owner can delete this attachment');
    }

    // Delete from MinIO
    try {
      await this.s3Client.send(new DeleteObjectCommand({
        Bucket: attachment.minio_bucket,
        Key: attachment.minio_key
      }));
    } catch {
      // Keep the database reference so the object remains discoverable for a
      // retry or operator clean-up. Deleting it here would create an orphan.
      throw new Error('Failed to delete attachment from storage');
    }

    // Delete from database (trigger will update storage usage)
    await this.database.query(
      'DELETE FROM memory_attachments WHERE id = $1 AND tenant_id = $2',
      [attachmentId, tenantId],
      tenantId,
    );
  }

  /**
   * Get storage usage for the caller's authorised attachment audience.
   * The quota is tenant-plan metadata, while counts and bytes are derived
   * from accessible parent memories instead of the tenant-wide usage row.
   */
  async getStorageUsage(context: AttachmentAccessContext): Promise<{
    total_bytes: number;
    file_count: number;
    quota_bytes: number;
    updated_at: Date;
  }> {
    const { tenantId, projectId, userId } = context;
    const ownerPrincipal = this.ownerPrincipal(tenantId, userId);
    const result = await this.database.query(
      `WITH accessible_attachments AS (
         SELECT a.size_bytes
         FROM memory_attachments a
         JOIN memories m ON m.id = a.memory_id AND m.tenant_id = a.tenant_id
         LEFT JOIN projects p ON p.id = m.project_id AND p.tenant_id = m.tenant_id
         WHERE a.tenant_id = $1
           AND a.upload_status = 'ready'
           AND ($2::uuid IS NULL OR m.project_id = $2::uuid)
           AND (a.is_private = false OR a.user_id = $4::text)
           AND (
             (COALESCE(m.visibility, 'shared') = 'personal' AND m.user_id = $3::uuid)
             OR (COALESCE(m.visibility, 'shared') = 'shared' AND m.project_id IS NULL)
             OR (
               COALESCE(m.visibility, 'shared') IN ('shared', 'project')
               AND p.id IS NOT NULL
               AND (
                 p.is_personal = false
                 OR p.owner_id = $3::uuid
                 OR EXISTS (
                   SELECT 1 FROM project_members pm
                   WHERE pm.project_id = p.id AND pm.user_id = $3::uuid
                 )
               )
             )
           )
       )
       SELECT COALESCE(SUM(accessible.size_bytes), 0)::bigint AS total_bytes,
              COUNT(accessible.size_bytes)::bigint AS file_count,
              COALESCE(usage.quota_bytes,
                CASE LOWER(COALESCE(tenant.plan, 'free'))
                  WHEN 'dev' THEN 104857600 WHEN 'free' THEN 104857600
                  WHEN 'pro' THEN 5368709120 WHEN 'team' THEN 26843545600
                  WHEN 'business' THEN 107374182400 WHEN 'enterprise' THEN 536870912000
                  ELSE 104857600
                END) AS quota_bytes,
              COALESCE(usage.updated_at, NOW()) AS updated_at
       FROM tenants tenant
       LEFT JOIN tenant_storage_usage usage ON usage.tenant_id = tenant.id
       LEFT JOIN accessible_attachments accessible ON true
       WHERE tenant.id = $1
       GROUP BY tenant.plan, usage.quota_bytes, usage.updated_at`,
      [tenantId, projectId || null, userId || null, ownerPrincipal],
      tenantId,
    );

    if (result.rows.length === 0) {
      throw new Error('Tenant plan not found');
    }

    return {
      total_bytes: Number(result.rows[0].total_bytes),
      file_count: Number(result.rows[0].file_count),
      quota_bytes: Number(result.rows[0].quota_bytes),
      updated_at: result.rows[0].updated_at,
    };
  }

  /**
   * Update storage quota for a tenant
   */
  async updateQuota(tenantId: string, quotaBytes: number): Promise<void> {
    if (!Number.isSafeInteger(quotaBytes) || quotaBytes < 1 || quotaBytes > MAX_CUSTOM_QUOTA_BYTES) {
      throw new Error('Invalid storage quota');
    }
    await this.database.query(
      `INSERT INTO tenant_storage_usage (tenant_id, quota_bytes, metadata)
       VALUES ($1, $2, '{"quota_source":"custom"}'::jsonb)
       ON CONFLICT (tenant_id) DO UPDATE
       SET quota_bytes = $2,
           metadata = COALESCE(tenant_storage_usage.metadata, '{}'::jsonb) || '{"quota_source":"custom"}'::jsonb,
           updated_at = NOW()`,
      [tenantId, quotaBytes],
      tenantId,
    );
  }

  getMaxFileSize(): number {
    return this.maxFileSize;
  }

  private ownerPrincipal(tenantId: string, userId?: string): string {
    // Autonomous, unclaimed agent tenants have no human user. A tenant-bound
    // principal keeps their private attachments usable without inventing a
    // privileged human identity or imposing a human-claim gate.
    return userId || `agent-tenant:${tenantId}`;
  }

  private async requireMemoryAccess(memoryId: string, context: AttachmentAccessContext): Promise<void> {
    const memory = await this.database.getMemoryById(
      memoryId,
      context.tenantId,
      context.projectId,
      context.userId,
    );
    if (!memory) {
      throw new Error('Memory not found or access denied');
    }
  }

  private validateFilename(filename: string): string {
    const value = filename.trim();
    if (!value || value.length > 255 || /[\\/\0\r\n]/.test(value) || value === '.' || value === '..') {
      throw new Error('Invalid attachment filename');
    }
    return value;
  }

  private validateContentType(contentType: string): string {
    const value = contentType.trim().toLowerCase();
    if (value.length > 100 || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:\s*;\s*[a-z0-9_-]+=[a-z0-9._-]+)*$/i.test(value)) {
      throw new Error('Invalid attachment content type');
    }
    return ACTIVE_CONTENT_TYPES.has(value.split(';', 1)[0])
      ? 'application/octet-stream'
      : value;
  }

  private async releaseReservation(attachmentId: string, tenantId: string): Promise<void> {
    try {
      await this.database.query(
        `DELETE FROM memory_attachments
         WHERE id = $1 AND tenant_id = $2 AND upload_status = 'pending'`,
        [attachmentId, tenantId],
        tenantId,
      );
    } catch {
      // A pending row is deliberately non-readable and still consumes quota.
      // Keeping it is safer than losing evidence needed for reconciliation.
    }
  }

  private contentDisposition(filename: string): string {
    const fallback = filename.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/["\\]/g, '_') || 'attachment';
    return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
  }

  private validateMetadata(metadata: Record<string, any>): Record<string, any> {
    const keys = Object.keys(metadata);
    if (keys.length > MAX_METADATA_KEYS || keys.some(key =>
      key.length === 0 || key.length > 64 || !/^[a-zA-Z0-9_.-]+$/.test(key) ||
      ['__proto__', 'constructor', 'prototype'].includes(key)
    )) {
      throw new Error('Invalid attachment metadata');
    }
    let encoded: string;
    try {
      encoded = JSON.stringify(metadata);
    } catch {
      throw new Error('Invalid attachment metadata');
    }
    if (Buffer.byteLength(encoded, 'utf8') > MAX_METADATA_BYTES) {
      throw new Error('Attachment metadata is too large');
    }
    return JSON.parse(encoded) as Record<string, any>;
  }

  /**
   * Format bytes to human-readable string
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  }
}
