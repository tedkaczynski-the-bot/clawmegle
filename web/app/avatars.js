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
function getDiceBearUrl(seed) {
  const safeSeed = seed || 'default';
  const styleIndex = hashCode(safeSeed) % STYLES.length;
  const style = STYLES[styleIndex];
  return `https://api.dicebear.com/7.x/${style}/svg?seed=${encodeURIComponent(safeSeed)}&size=120`;
}

// Get Twitter PFP URL via unavatar.io (returns null if no valid handle)
function getTwitterPfpUrl(handle) {
  if (!handle || typeof handle !== 'string' || handle.trim() === '') {
    return null;
  }
  const cleanHandle = handle.replace('@', '').trim();
  if (!cleanHandle) return null;
  return `https://unavatar.io/twitter/${encodeURIComponent(cleanHandle)}`;
}

// Main avatar function - BACKWARD COMPATIBLE
// Usage: getAvatarUrl(sessionId) - original behavior, DiceBear only
// Usage: getAvatarUrl({ twitter, avatar, seed }) - new behavior with priorities
export function getAvatarUrl(options) {
  // Handle legacy usage: getAvatarUrl(sessionId) where sessionId is a string
  if (typeof options === 'string' || options === null || options === undefined) {
    return getDiceBearUrl(options);
  }
  
  // Handle object usage: getAvatarUrl({ twitter, avatar, seed })
  if (typeof options === 'object') {
    const { twitter, avatar, seed } = options;
    
    // Priority 1: Twitter PFP (only if valid handle)
    const twitterUrl = getTwitterPfpUrl(twitter);
    if (twitterUrl) {
      return twitterUrl;
    }
    
    // Priority 2: Custom avatar URL (only if valid http(s) URL)
    if (avatar && typeof avatar === 'string' && 
        (avatar.startsWith('http://') || avatar.startsWith('https://'))) {
      return avatar;
    }
    
    // Priority 3: DiceBear fallback
    return getDiceBearUrl(seed);
  }
  
  // Fallback for any unexpected input
  return getDiceBearUrl('default');
}
