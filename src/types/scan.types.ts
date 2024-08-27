import { Json } from './database.types'; 

// Define the Scan interface
export interface Scan {
    author: string | null;
    created_at: string;
    description: string | null;
    id: number;
    serialized: Json | null;
}