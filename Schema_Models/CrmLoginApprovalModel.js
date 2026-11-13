import mongoose from 'mongoose';

// Tracks a BDA login attempt from an unrecognized device, pending admin approval.
// Once approved, the deviceKey is remembered on CrmUserModel-adjacent trusted-device
// list so future logins from the same device/browser skip this gate.
const CrmLoginApprovalSchema = new mongoose.Schema({
  email: { type: String, required: true, index: true },
  name: { type: String },
  deviceKey: { type: String, required: true },
  sessionId: { type: String, required: true, unique: true },
  ip: { type: String },
  countryCode: { type: String },
  country: { type: String },
  browser: { type: String },
  os: { type: String },
  deviceType: { type: String },
  userAgent: { type: String },
  status: { type: String, enum: ['pending', 'approved', 'denied'], default: 'pending', index: true },
  resolvedBy: { type: String },
  resolvedAt: { type: Date },
  expiresIn: { type: String }, // always '30d' now; kept for older records
  issuedToken: { type: String }, // set once approved; cleared after the BDA's poll picks it up
}, { timestamps: true });

export const CrmLoginApprovalModel = mongoose.model('CrmLoginApproval', CrmLoginApprovalSchema);
