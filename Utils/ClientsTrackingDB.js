import mongoose from 'mongoose';

/**
 * Secondary MongoDB connection to the clients-tracking database
 * (a different cluster than the main CRM DB). Holds the paying-client
 * records used by the Graphs module.
 *
 * Set CLIENTS_TRACKING_MONGODB_URI in the backend .env to enable it.
 * When unset, paid-client analytics are simply disabled (no crash).
 */
let connPromise = null;
let conn = null;
let clientUserModel = null;
let clientTrackingRecordModel = null;
let profileModel = null;

export async function getClientsTrackingConnection() {
  if (conn) return conn;
  const uri = process.env.CLIENTS_TRACKING_MONGODB_URI;
  if (!uri) {
    console.warn(
      '[ClientsTrackingDB] CLIENTS_TRACKING_MONGODB_URI not set — paid-client analytics disabled'
    );
    return null;
  }
  if (!connPromise) {
    const c = mongoose.createConnection(uri);
    c.on('error', (e) => console.error('[ClientsTrackingDB] connection error:', e.message));
    connPromise = c.asPromise().then((ready) => {
      conn = ready;
      console.log('✅ [ClientsTrackingDB] connected to clients-tracking DB');
      return ready;
    });
  }
  return connPromise;
}

// `strict: false` — we only read; the real schema lives in the clients-tracking repo.
const clientUserSchema = new mongoose.Schema(
  {
    name: String,
    email: String,
    planType: String,
  },
  { timestamps: true, strict: false }
);

export async function getClientUserModel() {
  const c = await getClientsTrackingConnection();
  if (!c) return null;
  if (!clientUserModel) {
    clientUserModel = c.model('ClientTrackingUser', clientUserSchema, 'users');
  }
  return clientUserModel;
}

const clientTrackingRecordSchema = new mongoose.Schema(
  {
    name: String,
    email: String,
    crmEmail: String,
    paymentEmail: String,
    planType: String,
    planPrice: Number,
    amountPaid: String,
    amountPaidDate: String,
    currency: String,
  },
  { timestamps: true, strict: false }
);

export async function getClientTrackingRecordModel() {
  const c = await getClientsTrackingConnection();
  if (!c) return null;
  if (!clientTrackingRecordModel) {
    clientTrackingRecordModel = c.model(
      'ClientTrackingRecord',
      clientTrackingRecordSchema,
      'dashboardtrackings'
    );
  }
  return clientTrackingRecordModel;
}

const profileSchema = new mongoose.Schema(
  { email: String, referredBy: String },
  { strict: false }
);

export async function getProfileModel() {
  const c = await getClientsTrackingConnection();
  if (!c) return null;
  if (!profileModel) {
    profileModel = c.model('DashProfile', profileSchema, 'profiles');
  }
  return profileModel;
}