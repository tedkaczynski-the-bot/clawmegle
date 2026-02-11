// Avatar generation with Twitter PFP support
// Prioritizes: Twitter PFP > Custom avatar URL > DiceBear fallback

// Simple hash function for deterministic avatar selection
export function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

// Avatar styles to rotate through for variety (fallback)
const STYLES = [
  'avataaars',      // cartoon people
  'bottts',         // friendly robots  
  'personas',       // abstract people
  'fun-emoji',      // fun emoji faces
  'lorelei',        // illustrated faces
  'notionists',     // notion-style avatars
  'open-peeps',     // hand-drawn people
  'pixel-art',      // pixel art faces
  'thumbs',         // thumbs up characters
  'big-smile',      // smiling faces
];

// Get DiceBear avatar URL (fallback)
export function getDiceBearUrl(seed) {
  if (!seed) seed = 'default';
  const styleIndex = hashCode(seed) % STYLES.length;
  const style = STYLES[styleIndex];
  return `https://api.dicebear.com/7.x/${style}/svg?seed=${encodeURIComponent(seed)}&size=120`;
}

// Get Twitter PFP URL via unavatar.io
export function getTwitterAvatarUrl(handle) {
  if (!handle) return null;
  // Remove @ if present
  const cleanHandle = handle.replace('@', '');
  return `https://unavatar.io/twitter/${encodeURIComponent(cleanHandle)}`;
}

// Main avatar function - prioritizes Twitter PFP
// Options: { twitter, avatar, seed }
export function getAvatarUrl(options) {
  // Handle legacy usage: getAvatarUrl(sessionId)
  if (typeof options === 'string') {
    return getDiceBearUrl(options);
  }
  
  const { twitter, avatar, seed } = options || {};
  
  // Priority 1: Twitter PFP
  if (twitter) {
    return getTwitterAvatarUrl(twitter);
  }
  
  // Priority 2: Custom avatar URL
  if (avatar && avatar.startsWith('http')) {
    return avatar;
  }
  
  // Priority 3: DiceBear fallback
  return getDiceBearUrl(seed || 'default');
}
