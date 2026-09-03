export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      accounts: {
        Row: {
          admin: boolean
          id: string
          user: string | null
        }
        Insert: {
          admin?: boolean
          id?: string
          user?: string | null
        }
        Update: {
          admin?: boolean
          id?: string
          user?: string | null
        }
        Relationships: []
      }
      dpe: {
        Row: {
          created_at: string
          dpeData: Json | null
          id: string
          id_project: string | null
          iziResponse: Json | null
          sessionId: string | null
        }
        Insert: {
          created_at?: string
          dpeData?: Json | null
          id?: string
          id_project?: string | null
          iziResponse?: Json | null
          sessionId?: string | null
        }
        Update: {
          created_at?: string
          dpeData?: Json | null
          id?: string
          id_project?: string | null
          iziResponse?: Json | null
          sessionId?: string | null
        }
        Relationships: []
      }
      energy: {
        Row: {
          created_at: string
          id: string
          id_project: string | null
          izi_response: Json | null
        }
        Insert: {
          created_at?: string
          id: string
          id_project?: string | null
          izi_response?: Json | null
        }
        Update: {
          created_at?: string
          id?: string
          id_project?: string | null
          izi_response?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "energy_id_project_fkey"
            columns: ["id_project"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      energy_choices: {
        Row: {
          choice: Json | null
          created_at: string
          id: string
          id_project: string | null
          strategy: string | null
        }
        Insert: {
          choice?: Json | null
          created_at?: string
          id?: string
          id_project?: string | null
          strategy?: string | null
        }
        Update: {
          choice?: Json | null
          created_at?: string
          id?: string
          id_project?: string | null
          strategy?: string | null
        }
        Relationships: []
      }
      exports: {
        Row: {
          created_at: string
          id: string
          type: string | null
          url: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          type?: string | null
          url?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          type?: string | null
          url?: string | null
        }
        Relationships: []
      }
      projects: {
        Row: {
          address: string | null
          authorName: string | null
          contract_type: string | null
          created_at: string
          created_by: string | null
          description: string | null
          features: Json | null
          firstName: string | null
          id: string
          id_bouquet: string | null
          id_design: number | null
          imageFullPath: string | null
          lastName: string | null
          state: string | null
        }
        Insert: {
          address?: string | null
          authorName?: string | null
          contract_type?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          features?: Json | null
          firstName?: string | null
          id?: string
          id_bouquet?: string | null
          id_design?: number | null
          imageFullPath?: string | null
          lastName?: string | null
          state?: string | null
        }
        Update: {
          address?: string | null
          authorName?: string | null
          contract_type?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          features?: Json | null
          firstName?: string | null
          id?: string
          id_bouquet?: string | null
          id_design?: number | null
          imageFullPath?: string | null
          lastName?: string | null
          state?: string | null
        }
        Relationships: []
      }
      scans: {
        Row: {
          author: string | null
          created_at: string
          description: string | null
          id: number
          project_id: string | null
          serialized: Json | null
          usdz_path: string | null
        }
        Insert: {
          author?: string | null
          created_at?: string
          description?: string | null
          id?: string
          project_id?: string | null
          serialized?: Json | null
          usdz_path?: string | null
        }
        Update: {
          author?: string | null
          created_at?: string
          description?: string | null
          id?: string
          project_id?: string | null
          serialized?: Json | null
          usdz_path?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "scans_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DefaultSchema = Database[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof Database },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof Database
  }
    ? keyof (Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        Database[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof Database }
  ? (Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      Database[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof Database },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof Database
  }
    ? keyof Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof Database }
  ? Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof Database },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof Database
  }
    ? keyof Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof Database }
  ? Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof Database },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof Database
  }
    ? keyof Database[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof Database }
  ? Database[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof Database },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof Database
  }
    ? keyof Database[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends { schema: keyof Database }
  ? Database[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
