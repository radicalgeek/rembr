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
  let mockTxQuery: any;

  function mockReservation(totalBytes = 1000, quotaBytes = 53687091200) {
    mockTxQuery
      .mockResolvedValueOnce({ rows: [{ allowed: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ quota_bytes: quotaBytes }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ total_bytes: totalBytes, file_count: 5, quota_bytes: quotaBytes }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
  }

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Create mock database
    mockTxQuery = vi.fn();
    mockDatabase = {
      query: vi.fn(),
      getMemoryById: vi.fn().mockResolvedValue({ id: 'mem-123' }),
      withTenantTransaction: vi.fn(async (_tenantId: string, work: (client: any) => Promise<any>) =>
        work({ query: mockTxQuery })),
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
    it('configures bounded object-store attempts and request timeouts', () => {
      const config = (S3Client as any).mock.calls.at(-1)[0];
      expect(config.maxAttempts).toBe(2);
      expect(config.requestHandler).toBeDefined();
    });

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

      mockReservation();

      // Mock S3 upload
      mockS3Client.send.mockResolvedValueOnce({});

      // Publish pending metadata after the object upload.
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

      mockReservation(53687091190, 53687091200);

      await expect(service.uploadAttachment(options)).rejects.toThrow('Storage quota exceeded');
    });

    it('refreshes plan-sourced quotas on plan changes while preserving custom overrides', async () => {
      mockReservation();
      mockS3Client.send.mockResolvedValueOnce({});
      (mockDatabase.query as any).mockResolvedValueOnce({ rows: [{ id: 'attachment-123' }] });
      await service.uploadAttachment({
        memoryId: 'mem-123', tenantId: 'tenant-123', userId: 'user-123',
        filename: 'plan.txt', contentType: 'text/plain', buffer: Buffer.from('test'),
      });

      const quotaUpsert = mockTxQuery.mock.calls.find((call: any[]) =>
        String(call[0]).includes('INSERT INTO tenant_storage_usage'));
      expect(quotaUpsert[0]).toContain('DO UPDATE');
      expect(quotaUpsert[0]).toContain("metadata->>'quota_source', 'plan'");
      expect(quotaUpsert[0]).toContain("= 'plan'");
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

      mockReservation();

      // Mock S3 failure
      mockS3Client.send.mockRejectedValueOnce(new Error('S3 connection error'));

      await expect(service.uploadAttachment(options)).rejects.toThrow('Failed to upload file to storage');
      expect(mockDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining("upload_status = 'pending'"),
        expect.arrayContaining(['tenant-123']),
        'tenant-123',
      );
    });

    it('serialises concurrent quota reservations before either S3 side effect', async () => {
      let totalBytes = 0;
      let tail = Promise.resolve();
      const query = vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes("SET upload_status = 'ready'")) return { rows: [{ id: 'ready' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      });
      const transactionalDb = {
        query,
        withTenantTransaction: vi.fn(async (_tenant: string, work: (client: any) => Promise<any>) => {
          let release!: () => void;
          const previous = tail;
          tail = new Promise<void>(resolve => { release = resolve; });
          await previous;
          try {
            return await work({
              query: vi.fn(async (sql: string, params: any[] = []) => {
                if (sql.includes('SELECT 1 FROM memories')) return { rows: [{ allowed: 1 }] };
                if (sql.includes('AS quota_bytes')) return { rows: [{ quota_bytes: 10 }] };
                if (sql.includes('SELECT total_bytes')) return { rows: [{ total_bytes: totalBytes, quota_bytes: 10 }] };
                if (sql.includes('INSERT INTO memory_attachments')) totalBytes += Number(params[6]);
                return { rows: [], rowCount: 1 };
              }),
            });
          } finally {
            release();
          }
        }),
      };
      const concurrentService = new AttachmentService(
        transactionalDb as any, 'http://localhost:9000', 'key', 'secret', 'bucket', 20,
      );
      mockS3Client.send.mockResolvedValue({});
      const base = {
        memoryId: 'mem-123', tenantId: 'tenant-123', userId: 'user-123',
        contentType: 'text/plain', buffer: Buffer.alloc(8),
      };
      const results = await Promise.allSettled([
        concurrentService.uploadAttachment({ ...base, filename: 'one.txt' }),
        concurrentService.uploadAttachment({ ...base, filename: 'two.txt' }),
      ]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
      expect(totalBytes).toBe(8);
      expect(mockS3Client.send).toHaveBeenCalledTimes(1);
    });

    it('compensates both object and quota reservation when ready publication fails', async () => {
      const options: UploadAttachmentOptions = {
        memoryId: 'mem-123', tenantId: 'tenant-123', userId: 'user-123',
        filename: 'test.txt', contentType: 'text/plain', buffer: Buffer.from('test'),
      };
      mockReservation();
      mockS3Client.send.mockResolvedValue({});
      (mockDatabase.query as any).mockRejectedValueOnce(new Error('metadata update failed'));

      await expect(service.uploadAttachment(options)).rejects.toThrow('Failed to save attachment metadata');
      expect(mockS3Client.send).toHaveBeenCalledTimes(2);
      expect(DeleteObjectCommand).toHaveBeenCalledTimes(1);
      expect(mockDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining("upload_status = 'pending'"),
        expect.any(Array),
        'tenant-123',
      );
    });

    it('stores active document types as a forced-download octet stream', async () => {
      mockReservation();
      mockS3Client.send.mockResolvedValue({});
      (mockDatabase.query as any).mockResolvedValueOnce({ rows: [{ id: 'attachment-123' }] });
      await service.uploadAttachment({
        memoryId: 'mem-123', tenantId: 'tenant-123', userId: 'user-123',
        filename: 'report.html', contentType: 'text/html', buffer: Buffer.from('<script>')
      });
      expect((PutObjectCommand as any).mock.calls[0][0].ContentType).toBe('application/octet-stream');
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
          filename: 'file.txt',
          content_type: 'text/plain',
          is_private: false
        }]
      });

      // Mock presigned URL generation
      (getSignedUrl as any).mockResolvedValueOnce('https://presigned-url.com/file.txt');

      const url = await service.getDownloadUrl('attachment-123', {
        tenantId: 'tenant-123', userId: 'different-user'
      });

      expect(url).toBe('https://presigned-url.com/file.txt');
      expect(getSignedUrl).toHaveBeenCalledWith(
        mockS3Client,
        expect.any(GetObjectCommand),
        { expiresIn: 3600 }
      );
      const command = (GetObjectCommand as any).mock.calls[0][0];
      expect(command.ResponseContentDisposition).toContain('attachment; filename="file.txt"');
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
          filename: 'private.txt',
          content_type: 'text/plain',
          is_private: true
        }]
      });

      (getSignedUrl as any).mockResolvedValueOnce('https://presigned-url.com/private.txt');

      const url = await service.getDownloadUrl('attachment-123', {
        tenantId: 'tenant-123', userId: 'user-123'
      });

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
        service.getDownloadUrl('attachment-123', {
          tenantId: 'tenant-123', userId: 'different-user'
        })
      ).rejects.toThrow('Access denied: This attachment is private');
    });

    it('should throw error when attachment not found', async () => {
      // Mock database query (no rows)
      (mockDatabase.query as any).mockResolvedValueOnce({
        rows: []
      });

      await expect(
        service.getDownloadUrl('nonexistent', {
          tenantId: 'tenant-123', userId: 'user-123'
        })
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

      const result = await service.listAttachments('mem-123', { tenantId: 'tenant-123' });

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

      const result = await service.listAttachments('mem-123', {
        tenantId: 'tenant-123', userId: 'user-123'
      });

      expect(result).toHaveLength(2);
    });

    it('caps the SQL and defensively caps an over-returning driver', async () => {
      (mockDatabase.query as any).mockResolvedValueOnce({
        rows: Array.from({ length: 1_000 }, (_, index) => ({ id: `att-${index}` })),
      });
      const result = await service.listAttachments('mem-123', { tenantId: 'tenant-123' });
      expect(result).toHaveLength(100);
      const [sql, params] = (mockDatabase.query as any).mock.calls[0];
      expect(sql).toMatch(/LIMIT \$4::integer/);
      expect(params[3]).toBe(100);
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

      await service.deleteAttachment('attachment-123', {
        tenantId: 'tenant-123', userId: 'user-123'
      });

      expect(mockS3Client.send).toHaveBeenCalledWith(expect.any(DeleteObjectCommand));
      expect(mockDatabase.query).toHaveBeenCalledWith(
        'DELETE FROM memory_attachments WHERE id = $1 AND tenant_id = $2',
        ['attachment-123', 'tenant-123'],
        'tenant-123',
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
        service.deleteAttachment('attachment-123', {
          tenantId: 'tenant-123', userId: 'different-user'
        })
      ).rejects.toThrow('Access denied: Only the owner can delete this attachment');
    });

    it('should retain the database reference if MinIO deletion fails', async () => {
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

      await expect(service.deleteAttachment('attachment-123', {
        tenantId: 'tenant-123', userId: 'user-123'
      })).rejects.toThrow('Failed to delete attachment from storage');

      expect(mockDatabase.query).not.toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM memory_attachments'),
        expect.anything(),
        expect.anything(),
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

      const usage = await service.getStorageUsage({
        tenantId: 'tenant-123',
        projectId: 'project-123',
        userId: 'user-123',
      });

      expect(usage.total_bytes).toBe(1024000);
      expect(usage.file_count).toBe(10);
      expect(usage.quota_bytes).toBe(53687091200);
      expect(mockDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining('WITH accessible_attachments AS'),
        ['tenant-123', 'project-123', 'user-123', 'user-123'],
        'tenant-123',
      );
      const scopedSql = (mockDatabase.query as any).mock.calls[0][0] as string;
      expect(scopedSql).toContain('m.project_id = $2::uuid');
      expect(scopedSql).toContain("m.visibility, 'shared') = 'personal'");
      expect(scopedSql).toContain('project_members');
      expect(scopedSql).toContain("a.upload_status = 'ready'");
      expect(scopedSql).toContain('a.is_private = false OR a.user_id = $4::text');
    });

    it('should derive the free-plan quota when no usage row exists', async () => {
      (mockDatabase.query as any).mockResolvedValueOnce({
        rows: [{ total_bytes: 0, file_count: 0, quota_bytes: 104857600, updated_at: new Date() }]
      });

      const usage = await service.getStorageUsage({ tenantId: 'new-tenant' });

      expect(usage.total_bytes).toBe(0);
      expect(usage.file_count).toBe(0);
      expect(usage.quota_bytes).toBe(104857600);
    });
  });

  describe('updateQuota', () => {
    it('should update quota for tenant', async () => {
      (mockDatabase.query as any).mockResolvedValueOnce({ rows: [] });

      await service.updateQuota('tenant-123', 107374182400); // 100GB

      expect(mockDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO tenant_storage_usage'),
        ['tenant-123', 107374182400],
        'tenant-123'
      );
    });
  });
});
