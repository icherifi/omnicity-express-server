import express from "express";
import userRouter from "./routes/scan";
import { createClient } from "@supabase/supabase-js";
import { Database } from "./types/database.types";

const app = express();

// Middleware to parse JSON bodies
app.use(express.json());

const PORT = 3000;

app.use("/api", userRouter);

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
