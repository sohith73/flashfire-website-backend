import mongoose from 'mongoose'

// Archive of every website Meta-ads form submission (raw capture, independent of CRM outcome)
export const MetaAdsFormSubmissionSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    email: {
        type: String,
        required: true,
        lowercase: true,
        trim: true,
        index: true
    },
    phone: {
        type: String,
        default: null
    },
    normalizedPhone: {
        type: String,
        default: null
    },
    status: {
        type: String,
        default: null
    },
    locale: {
        type: String,
        default: 'us'
    },
    clientGeo: {
        countryCode: { type: String, default: null },
        timezone: { type: String, default: null },
        language: { type: String, default: null }
    },
    serverGeo: {
        ip: { type: String, default: null },
        countryCode: { type: String, default: null },
        country: { type: String, default: null }
    },
    userAgent: {
        type: String,
        default: null
    },
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
    utmContent: {
        type: String,
        default: null
    },
    utmTerm: {
        type: String,
        default: null
    },
    fbclid: {
        type: String,
        default: null
    },
    fbp: {
        type: String,
        default: null
    },
    fbc: {
        type: String,
        default: null
    },
    market: {
        type: String,
        default: null
    },
    landingRoute: {
        type: String,
        default: null
    },
    gclid: {
        type: String,
        default: null
    },
    gbraid: {
        type: String,
        default: null
    },
    wbraid: {
        type: String,
        default: null
    },
    gadCampaignId: {
        type: String,
        default: null
    },
    pageUrl: {
        type: String,
        default: null
    },
    referrer: {
        type: String,
        default: null
    },
    visitorId: {
        type: String,
        default: null
    },
    bookingId: {
        type: String,
        default: null,
        index: true
    },
    outcome: {
        type: String,
        enum: ['created', 'merged', 'error'],
        default: null
    },
    errorMessage: {
        type: String,
        default: null
    }
}, {
    timestamps: true // This will add createdAt and updatedAt fields automatically
})

// Use the collection name 'meta_ads_form_submissions' explicitly
export const MetaAdsFormSubmissionModel = mongoose.model('MetaAdsFormSubmission', MetaAdsFormSubmissionSchema, 'meta_ads_form_submissions');
