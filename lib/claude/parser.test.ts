import { describe, expect, it } from 'vitest';
import { ClassificationError } from '@/lib/errors';
import { parseClassifyResult } from './parser';

const BUCKETS = ['Important', 'Can Wait', 'Auto-Archive', 'Newsletter'];

interface RawClassification {
  thread_id: string;
  bucket: string;
  confidence: number;
  recommended_action: string;
  reasoning: string;
}

function classification(overrides: Partial<RawClassification> = {}): RawClassification {
  return {
    thread_id: '18c7d5f2a1b3c4d5',
    bucket: 'Newsletter',
    confidence: 0.94,
    recommended_action: 'archive',
    reasoning: 'Substack digest from a known sender, no action required.',
    ...overrides,
  };
}

describe('parseClassifyResult', () => {
  it('maps a valid response to ClassifiedThread[] with camelCase fields', () => {
    const raw = {
      classifications: [
        classification({
          thread_id: '18c7d5f2a1b3c4d5',
          bucket: 'Newsletter',
          confidence: 0.96,
          recommended_action: 'archive',
          reasoning: 'Substack weekly digest from a known sender.',
        }),
        classification({
          thread_id: '18c7d5f2a1b3c4d6',
          bucket: 'Important',
          confidence: 0.91,
          recommended_action: 'label',
          reasoning: 'Contract redlines from a known client, sign-off requested.',
        }),
        classification({
          thread_id: '18c7d5f2a1b3c4d7',
          bucket: 'Auto-Archive',
          confidence: 0.78,
          recommended_action: 'archive',
          reasoning: 'Amazon shipment confirmation, no action required.',
        }),
      ],
    };
    const out = parseClassifyResult(
      raw,
      ['18c7d5f2a1b3c4d5', '18c7d5f2a1b3c4d6', '18c7d5f2a1b3c4d7'],
      BUCKETS,
    );
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({
      threadId: '18c7d5f2a1b3c4d5',
      bucket: 'Newsletter',
      confidence: 0.96,
      recommendedAction: 'archive',
      reasoning: 'Substack weekly digest from a known sender.',
    });
    expect(out[1].recommendedAction).toBe('label');
    expect(out[2].bucket).toBe('Auto-Archive');
  });

  it('throws ClassificationError when an input thread is missing from the response', () => {
    const raw = {
      classifications: [classification({ thread_id: '18c7d5f2a1b3c4d5' })],
    };
    expect(() => parseClassifyResult(raw, ['18c7d5f2a1b3c4d5', 'missing_id'], BUCKETS)).toThrow(
      ClassificationError,
    );
    expect(() => parseClassifyResult(raw, ['18c7d5f2a1b3c4d5', 'missing_id'], BUCKETS)).toThrow(
      /Missing classification: missing_id/,
    );
  });

  it('filters out hallucinated thread_ids and returns only valid rows', () => {
    const raw = {
      classifications: [
        classification({ thread_id: '18c7d5f2a1b3c4d5' }),
        classification({ thread_id: 'fake_thread_xyz', bucket: 'Newsletter' }),
      ],
    };
    const out = parseClassifyResult(raw, ['18c7d5f2a1b3c4d5'], BUCKETS);
    expect(out).toHaveLength(1);
    expect(out[0].threadId).toBe('18c7d5f2a1b3c4d5');
  });

  it('throws ClassificationError on a bucket not in validBuckets', () => {
    const raw = {
      classifications: [classification({ thread_id: '18c7d5f2a1b3c4d5', bucket: 'TopSecret' })],
    };
    expect(() => parseClassifyResult(raw, ['18c7d5f2a1b3c4d5'], BUCKETS)).toThrow(
      ClassificationError,
    );
    expect(() => parseClassifyResult(raw, ['18c7d5f2a1b3c4d5'], BUCKETS)).toThrow(
      /Invalid bucket: TopSecret/,
    );
  });

  it('throws ClassificationError on an invalid bucket even when the thread_id is hallucinated', () => {
    // Validates the deliberate "bucket-validity before coverage" ordering:
    // bad bucket throws regardless of whether the row would have been filtered.
    const raw = {
      classifications: [
        classification({ thread_id: '18c7d5f2a1b3c4d5' }),
        classification({ thread_id: 'fake_thread_xyz', bucket: 'TopSecret' }),
      ],
    };
    expect(() => parseClassifyResult(raw, ['18c7d5f2a1b3c4d5'], BUCKETS)).toThrow(
      /Invalid bucket: TopSecret/,
    );
  });

  describe('malformed shape (Zod failures)', () => {
    it('throws on missing classifications key', () => {
      expect(() => parseClassifyResult({}, [], BUCKETS)).toThrow(ClassificationError);
      expect(() => parseClassifyResult({}, [], BUCKETS)).toThrow(/Invalid response shape/);
    });

    it('throws when classifications is not an array', () => {
      expect(() => parseClassifyResult({ classifications: 'not an array' }, [], BUCKETS)).toThrow(
        /Invalid response shape/,
      );
    });

    it('throws when confidence is a string', () => {
      const raw = {
        classifications: [
          { ...classification({ thread_id: '18c7d5f2a1b3c4d5' }), confidence: 'high' },
        ],
      };
      expect(() => parseClassifyResult(raw, ['18c7d5f2a1b3c4d5'], BUCKETS)).toThrow(
        /Invalid response shape/,
      );
    });

    it('throws when reasoning field is missing', () => {
      const item = classification({ thread_id: '18c7d5f2a1b3c4d5' });
      // strip reasoning to simulate Claude omitting a required field
      const { reasoning: _r, ...withoutReasoning } = item;
      void _r;
      const raw = { classifications: [withoutReasoning] };
      expect(() => parseClassifyResult(raw, ['18c7d5f2a1b3c4d5'], BUCKETS)).toThrow(
        /Invalid response shape/,
      );
    });

    it('throws when reasoning is an empty string', () => {
      const raw = {
        classifications: [classification({ thread_id: '18c7d5f2a1b3c4d5', reasoning: '' })],
      };
      expect(() => parseClassifyResult(raw, ['18c7d5f2a1b3c4d5'], BUCKETS)).toThrow(
        /Invalid response shape/,
      );
    });

    it('throws when reasoning is whitespace-only', () => {
      const raw = {
        classifications: [classification({ thread_id: '18c7d5f2a1b3c4d5', reasoning: '   ' })],
      };
      expect(() => parseClassifyResult(raw, ['18c7d5f2a1b3c4d5'], BUCKETS)).toThrow(
        /Invalid response shape/,
      );
    });

    it('throws when recommended_action is not in the enum', () => {
      const raw = {
        classifications: [
          classification({
            thread_id: '18c7d5f2a1b3c4d5',
            recommended_action: 'delete',
          }),
        ],
      };
      expect(() => parseClassifyResult(raw, ['18c7d5f2a1b3c4d5'], BUCKETS)).toThrow(
        /Invalid response shape/,
      );
    });
  });

  describe('out-of-range confidence', () => {
    it('throws on confidence > 1', () => {
      const raw = {
        classifications: [classification({ thread_id: '18c7d5f2a1b3c4d5', confidence: 1.5 })],
      };
      expect(() => parseClassifyResult(raw, ['18c7d5f2a1b3c4d5'], BUCKETS)).toThrow(
        ClassificationError,
      );
    });

    it('throws on confidence < 0', () => {
      const raw = {
        classifications: [classification({ thread_id: '18c7d5f2a1b3c4d5', confidence: -0.1 })],
      };
      expect(() => parseClassifyResult(raw, ['18c7d5f2a1b3c4d5'], BUCKETS)).toThrow(
        ClassificationError,
      );
    });
  });

  it('throws ClassificationError on a duplicate thread_id in the response', () => {
    const raw = {
      classifications: [
        classification({ thread_id: '18c7d5f2a1b3c4d5', confidence: 0.9 }),
        classification({ thread_id: '18c7d5f2a1b3c4d5', confidence: 0.7 }),
      ],
    };
    expect(() => parseClassifyResult(raw, ['18c7d5f2a1b3c4d5'], BUCKETS)).toThrow(
      ClassificationError,
    );
    expect(() => parseClassifyResult(raw, ['18c7d5f2a1b3c4d5'], BUCKETS)).toThrow(
      /Duplicate classification/,
    );
  });
});
