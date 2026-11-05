import mongoose from "mongoose";

const BdaAttendanceSchema = new mongoose.Schema(
  {
    attendanceId: {
      type: String,
      unique: true,
      required: true,
      default: () =>
        `bda_att_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    },

    bdaName: {
      type: String,
      required: true,
      trim: true,
    },

    bdaEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },

    bookingId: {
      type: String,
      required: true,
      index: true,
    },

    meetLink: {
      type: String,
      default: null,
    },

    joinedAt: {
      type: Date,
      default: null,
    },

    // First-ever join time for this meeting. Unlike `joinedAt` (which is cleared
    // when a session closes), this is set once and never overwritten, so the
    // "In time" survives leave/rejoin and post-meeting review.
    firstJoinedAt: {
      type: Date,
      default: null,
    },

    leftAt: {
      type: Date,
      default: null,
    },

    status: {
      // "absent" is set ONLY when a BDA explicitly marks themselves absent.
      // "unmarked" = no response captured (scheduler / bad join URL) — the BDA
      // may have simply forgotten to mark, so it must NOT count as absent.
      type: String,
      enum: ["present", "absent", "manual", "unmarked"],
      required: true,
      index: true,
    },

    source: {
      // "meet_api" = written from Google's Meet REST API conference records
      // (server-side, authoritative). Wins over extension DOM detection.
      type: String,
      enum: ["auto", "manual", "scheduler", "meet_api"],
      required: true,
    },

    markedAt: {
      type: Date,
      default: Date.now,
    },

    meetingScheduledStart: {
      type: Date,
      required: true,
    },

    meetingScheduledEnd: {
      type: Date,
      default: null,
    },

    discordNotified: {
      type: Boolean,
      default: false,
    },

    /** Last Discord warn "BDA Not in Meeting" for this row (if any) */
    warnDiscordSentAt: {
      type: Date,
      default: null,
    },

    /** Sum of completed in-meet segments (ms) */
    cumulativeDurationMs: {
      type: Number,
      default: 0,
    },

    /** Total duration after last completed segment */
    durationMs: {
      type: Number,
      default: null,
    },

    notes: {
      type: String,
      default: null,
    },

    /** Last explicit end action (from extension / beacon) */
    lastEndSource: {
      type: String,
      default: null,
    },

    lastEndedAt: {
      type: Date,
      default: null,
    },

    lastEndMeetLink: {
      type: String,
      default: null,
    },

    // ---- Google Meet REST API fields (source: meet_api) ----

    /** conferenceRecords/{id} this attendance was reconciled against */
    conferenceRecordName: {
      type: String,
      default: null,
    },

    /** firstJoinedAt - scheduledStart (negative = joined early) */
    lateByMs: {
      type: Number,
      default: null,
    },

    /** Every join/leave segment from participantSessions (authoritative) */
    sessions: {
      type: [
        {
          _id: false,
          startTime: { type: Date, default: null },
          endTime: { type: Date, default: null },
          durationMs: { type: Number, default: 0 },
        },
      ],
      default: [],
    },

    /** Who was already in the call when the BDA first joined */
    participantsAtJoin: {
      type: [
        {
          _id: false,
          displayName: { type: String, default: null },
          kind: { type: String, default: null }, // signedin | anonymous | phone
        },
      ],
      default: [],
    },

    /** Google's participant type for the BDA: 'signedin' | 'anonymous' | 'phone' (dial-in). */
    googleParticipantKind: {
      type: String,
      default: null,
    },

    /** pc | mobile | phone_dial_in | unknown (Utils/JoinDevice.js). Display only, never decides a verdict. */
    joinDevice: {
      type: String,
      enum: ['pc', 'mobile', 'phone_dial_in', 'unknown', null],
      default: null,
    },
    joinDeviceReason: {
      type: String,
      default: null,
    },

    /** Last successful Meet API sync for this row */
    meetApiSyncedAt: {
      type: Date,
      default: null,
    },

    /** Set once the conference ended and final numbers were written */
    meetApiFinalizedAt: {
      type: Date,
      default: null,
    },

    // Discord de-duplication for the Google-verified posts (see MeetAttendanceScheduler.processBooking):
    // the recap and its duration (so a rejoin that moves the total sends one update), and the verified-absent post.
    verifiedRecapSentAt: { type: Date, default: null },
    verifiedRecapDurationMs: { type: Number, default: null },
    verifiedAbsentNotifiedAt: { type: Date, default: null },
    // True from the moment an absent verdict is written until its Discord alert is actually delivered. If Discord was
    // down at start + 90 s the verdict job retries the alert, instead of the verdict existing with nobody told.
    verdictAlertPending: { type: Boolean, default: false },

    // ---- Server-decided attendance (plan sections 2.2 and 5.2) ----

    /** Every present signal, append-only. One row per kind (repeats are idempotent). */
    signals: {
      type: [
        {
          _id: false,
          kind: {
            type: String,
            enum: ["button_meet", "button_crm", "extension_join", "google_meet"],
          },
          /** Server-corrected time the BDA did the thing */
          eventAt: { type: Date },
          /** When the server got it */
          receivedAt: { type: Date },
        },
      ],
      default: [],
    },

    /** Earliest eventAt of any signal that counted toward the window */
    markedPresentAt: { type: Date, default: null },

    verdict: { type: String, enum: ["present", "absent", null], default: null },
    verdictAt: { type: Date, default: null },
    /** Which signal won; null when absent */
    verdictSignal: { type: String, default: null },
    // Why the verdict is what it is: 'present', 'no_signal' (nothing in time) or 'left_early' (in time, but out of
    // the call before the minimum stay after the start, Utils/AttendanceStay.js). verdictStayMs is the time in the
    // call after the start that the verdict saw, null when no record showed it.
    verdictReason: { type: String, enum: ['present', 'no_signal', 'left_early', null], default: null },
    verdictStayMs: { type: Number, default: null },
    /** Set when late evidence flips an absent verdict to present */
    verdictCorrectedAt: { type: Date, default: null },

    /** Button-only present with no join seen by start + 3 h (admin review list) */
    integrityFlag: {
      type: String,
      enum: ["marked_never_joined", null],
      default: null,
    },
    /** Admin closed or converted the integrity flag (never deleted) */
    integrityResolved: {
      at: { type: Date, default: null },
      by: { type: String, default: null },
      action: { type: String, default: null }, // dismissed | converted
      reason: { type: String, default: null },
    },

    /** Pre-meeting "extension offline" Discord warning dedupe */
    heartbeatWarnedAt: { type: Date, default: null },

    /**
     * How the Meet participant was matched to this BDA. Written by the identity
     * code in MeetAttendanceScheduler. Only 'stable_id' may decide a verdict.
     */
    matchedBy: {
      type: String,
      enum: ["stable_id", "name", null],
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// One record per BDA per meeting
BdaAttendanceSchema.index({ bookingId: 1, bdaEmail: 1 }, { unique: true });
BdaAttendanceSchema.index({ bdaEmail: 1, meetingScheduledStart: -1 });
BdaAttendanceSchema.index({ status: 1, meetingScheduledStart: -1 });
BdaAttendanceSchema.index({ verdict: 1, meetingScheduledStart: -1 });

export const BdaAttendanceModel = mongoose.model(
  "BdaAttendance",
  BdaAttendanceSchema
);
