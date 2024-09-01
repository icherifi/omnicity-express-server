import express from "express";
import userRouter from "./routes/scan";
import { createClient } from "@supabase/supabase-js";
import { Database } from "./types/database.types";

const app = express();

// Middleware to parse JSON bodies
app.use(express.json());

app.use("/api", userRouter);

const PORT = process.env.PORT || 3000; // Use the PORT provided by Render, default to 3000 if not available

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});