import mongoose from 'mongoose';

// Addresses that used the unsubscribe link in one of our emails (see Utils/Unsubscribe.js). Rows are only ever added.
const EmailUnsubscribeSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    source: { type: String, default: 'link' },
    unsubscribedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

export const EmailUnsubscribeModel =
  mongoose.models.EmailUnsubscribe || mongoose.model('EmailUnsubscribe', EmailUnsubscribeSchema);
