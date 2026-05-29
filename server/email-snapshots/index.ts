export {
  initEmailSnapshotsTable,
  saveEmailSnapshot,
  getEmailSnapshot,
  getSnapshotsForContact,
  hasSnapshotForTemplate,
} from "./db";

export type {
  EmailSnapshot,
  CreateEmailSnapshotParams,
} from "./types";
