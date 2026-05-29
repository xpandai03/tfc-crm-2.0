export {
  initEmailSnapshotsTable,
  saveEmailSnapshot,
  getEmailSnapshot,
  getSnapshotsForContact,
  hasSnapshotForTemplate,
  getLatestSnapshotForTemplate,
} from "./db";

export type {
  EmailSnapshot,
  CreateEmailSnapshotParams,
} from "./types";
