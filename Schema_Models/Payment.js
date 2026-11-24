import mongoose from "mongoose";

export const PaymentSchema = new mongoose.Schema({
  paymentId: {
    type: String,
    unique: true,
    required: true,
    default: () => `payment_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  },
  // PayPal payment details
  paypalOrderId: {
    type: String,
    required: true,
    index: true
  },
  paypalPayerId: {
    type: String,
    required: true
  },
  paypalPayerEmail: {
    type: String,
    required: true,
    index: true
  },
  // Payment amount
  amount: {
    type: Number,
    required: true
  },
  currency: {
    type: String,
    required: true,
    default: 'USD'
  },
  // Plan details
  planName: {
    type: String,
    required: true
  },
  planSubtitle: {
    type: String,
    required: true
  },
  description: {
    type: String,
    default: null
  },
  // Customer details (from post-payment form)
  customerFirstName: {
    type: String,
    required: true
  },
  customerLastName: {
    type: String,
    required: true
  },
  customerEmail: {
    type: String,
    required: true,
    index: true,
    lowercase: true
  },
  customerMobile: {
    type: String,
    required: true
  },
  // Password for email (to apply for jobs)
  customerPassword: {
    type: String,
    required: true
  },
  // Auto onboarding (dashboard user created on payment): stamped once the clients-tracking backend answered.
  autoOnboardedAt: { type: Date, default: null, index: true },
  autoOnboardResult: { type: String, default: '' },
  // Payment status
  paymentStatus: {
    type: String,
    enum: ['pending', 'completed', 'failed', 'refunded'],
    default: 'completed',
    index: true
  },
  // Payment metadata
  paymentDate: {
    type: Date,
    default: Date.now,
    index: true
  },
  // UTM tracking (if available)
  utmSource: {
    type: String,
    default: null
  },
  utmMedium: {
    type: String,
    default: null
  },
  utmCampaign: {
    type: String,
    default: null
  },
  // Additional notes
  notes: {
    type: String,
    default: null
  }
}, {
  timestamps: true
});

// Indexes for efficient queries
PaymentSchema.index({ paymentDate: -1 });
PaymentSchema.index({ customerEmail: 1, paymentDate: -1 });
PaymentSchema.index({ paypalOrderId: 1 });

export const PaymentModel = mongoose.model('Payment', PaymentSchema);

