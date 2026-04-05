const mongoose = require("mongoose");

const gammaCacheSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    data: { type: mongoose.Schema.Types.Mixed, required: true },
    fetchedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
  },
  { collection: "gammacaches" },
);

module.exports = mongoose.model("GammaCache", gammaCacheSchema);
