import { Json } from '../types/database.types';

// Define the Scan interface
export interface CreateScanDto {
  author?: string | null;
  created_at?: string;
  description?: string | null;
  id?: number;
  serialized?: Json | null;
}