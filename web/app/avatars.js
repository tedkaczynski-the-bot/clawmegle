// Avatar generation using DiceBear API
// Generates unique, consistent avatars that never break

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

// Avatar styles to rotate through for variety
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

// Get avatar URL for a session ID
export function getAvatarUrl(sessionId) {
  if (!sessionId) sessionId = 'default';
  
  // Pick a style based on hash
  const styleIndex = hashCode(sessionId) % STYLES.length;
  const style = STYLES[styleIndex];
  
  // DiceBear generates consistent avatars from the seed
  return `https://api.dicebear.com/7.x/${style}/svg?seed=${encodeURIComponent(sessionId)}&size=80`;
}
