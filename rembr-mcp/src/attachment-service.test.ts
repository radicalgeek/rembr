/**
 * Tests for AttachmentService
 * Covers upload, download, delete, quota enforcement, and privacy checks
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AttachmentService, type UploadAttachmentOptions } from './attachment-service.js';
import type { MemoryDatabase } from './database.js';

// Mock AWS SDK
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({
    send: vi.fn()
  })),
  PutObjectCommand: vi.fn(),
  GetObjectCommand: vi.fn(),
  DeleteObjectCommand: vi.fn(),
  HeadObjectCommand: vi.fn()
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn()
}));

import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

describe('AttachmentService', () => {
  let service: AttachmentService;
  let mockDatabase: MemoryDatabase;
  let mockS3Client: any;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Create mock database
    mockDatabase = {
      query: vi.fn()
    } as any;

    // Create mock S3 client
    mockS3Client = {
      send: vi.fn()
    };

    (S3Client as any).mockImplementation(() => mockS3Client);

    // Create service
    service = new AttachmentService(
      mockDatabase,
      'http://localhost:9000',
      'test-access-key',
      'test-secret-key',
      'test-bucket',
      20 // 20MB max
    );
  });

  describe('uploadAttachment', () => {
    it('should successfully upload a file', async () => {
      const buffer = Buffer.from('test file content');
      const options: UploadAttachmentOptions = {
        memoryId: 'mem-123',
        tenantId: 'tenant-123',
        userId: 'user-123',
        filename: 'test.txt',
        contentType: 'text/plain',
        buffer,
        isPrivate: false,
        metadata: { tags: ['test'] }
      };

      // Mock storage usage check (plenty of quota)
      (mockDatabase.query as any).mockResolvedValueOnce({
        rows: [{
          total_bytes: 1000,
          file_count: 5,
          quota_bytes: 53687091200, // 50GB
          updated_at: new Date()
        }]
      });

      // Mock S3 upload
      mockS3Client.send.mockResolvedValueOnce({});

      // Mock database insert
      (mockDatabase.query as any).mockResolvedValueOnce({
        rows: [{
          id: 'attachment-123',
          memory_id: 'mem-123',
          tenant_id: 'tenant-123',
          user_id: 'user-123',
          filename: 'test.txt',
          content_type: 'text/plain',
          size_bytes: buffer.length,
          minio_bucket: 'test-bucket',
          minio_key: 'tenant-123/some-uuid-test.txt',
          uploaded_at: new Date(),
          is_private: false,
          metadata: { tags: ['test'] }
        }]
      });

      const result = await service.uploadAttachment(options);

      expect(result.id).toBe('attachment-123');
      expect(result.filename).toBe('test.txt');
      expect(result.size_bytes).toBe(buffer.length);
      expect(mockS3Client.send).toHaveBeenCalledWith(expect.any(PutObjectCommand));
    });

    it('should reject files exceeding max size', async () => {
      const largeBuffer = Buffer.alloc(21 * 1024 * 1024); // 21MB
      const options: UploadAttachmentOptions = {
        memoryId: 'mem-123',
        tenantId: 'tenant-123',
        userId: 'user-123',
        filename: 'large.txt',
        contentType: 'text/plain',
        buffer: largeBuffer
      };

      await expect(service.uploadAttachment(options)).rejects.toThrow('File size exceeds maximum allowed size of 20MB');
    });

    it('should enforce storage quota', async () => {
      const buffer = Buffer.from('test content');
      const options: UploadAttachmentOptions = {
        memoryId: 'mem-123',
        tenantId: 'tenant-123',
        userId: 'user-123',
        filename: 'test.txt',
        contentType: 'text/plain',
        buffer
      };

      // Mock storage usage at quota limit
      (mockDatabase.query as any).mockResolvedValueOnce({
        rows: [{
          total_bytes: 53687091190, // 10 bytes under 50GB
          file_count: 100,
          quota_bytes: 53687091200, // 50GB
          updated_at: new Date()
        }]
      });

      await expect(service.uploadAttachment(options)).rejects.toThrow('Storage quota exceeded');
    });

    it('should handle S3 upload failure', async () => {
      const buffer = Buffer.from('test content');
      const options: UploadAttachmentOptions = {
        memoryId: 'mem-123',
        tenantId: 'tenant-123',
        userId: 'user-123',
        filename: 'test.txt',
        contentType: 'text/plain',
        buffer
      };

      // Mock storage usage check
      (mockDatabase.query as any).mockResolvedValueOnce({
        rows: [{
          total_bytes: 1000,
          file_count: 5,
          quota_bytes: 53687091200,
          updated_at: new Date()
        }]
      });

      // Mock S3 failure
      mockS3Client.send.mockRejectedValueOnce(new Error('S3 connection error'));

      await expect(service.uploadAttachment(options)).rejects.toThrow('Failed to upload file to storage');
    });
  });

  describe('getDownloadUrl', () => {
    it('should generate presigned URL for public attachment', async () => {
      // Mock database query for attachment
      (mockDatabase.query as any).mockResolvedValueOnce({
        rows: [{
          id: 'attachment-123',
          tenant_id: 'tenant-123',
          user_id: 'user-123',
          minio_bucket: 'test-bucket',
          minio_key: 'tenant-123/file.txt',
          is_private: false
        }]
      });

      // Mock presigned URL generation
      (getSignedUrl as any).mockResolvedValueOnce('https://presigned-url.com/file.txt');

      const url = await service.getDownloadUrl('attachment-123', 'tenant-123', 'different-user');

      expect(url).toBe('https://presigned-url.com/file.txt');
      expect(getSignedUrl).toHaveBeenCalledWith(
        mockS3Client,
        expect.any(GetObjectCommand),
        { expiresIn: 3600 }
      );
    });

    it('should generate presigned URL for private attachment (owner)', async () => {
      // Mock database query
      (mockDatabase.query as any).mockResolvedValueOnce({
        rows: [{
          id: 'attachment-123',
          tenant_id: 'tenant-123',
          user_id: 'user-123',
          minio_bucket: 'test-bucket',
          minio_key: 'tenant-123/private.txt',
          is_private: true
        }]
      });

      (getSignedUrl as any).mockResolvedValueOnce('https://presigned-url.com/private.txt');

      const url = await service.getDownloadUrl('attachment-123', 'tenant-123', 'user-123');

      expect(url).toBe('https://presigned-url.com/private.txt');
    });

    it('should deny access to private attachment (non-owner)', async () => {
      // Mock database query
      (mockDatabase.query as any).mockResolvedValueOnce({
        rows: [{
          id: 'attachment-123',
          tenant_id: 'tenant-123',
          user_id: 'user-123',
          minio_bucket: 'test-bucket',
          minio_key: 'tenant-123/private.txt',
          is_private: true
        }]
      });

      await expect(
        service.getDownloadUrl('attachment-123', 'tenant-123', 'different-user')
      ).rejects.toThrow('Access denied: This attachment is private');
    });

    it('should throw error when attachment not found', async () => {
      // Mock database query (no rows)
      (mockDatabase.query as any).mockResolvedValueOnce({
        rows: []
      });

      await expect(
        service.getDownloadUrl('nonexistent', 'tenant-123', 'user-123')
      ).rejects.toThrow('Attachment not found');
    });
  });

  describe('listAttachments', () => {
    it('should list all public attachments when no userId provided', async () => {
      (mockDatabase.query as any).mockResolvedValueOnce({
        rows: [
          { id: 'att-1', filename: 'file1.txt', is_private: false },
          { id: 'att-2', filename: 'file2.txt', is_private: false }
        ]
      });

      const result = await service.listAttachments('mem-123', 'tenant-123');

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('att-1');
    });

    it('should filter by privacy when userId provided', async () => {
      (mockDatabase.query as any).mockResolvedValueOnce({
        rows: [
          { id: 'att-1', filename: 'public.txt', is_private: false, user_id: 'user-123' },
          { id: 'att-2', filename: 'mine.txt', is_private: true, user_id: 'user-123' }
        ]
      });

      const result = await service.listAttachments('mem-123', 'tenant-123', 'user-123');

      expect(result).toHaveLength(2);
    });
  });

  describe('deleteAttachment', () => {
    it('should successfully delete attachment (owner)', async () => {
      // Mock fetch attachment
      (mockDatabase.query as any).mockResolvedValueOnce({
        rows: [{
          id: 'attachment-123',
          tenant_id: 'tenant-123',
          user_id: 'user-123',
          minio_bucket: 'test-bucket',
          minio_key: 'tenant-123/file.txt'
        }]
      });

      // Mock S3 delete
      mockS3Client.send.mockResolvedValueOnce({});

      // Mock database delete
      (mockDatabase.query as any).mockResolvedValueOnce({ rows: [] });

      await service.deleteAttachment('attachment-123', 'tenant-123', 'user-123');

      expect(mockS3Client.send).toHaveBeenCalledWith(expect.any(DeleteObjectCommand));
      expect(mockDatabase.query).toHaveBeenCalledWith(
        'DELETE FROM memory_attachments WHERE id = $1',
        ['attachment-123']
      );
    });

    it('should deny deletion for non-owner', async () => {
      // Mock fetch attachment
      (mockDatabase.query as any).mockResolvedValueOnce({
        rows: [{
          id: 'attachment-123',
          tenant_id: 'tenant-123',
          user_id: 'user-123',
          minio_bucket: 'test-bucket',
          minio_key: 'tenant-123/file.txt'
        }]
      });

      await expect(
        service.deleteAttachment('attachment-123', 'tenant-123', 'different-user')
      ).rejects.toThrow('Access denied: Only the owner can delete this attachment');
    });

    it('should continue deletion even if MinIO delete fails', async () => {
      // Mock fetch attachment
      (mockDatabase.query as any).mockResolvedValueOnce({
        rows: [{
          id: 'attachment-123',
          tenant_id: 'tenant-123',
          user_id: 'user-123',
          minio_bucket: 'test-bucket',
          minio_key: 'tenant-123/file.txt'
        }]
      });

      // Mock S3 delete failure
      mockS3Client.send.mockRejectedValueOnce(new Error('S3 error'));

      // Mock database delete
      (mockDatabase.query as any).mockResolvedValueOnce({ rows: [] });

      // Should not throw
      await service.deleteAttachment('attachment-123', 'tenant-123', 'user-123');

      // Database delete should still happen
      expect(mockDatabase.query).toHaveBeenCalledWith(
        'DELETE FROM memory_attachments WHERE id = $1',
        ['attachment-123']
      );
    });
  });

  describe('getStorageUsage', () => {
    it('should return storage usage for tenant', async () => {
      (mockDatabase.query as any).mockResolvedValueOnce({
        rows: [{
          total_bytes: 1024000,
          file_count: 10,
          quota_bytes: 53687091200,
          updated_at: new Date('2026-02-08T10:00:00Z')
        }]
      });

      const usage = await service.getStorageUsage('tenant-123');

      expect(usage.total_bytes).toBe(1024000);
      expect(usage.file_count).toBe(10);
      expect(usage.quota_bytes).toBe(53687091200);
    });

    it('should return defaults when no usage exists', async () => {
      (mockDatabase.query as any).mockResolvedValueOnce({
        rows: []
      });

      const usage = await service.getStorageUsage('new-tenant');

      expect(usage.total_bytes).toBe(0);
      expect(usage.file_count).toBe(0);
      expect(usage.quota_bytes).toBe(53687091200); // 50GB default
    });
  });

  describe('updateQuota', () => {
    it('should update quota for tenant', async () => {
      (mockDatabase.query as any).mockResolvedValueOnce({ rows: [] });

      await service.updateQuota('tenant-123', 107374182400); // 100GB

      expect(mockDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO tenant_storage_usage'),
        ['tenant-123', 107374182400]
      );
    });
  });
});
