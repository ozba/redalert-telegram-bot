import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { logger } from "./logger.js";

interface TrackerData {
  uniqueUsers: number[];
  totalMessages: number;
  firstSeen: Record<number, string>; // userId -> ISO timestamp
}

const DATA_DIR = process.env.TRACKER_DATA_DIR || "/data";
const DATA_FILE = `${DATA_DIR}/stats.json`;

function loadData(): TrackerData {
  try {
    if (!existsSync(DATA_FILE)) {
      return { uniqueUsers: [], totalMessages: 0, firstSeen: {} };
    }
    return JSON.parse(readFileSync(DATA_FILE, "utf-8"));
  } catch {
    return { uniqueUsers: [], totalMessages: 0, firstSeen: {} };
  }
}

function saveData(data: TrackerData): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    logger.warn({ err }, "Failed to save tracker data");
  }
}

export class UserTracker {
  private data: TrackerData;

  constructor() {
    this.data = loadData();
    logger.info({ uniqueUsers: this.data.uniqueUsers.length, totalMessages: this.data.totalMessages }, "User tracker loaded");
  }

  track(userId: number): void {
    this.data.totalMessages++;
    if (!this.data.uniqueUsers.includes(userId)) {
      this.data.uniqueUsers.push(userId);
      this.data.firstSeen[userId] = new Date().toISOString();
      logger.info({ userId, totalUsers: this.data.uniqueUsers.length }, "New user");
    }
    saveData(this.data);
  }

  get uniqueUserCount(): number {
    return this.data.uniqueUsers.length;
  }

  get totalMessageCount(): number {
    return this.data.totalMessages;
  }
}
