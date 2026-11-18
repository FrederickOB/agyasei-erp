/**
 * The document a screen shows for a sale: the queue's snapshot if the device
 * still has it, otherwise rebuilt from the synced rows, otherwise null (and the
 * caller says so plainly instead of rendering half a receipt).
 */
import type { LocalDb } from '../data/db';
import type { ReceiptDocument } from './document';
import { getQueueEntry } from './queue';
import { documentFromSyncedSale } from './sources';

export async function loadReceiptDocument(db: LocalDb, saleId: string): Promise<ReceiptDocument | null> {
  try {
    const entry = await getQueueEntry(db, saleId);
    if (entry?.doc != null) return entry.doc;
    return await documentFromSyncedSale(db, saleId);
  } catch {
    return null;
  }
}
