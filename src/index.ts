import express from "express";
import router from "./routes";
import cors from "cors";


const app = express();
// Enable CORS
app.use(cors());

// Middleware to parse JSON bodies
app.use(express.json({limit: '50mb'}));

// Handle OPTIONS requests for preflight checks
app.options("*", cors());

app.use("/api", router);

const PORT = process.env.PORT || 6300; // Use the PORT provided by Render, default to 6300 if not available

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});