import { PostgresStorage } from "./storage/postgres";
import { PostgresTraceStorage } from "./storage/postgresTrace";
import type { S3Storage } from "./storage/s3";
import { Room } from "./room";

interface RoomManagerOptions {
  connectionString: string;
  s3Storage?: S3Storage;
  maxRooms?: number;
}

interface RoomEntry {
  room: Room;
  lastAccessed: number;
  storage: PostgresStorage;
}

export class RoomManager {
  private rooms = new Map<string, RoomEntry>();
  private connectionString: string;
  private s3Storage: S3Storage | undefined;
  private traceStorage: PostgresTraceStorage;
  private maxRooms: number;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(options: RoomManagerOptions) {
    this.connectionString = options.connectionString;
    this.s3Storage = options.s3Storage;
    this.maxRooms = options.maxRooms ?? 100;
    
    this.traceStorage = new PostgresTraceStorage({
      connectionString: options.connectionString,
    });

    this.startCleanupInterval();
  }

  async initialize(): Promise<void> {
    await this.traceStorage.initialize();
  }

  async getOrCreateRoom(roomId: string): Promise<Room> {
    const existing = this.rooms.get(roomId);
    
    if (existing) {
      existing.lastAccessed = Date.now();
      return existing.room;
    }

    if (this.rooms.size >= this.maxRooms) {
      this.evictOldestRoom();
    }

    const storage = new PostgresStorage({
      connectionString: this.connectionString,
      roomId,
    });

    await storage.initialize();

    const room = new Room({
      roomId,
      storage,
      traceStorage: this.traceStorage,
      s3Storage: this.s3Storage,
    });

    await room.initialize();

    const entry: RoomEntry = {
      room,
      lastAccessed: Date.now(),
      storage,
    };

    this.rooms.set(roomId, entry);

    return room;
  }

  async closeRoom(roomId: string): Promise<void> {
    const entry = this.rooms.get(roomId);
    
    if (!entry) return;

    await entry.storage.close();
    this.rooms.delete(roomId);
  }

  async closeAll(): Promise<void> {
    for (const [roomId] of this.rooms) {
      await this.closeRoom(roomId);
    }
    
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    await this.traceStorage.close();
  }

  private evictOldestRoom(): void {
    let oldestRoomId: string | null = null;
    let oldestTime = Infinity;

    for (const [roomId, entry] of this.rooms) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestRoomId = roomId;
      }
    }

    if (oldestRoomId) {
      void this.closeRoom(oldestRoomId);
    }
  }

  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      const maxIdleTime = 30 * 60 * 1000; // 30 minutes

      for (const [roomId, entry] of this.rooms) {
        if (now - entry.lastAccessed > maxIdleTime) {
          void this.closeRoom(roomId);
        }
      }
    }, 5 * 60 * 1000); // Check every 5 minutes
  }
}
