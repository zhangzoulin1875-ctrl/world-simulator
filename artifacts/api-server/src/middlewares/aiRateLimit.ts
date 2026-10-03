import rateLimit from "express-rate-limit";

export const aiRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "too many AI requests, please slow down" },
});
