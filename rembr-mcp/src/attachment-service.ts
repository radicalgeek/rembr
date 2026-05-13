/**
 * Attachment Service
 * Handles file uploads, downloads, and storage management for memories
 * Uses MinIO (S3-compatible) object storage
 */

import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import type { MemoryDatabase } from './database.js';

export interface UploadAttachmentOptions {
  memoryId: string;
  tenantId: string;
  userId: string;
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
      forcePathStyle: true // Required for MinIO
    });

    this.bucketName = bucketName;
    this.maxFileSize = maxFileSizeMB * 1024 * 1024; // Convert MB to bytes
  }

  /**
   * Upload a file attachment to memory
   */
  async uploadAttachment(options: UploadAttachmentOptions): Promise<Attachment> {
    const { memoryId, tenantId, userId, filename, contentType, buffer, isPrivate, metadata } = options;

    // Validate file size
    if (buffer.length > this.maxFileSize) {
      throw new Error(`File size exceeds maximum allowed size of ${this.maxFileSize / 1024 / 1024}MB`);
    }

    // Check storage quota
    const usage = await this.getStorageUsage(tenantId);
    if (usage.total_bytes + buffer.length > usage.quota_bytes) {
      throw new Error(`Storage quota exceeded. Used: ${this.formatBytes(usage.total_bytes)}, Quota: ${this.formatBytes(usage.quota_bytes)}`);
    }

    // Generate unique object key
    const objectKey = `${tenantId}/${randomUUID()}-${filename.replace(/[^a-zA-Z0-9.-]/g, '_')}`;

    // Upload to MinIO
    try {
      await this.s3Client.send(new PutObjectCommand({
        Bucket: this.bucketName,
        Key: objectKey,
        Body: buffer,
        ContentType: contentType,
        Metadata: {
          tenant_id: tenantId,
          user_id: userId,
          memory_id: memoryId,
          original_filename: filename
        }
      }));
    } catch (error) {
      throw new Error(`Failed to upload file to storage: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    // Save metadata to database
    const result = await this.database.query(
      `INSERT INTO memory_attachments (
        memory_id, tenant_id, user_id, filename, content_type, size_bytes,
        minio_bucket, minio_key, is_private, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
      [
        memoryId,
        tenantId,
        userId,
        filename,
        contentType,
        buffer.length,
        this.bucketName,
        objectKey,
        isPrivate || false,
        JSON.stringify(metadata || {})
      ]
    );

    return result.rows[0] as Attachment;
  }

  /**
   * Get a presigned URL for downloading an attachment
   */
  async getDownloadUrl(attachmentId: string, tenantId: string, userId: string, expiresInSeconds: number = 3600): Promise<string> {
    // Fetch attachment metadata
    const result = await this.database.query(
      'SELECT * FROM memory_attachments WHERE id = $1 AND tenant_id = $2',
      [attachmentId, tenantId]
    );

    if (result.rows.length === 0) {
      throw new Error('Attachment not found');
    }

    const attachment = result.rows[0] as Attachment;

    // Check privacy: if private, only owner can access
    if (attachment.is_private && attachment.user_id !== userId) {
      throw new Error('Access denied: This attachment is private');
    }

    // Generate presigned URL
    const command = new GetObjectCommand({
      Bucket: attachment.minio_bucket,
      Key: attachment.minio_key
    });

    const url = await getSignedUrl(this.s3Client, command, { expiresIn: expiresInSeconds });
    return url;
  }

  /**
   * List attachments for a memory
   */
  async listAttachments(memoryId: string, tenantId: string, userId?: string): Promise<Attachment[]> {
    let query = 'SELECT * FROM memory_attachments WHERE memory_id = $1 AND tenant_id = $2';
    const params: any[] = [memoryId, tenantId];

    // If userId provided, filter by privacy
    if (userId) {
      query += ' AND (is_private = FALSE OR user_id = $3)';
      params.push(userId);
    }

    query += ' ORDER BY uploaded_at DESC';

    const result = await this.database.query(query, params);
    return result.rows as Attachment[];
  }

  /**
   * Delete an attachment
   */
  async deleteAttachment(attachmentId: string, tenantId: string, userId: string): Promise<void> {
    // Fetch attachment metadata
    const result = await this.database.query(
      'SELECT * FROM memory_attachments WHERE id = $1 AND tenant_id = $2',
      [attachmentId, tenantId]
    );

    if (result.rows.length === 0) {
      throw new Error('Attachment not found');
    }

    const attachment = result.rows[0] as Attachment;

    // Check ownership: only owner can delete
    if (attachment.user_id !== userId) {
      throw new Error('Access denied: Only the owner can delete this attachment');
    }

    // Delete from MinIO
    try {
      await this.s3Client.send(new DeleteObjectCommand({
        Bucket: attachment.minio_bucket,
        Key: attachment.minio_key
      }));
    } catch (error) {
      console.error('Failed to delete from MinIO:', error);
      // Continue with database deletion even if MinIO delete fails
    }

    // Delete from database (trigger will update storage usage)
    await this.database.query(
      'DELETE FROM memory_attachments WHERE id = $1',
      [attachmentId]
    );
  }

  /**
   * Get storage usage for a tenant
   */
  async getStorageUsage(tenantId: string): Promise<{
    total_bytes: number;
    file_count: number;
    quota_bytes: number;
    updated_at: Date;
  }> {
    const result = await this.database.query(
      `SELECT total_bytes, file_count, quota_bytes, updated_at 
       FROM tenant_storage_usage 
       WHERE tenant_id = $1`,
      [tenantId]
    );

    if (result.rows.length === 0) {
      // No usage yet - return defaults
      return {
        total_bytes: 0,
        file_count: 0,
        quota_bytes: 53687091200, // 50GB default
        updated_at: new Date()
      };
    }

    return result.rows[0];
  }

  /**
   * Update storage quota for a tenant
   */
  async updateQuota(tenantId: string, quotaBytes: number): Promise<void> {
    await this.database.query(
      `INSERT INTO tenant_storage_usage (tenant_id, quota_bytes)
       VALUES ($1, $2)
       ON CONFLICT (tenant_id) DO UPDATE
       SET quota_bytes = $2, updated_at = NOW()`,
      [tenantId, quotaBytes]
    );
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
