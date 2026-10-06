// Shared list of civilizations (used by the browser and by server.js).
(function (root) {
  const ALL_CIVILIZATIONS = [
    "American", "Arabian", "Assyrian", "Austrian", "Aztec",
    "Babylonian", "Brazilian", "Byzantine", "Carthaginian", "Celtic",
    "Chinese", "Danish", "Dutch", "Egyptian", "English",
    "Ethiopian", "French", "German", "Greek", "Hunnic",
    "Incan", "Indian", "Indonesian", "Iroquois", "Japanese",
    "Korean", "Mayan", "Mongolian", "Moroccan", "Ottoman",
    "Persian", "Polish", "Polynesian", "Portuguese", "Roman",
    "Russian", "Shoshone", "Siamese", "Songhai", "Spanish",
    "Swedish", "Venetian", "Zulu"
  ];
  if (typeof module !== "undefined" && module.exports) module.exports = ALL_CIVILIZATIONS;
  else root.ALL_CIVILIZATIONS = ALL_CIVILIZATIONS;
})(typeof window !== "undefined" ? window : globalThis);
