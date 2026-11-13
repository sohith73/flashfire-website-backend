import mongoose from 'mongoose';

// One row per warning letter to a BDA about missed meetings in a calendar month (see Utils/WarningLetters.js).
// A letter starts as a draft an admin can read, send or dismiss; in live mode the system sends it at once.
// Rows are never deleted: the subject and body are stored exactly as they were (or would be) sent.

export const WARNING_STATUSES = Object.freeze(['draft', 'sent', 'failed', 'dismissed']);

const MissedItemSchema = new mongoose.Schema(
  {
    bookingId: { type: String, default: null },
    clientName: { type: String, default: null },
    scheduledStart: { type: Date, default: null },
    amountInr: { type: Number, default: 0 },
  },
  { _id: false }
);

const BdaWarningLetterSchema = new mongoose.Schema(
  {
    letterId: {
      type: String,
      unique: true,
      required: true,
      default: () => `warn_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
    },
    bdaEmail: { type: String, required: true, trim: true, lowercase: true, index: true },
    bdaName: { type: String, default: null },
    level: { type: Number, enum: [1, 2, 3], required: true },
    // The count that triggered it, and the policy threshold for this level (7, 10 or 15).
    threshold: { type: Number, required: true },
    missedCount: { type: Number, required: true },
    windowFrom: { type: Date, required: true },
    windowTo: { type: Date, required: true },
    missed: { type: [MissedItemSchema], default: [] },
    totalAmountInr: { type: Number, default: 0 },
    status: { type: String, enum: WARNING_STATUSES, default: 'draft', index: true },
    subject: { type: String, required: true },
    bodyText: { type: String, required: true },
    bodyHtml: { type: String, required: true },
    toEmail: { type: String, default: null },
    ccEmails: { type: [String], default: [] },
    sentAt: { type: Date, default: null },
    sentBy: { type: String, default: null }, // 'system' or the admin's email
    error: { type: String, default: null },
    dismissedAt: { type: Date, default: null },
    dismissedBy: { type: String, default: null },
    dismissNote: { type: String, default: null },
  },
  { timestamps: true, versionKey: false }
);

BdaWarningLetterSchema.index({ bdaEmail: 1, level: 1, createdAt: -1 });

export const BdaWarningLetterModel =
  mongoose.models.BdaWarningLetter || mongoose.model('BdaWarningLetter', BdaWarningLetterSchema);
