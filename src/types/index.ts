export type Role =
  | 'director'
  | 'associate_director'
  | 'assistant_director'
  | 'actor'
  | 'costume'
  | 'art';

export const ALL_ROLES: Role[] = [
  'director',
  'associate_director',
  'assistant_director',
  'actor',
  'costume',
  'art',
];

/** "Admin" / production-direction roles — allowed to run workflows & writes. */
export const DIRECTION_ROLES: Role[] = [
  'director',
  'associate_director',
  'assistant_director',
];

export type ShootDayStatus = 'draft' | 'published' | 'completed';
export type SceneStatus = 'pending' | 'ready' | 'shooting' | 'completed';
export type CostumeStatus = 'pending' | 'ready' | 'on_actor' | 'laundry' | 'repair';
export type PropStatus = 'to_purchase' | 'purchased' | 'packed' | 'on_set' | 'returned';
export const PROP_STAGE_ORDER: PropStatus[] = [
  'to_purchase',
  'purchased',
  'packed',
  'on_set',
  'returned',
];
export type WalkieType =
  | 'scene_ready'
  | 'artist_ready'
  | 'camera_ready'
  | 'lunch_break'
  | 'pack_up'
  | 'custom';
export type ProjectStatus = 'prep' | 'shooting' | 'wrapped';

interface AppwriteDoc {
  $id: string;
  $createdAt: string;
  $updatedAt: string;
}

export interface UserProfile extends AppwriteDoc {
  authUserId?: string;
  name: string;
  phone: string;
  role: Role;
  projectId: string;
  avatarFileId?: string;
  fcmToken?: string;
  active: boolean;
}

export interface Project extends AppwriteDoc {
  title: string;
  productionHouse?: string;
  startDate?: string;
  endDate?: string;
  status: ProjectStatus;
  createdBy: string;
  scriptFileId?: string;
  scriptVersion?: number;
}

export interface ShootDay extends AppwriteDoc {
  projectId: string;
  date: string;
  dayNumber: number;
  generalCallTime: string;
  locationName: string;
  locationMapUrl?: string;
  status: ShootDayStatus;
  generalNotes?: string;
  callSheetFileId?: string;
}

export interface Scene extends AppwriteDoc {
  projectId: string;
  shootDayId: string;
  sceneNumber: string;
  intExt: 'INT' | 'EXT';
  dayNight: 'DAY' | 'NIGHT';
  locationName: string;
  synopsis?: string;
  actorIds: string[];
  scriptPageStart: number;
  scriptPageEnd: number;
  status: SceneStatus;
  order: number;
}

export interface ActorCall extends AppwriteDoc {
  projectId: string;
  shootDayId: string;
  actorId: string;
  pickupTime?: string;
  callTime?: string;
  makeupTime?: string;
  hairTime?: string;
  onSetTime?: string;
  lunchTime?: string;
  sceneIds: string[];
}

export interface Costume extends AppwriteDoc {
  projectId: string;
  actorId: string;
  sceneIds: string[];
  costumeNumber: string;
  lookDescription?: string;
  accessories: string[];
  status: CostumeStatus;
  tomorrowReady: boolean;
}

export interface Prop extends AppwriteDoc {
  projectId: string;
  sceneIds: string[];
  name: string;
  quantity: number;
  notes?: string;
  status: PropStatus;
  neededDate?: string;
}

export interface WalkieEvent extends AppwriteDoc {
  projectId: string;
  shootDayId: string;
  type: WalkieType;
  message?: string;
  senderId: string;
  senderRole: Role;
  senderName: string;
}

export interface AttendanceDoc extends AppwriteDoc {
  projectId: string;
  shootDayId: string;
  userId: string;
  checkInTime: string;
  method: 'qr' | 'manual';
}

export interface PrintRequest extends AppwriteDoc {
  projectId: string;
  shootDayId: string;
  actorId: string;
  actorName: string;
  status: 'requested' | 'done';
}

export interface NotificationDoc extends AppwriteDoc {
  projectId: string;
  targetRoles: string[];
  targetUserIds: string[];
  title: string;
  body: string;
  type: string;
  deepLink: string;
  readBy: string[];
}

export interface DprSnapshot extends AppwriteDoc {
  projectId: string;
  shootDayId: string;
  date: string;
  scenesPlanned: number;
  scenesCompleted: number;
}

/** Authenticated request context attached by auth middleware. */
export interface RequestUser {
  /** users collection document $id (used as actorId/userId across collections) */
  userId: string;
  authUserId: string;
  role: Role;
  projectId: string;
  name: string;
  phone: string;
}
