// Curated avatar GIFs - fun animated faces/reactions
// Using Giphy/Tenor URLs that work well as small avatars

export const AVATAR_GIFS = [
  // Animated cartoon faces/reactions
  "https://media.giphy.com/media/l0MYC0LajbaPoEADu/giphy.gif",
  "https://media.giphy.com/media/3oKIPnAiaMCws8nOsE/giphy.gif",
  "https://media.giphy.com/media/xT9IgG50Fb7Mi0prBC/giphy.gif",
  "https://media.giphy.com/media/l4Jz3a8jO92crUlWM/giphy.gif",
  "https://media.giphy.com/media/QMHoU66sBXqqLqYvGO/giphy.gif",
  "https://media.giphy.com/media/3o7buirYcmV5nSwIRW/giphy.gif",
  "https://media.giphy.com/media/l0HlvtIPzPdt2usKs/giphy.gif",
  "https://media.giphy.com/media/xUPGcguWZHRC2HyBRS/giphy.gif",
  "https://media.giphy.com/media/H4DjXQXamtTiIuCcRU/giphy.gif",
  "https://media.giphy.com/media/3o7TKTDn976rzVgky4/giphy.gif",
  "https://media.giphy.com/media/l4FGGafcOHmrlQxG0/giphy.gif",
  "https://media.giphy.com/media/xT1XGU1AHz9Fe8tmp2/giphy.gif",
  "https://media.giphy.com/media/3o6Zt6ML6BklcajjsA/giphy.gif",
  "https://media.giphy.com/media/l0MYt5jPR6QX5pnqM/giphy.gif",
  "https://media.giphy.com/media/26ufdipQqU2lhNA4g/giphy.gif",
  "https://media.giphy.com/media/3oKIPsx2VAYAgEHC12/giphy.gif",
  "https://media.giphy.com/media/l46CyJmS9KUbokzsI/giphy.gif",
  "https://media.giphy.com/media/xT5LMHxhOfscxPfIfm/giphy.gif",
  "https://media.giphy.com/media/3og0INyCmHlNylks9O/giphy.gif",
  "https://media.giphy.com/media/l0Iy69RBixk0AbKOQ/giphy.gif",
  "https://media.giphy.com/media/26FLgGTPUDH6UGAbm/giphy.gif",
  "https://media.giphy.com/media/3o7btPCcdNniyf0ArS/giphy.gif",
  "https://media.giphy.com/media/3oz8xIsloV7zOmt81G/giphy.gif",
  "https://media.giphy.com/media/xT9DPBMumj2Q0hlI3K/giphy.gif",
  "https://media.giphy.com/media/26uf2JHNV0Tq3ugkE/giphy.gif",
  "https://media.giphy.com/media/3o7buceGnUgftqLC5q/giphy.gif",
  "https://media.giphy.com/media/l3q2K5jinAlChoCLS/giphy.gif",
  "https://media.giphy.com/media/3o7TKMt1VVNkHV2PaE/giphy.gif",
  "https://media.giphy.com/media/xT0xeJpnrWC4XWblEk/giphy.gif",
  "https://media.giphy.com/media/l378c04F2fjeZ7vH2/giphy.gif",
  "https://media.giphy.com/media/xT9IgsAZTS0OKXWIQo/giphy.gif",
  "https://media.giphy.com/media/3oKIPbNb1vWdftiVLq/giphy.gif",
  "https://media.giphy.com/media/26BRDvCpnNnuqg5mo/giphy.gif",
  "https://media.giphy.com/media/l1J9EdzfOSgfyueLm/giphy.gif",
  "https://media.giphy.com/media/xT5LMUnO4g3yiRNuNy/giphy.gif",
  "https://media.giphy.com/media/3og0IExSrnfW2kUaaI/giphy.gif",
  "https://media.giphy.com/media/26tknCqiJrBQG6bxC/giphy.gif",
  "https://media.giphy.com/media/l0HlNQ03J5JxX6lva/giphy.gif",
  "https://media.giphy.com/media/xT9DPJVjlYHwWsZRxm/giphy.gif",
  "https://media.giphy.com/media/3o6fJ1BM7R2EBRDnxK/giphy.gif",
  "https://media.giphy.com/media/xT0GqssRweIhlz209i/giphy.gif",
  "https://media.giphy.com/media/l378bu6ZYmzS6nBGU/giphy.gif",
  "https://media.giphy.com/media/3oKIPjzfv0sI2p7fDW/giphy.gif",
  "https://media.giphy.com/media/26BGIqWh2R1fi6JDa/giphy.gif",
  "https://media.giphy.com/media/xT1XGzAnABSXy8DPCU/giphy.gif",
  "https://media.giphy.com/media/xT9IgsNmTPjlFGWnLi/giphy.gif",
  "https://media.giphy.com/media/l4FGF2e5i5kWBxIru/giphy.gif",
  "https://media.giphy.com/media/3o7TKnO6Wve6502iJ2/giphy.gif",
  "https://media.giphy.com/media/xT5LMWNFkMSnnVP4Ru/giphy.gif",
  "https://media.giphy.com/media/l0IycQmt79g9XzOWQ/giphy.gif",
];

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

// Get avatar URL for a session ID
export function getAvatarUrl(sessionId) {
  if (!sessionId) return AVATAR_GIFS[0];
  const index = hashCode(sessionId) % AVATAR_GIFS.length;
  return AVATAR_GIFS[index];
}
