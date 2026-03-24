import { sqliteTable, text, real, integer } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash"),
  googleId: text("google_id").unique(),
  avatarUrl: text("avatar_url"),
  role: text("role").notNull().default("viewer"), // admin, editor, viewer
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const serviceIdentities = sqliteTable("service_identities", {
  id: text("id").primaryKey(),
  cfAccessSubject: text("cf_access_subject").notNull().unique(),
  commonName: text("common_name").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull(),
});

export const trips = sqliteTable("trips", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  destination: text("destination"),
  startDate: text("start_date"),
  endDate: text("end_date"),
  description: text("description"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const participants = sqliteTable("participants", {
  id: text("id").primaryKey(),
  tripId: text("trip_id")
    .notNull()
    .references(() => trips.id, { onDelete: "cascade" }),
  userId: text("user_id"),
  email: text("email"),
  name: text("name").notNull(),
  role: text("role").notNull(), // Owner, Editor, Viewer
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const expenses = sqliteTable("expenses", {
  id: text("id").primaryKey(),
  tripId: text("trip_id")
    .notNull()
    .references(() => trips.id, { onDelete: "cascade" }),
  description: text("description").notNull(),
  amount: real("amount").notNull(),
  currency: text("currency").notNull(),
  category: text("category").notNull(),
  payerId: text("payer_id").references(() => participants.id),
  splitType: text("split_type").notNull(), // EQUAL, EXACT, PERCENTAGE
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const documents = sqliteTable("documents", {
  id: text("id").primaryKey(),
  tripId: text("trip_id")
    .notNull()
    .references(() => trips.id, { onDelete: "cascade" }),
  reservationId: text("reservation_id"),
  fileUrl: text("file_url").notNull(),
  documentType: text("document_type").notNull(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const invites = sqliteTable("invites", {
  id: text("id").primaryKey(),
  tripId: text("trip_id")
    .notNull()
    .references(() => trips.id, { onDelete: "cascade" }),
  email: text("email"),
  name: text("name"),
  role: text("role").notNull().default("Viewer"), // Owner, Editor, Viewer
  token: text("token").notNull().unique(),
  status: text("status").notNull().default("pending"), // pending, accepted, expired
  participantId: text("participant_id").references(() => participants.id, { onDelete: "set null" }),
  invitedBy: text("invited_by")
    .notNull()
    .references(() => users.id),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
});

export const itineraries = sqliteTable("itineraries", {
  id: text("id").primaryKey(),
  tripId: text("trip_id")
    .notNull()
    .references(() => trips.id, { onDelete: "cascade" }),
  type: text("type").notNull(), // Flight, Lodging, Rail, Car, Restaurant, Transport, Activity
  status: text("status").notNull(), // Confirmed, Pending, Cancelled
  schemaVersion: integer("schema_version").notNull().default(1),
  content: text("content", { mode: "json" }).notNull(), // Type-specific JSON document
  // Common reservation fields stored as columns for queryability
  confirmationNumber: text("confirmation_number"),
  totalCost: real("total_cost"),
  currency: text("currency"),
  notes: text("notes"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
